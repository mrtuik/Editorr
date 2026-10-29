// JNI bridge to whisper.cpp for Editorr. Audio comes from a raw 16 kHz mono 16-bit file written by the app.
#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <string>
#include <vector>

#include "whisper.h"

#define TAG "EditorrWhisper"

static std::atomic<bool> g_cancel(false);

struct Ctx {
    JNIEnv *env;
    jobject cb;
    jmethodID on;
    int last;
    struct whisper_context *wctx;
    long long total_ms;
};

static void report(Ctx *c, int p) {
    if (!c->cb || !c->on) return;
    if (p > 99) p = 99;
    if (p <= c->last) return;
    c->last = p;
    c->env->CallVoidMethod(c->cb, c->on, (jint) p);
}

// called after every new piece of text: smooth progress from the time the text has reached
static void on_new_segment(struct whisper_context *ctx, struct whisper_state *, int, void *user) {
    Ctx *c = static_cast<Ctx *>(user);
    int n = whisper_full_n_segments(ctx);
    if (n <= 0 || c->total_ms <= 0) return;
    long long t1 = (long long) whisper_full_get_segment_t1(ctx, n - 1) * 10;
    report(c, (int) (t1 * 100 / c->total_ms));
}

static void on_progress(struct whisper_context *, struct whisper_state *, int progress, void *user) {
    report(static_cast<Ctx *>(user), progress);
}

static bool should_abort(void *) { return g_cancel.load(); }

// Arabic / Urdu script is blocked when the chosen language is not Urdu/Arabic/Persian.
// Whisper (esp. Tiny/Base) sometimes writes Bangla/Hindi speech in Urdu letters even when the language is forced.
// Every Arabic-script letter is UTF-8 lead byte 0xD8-0xDB, which Bangla/Hindi/Latin text never contains.
static std::vector<char> g_block;
static void build_block(struct whisper_context *ctx) {
    int nv = whisper_n_vocab(ctx);
    g_block.assign((size_t) nv, 0);
    for (int i = 0; i < nv; i++) {
        const char *t = whisper_token_to_str(ctx, i);
        if (!t) continue;
        for (; *t; ++t) { unsigned char b = (unsigned char) *t; if (b >= 0xD8 && b <= 0xDB) { g_block[(size_t) i] = 1; break; } }
    }
}
static void block_arabic_script(struct whisper_context *, struct whisper_state *, const whisper_token_data *, int, float *logits, void *) {
    for (size_t i = 0; i < g_block.size(); i++) if (g_block[i]) logits[i] = -INFINITY;
}


static void json_escape(std::string &out, const char *s) {
    for (; *s; ++s) {
        unsigned char ch = (unsigned char) *s;
        switch (ch) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (ch < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", ch); out += b; }
                else out += (char) ch;
        }
    }
}

extern "C" {

JNIEXPORT jlong JNICALL Java_com_tuik_editorr_agy_WhisperNative_nativeInit(JNIEnv *env, jclass, jstring path) {
    const char *p = env->GetStringUTFChars(path, nullptr);
    struct whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    struct whisper_context *ctx = whisper_init_from_file_with_params(p, cp);
    env->ReleaseStringUTFChars(path, p);
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL Java_com_tuik_editorr_agy_WhisperNative_nativeFree(JNIEnv *, jclass, jlong h) {
    if (h) whisper_free(reinterpret_cast<struct whisper_context *>(h));
}

JNIEXPORT void JNICALL Java_com_tuik_editorr_agy_WhisperNative_nativeCancel(JNIEnv *, jclass) { g_cancel.store(true); }

// Returns a JSON array [{"t0":ms,"t1":ms,"text":"..."}], or null when it failed / was cancelled.
JNIEXPORT jstring JNICALL Java_com_tuik_editorr_agy_WhisperNative_nativeRun(JNIEnv *env, jclass, jlong h, jstring pcmPath,
                                                                         jstring lang, jboolean words, jint threads, jobject cb) {
    g_cancel.store(false);
    struct whisper_context *ctx = reinterpret_cast<struct whisper_context *>(h);
    if (!ctx) return nullptr;

    const char *pp = env->GetStringUTFChars(pcmPath, nullptr);
    FILE *f = fopen(pp, "rb");
    env->ReleaseStringUTFChars(pcmPath, pp);
    if (!f) return nullptr;
    fseek(f, 0, SEEK_END);
    long bytes = ftell(f);
    fseek(f, 0, SEEK_SET);
    size_t n = (size_t) (bytes / 2);
    std::vector<int16_t> raw(n);
    size_t got = n ? fread(raw.data(), 2, n, f) : 0;
    fclose(f);
    std::vector<float> pcm(got);
    for (size_t i = 0; i < got; i++) pcm[i] = raw[i] / 32768.0f;
    raw.clear();
    raw.shrink_to_fit();
    if (pcm.empty()) return env->NewStringUTF("[]");

    const char *lg = env->GetStringUTFChars(lang, nullptr);
    std::string language = lg ? lg : "";
    env->ReleaseStringUTFChars(lang, lg);

    struct whisper_full_params wp = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wp.print_progress = false;
    wp.print_realtime = false;
    wp.print_timestamps = false;
    wp.print_special = false;
    wp.translate = false;
    wp.language = language.empty() ? "auto" : language.c_str();
    wp.detect_language = false;
    if (!language.empty() && language != "auto" && language != "ur" && language != "ar" && language != "fa") {
        build_block(ctx);
        wp.logits_filter_callback = block_arabic_script;
        wp.logits_filter_callback_user_data = nullptr;
    }
    wp.n_threads = threads > 0 ? threads : 4;
    wp.no_context = true;
    wp.suppress_blank = true;
    wp.token_timestamps = words == JNI_TRUE;
    wp.split_on_word = words == JNI_TRUE;
    wp.max_len = words == JNI_TRUE ? 1 : 0;   // one word per segment = word timing
    wp.abort_callback = should_abort;
    wp.abort_callback_user_data = nullptr;

    // Speed: no re-decoding at higher temperatures (that can multiply the time by 5 on hard audio), no 5-way greedy search.
    wp.temperature_inc = 0.0f;
    wp.greedy.best_of = 1;

    Ctx c{env, cb, nullptr, -1, ctx, (long long) pcm.size() * 1000LL / 16000LL};
    if (cb) {
        jclass k = env->GetObjectClass(cb);
        c.on = env->GetMethodID(k, "on", "(I)V");
        wp.progress_callback = on_progress;
        wp.progress_callback_user_data = &c;
        wp.new_segment_callback = on_new_segment;
        wp.new_segment_callback_user_data = &c;
        env->CallVoidMethod(cb, c.on, (jint) 0);
    }

    int rc = whisper_full(ctx, wp, pcm.data(), (int) pcm.size());
    if (rc != 0 || g_cancel.load()) return nullptr;

    std::string out = "[";
    int segs = whisper_full_n_segments(ctx);
    bool first = true;
    for (int i = 0; i < segs; i++) {
        const char *text = whisper_full_get_segment_text(ctx, i);
        if (!text) continue;
        if (!first) out += ',';
        first = false;
        char head[96];
        snprintf(head, sizeof head, "{\"t0\":%lld,\"t1\":%lld,\"text\":\"",
                 (long long) whisper_full_get_segment_t0(ctx, i) * 10, (long long) whisper_full_get_segment_t1(ctx, i) * 10);
        out += head;
        json_escape(out, text);
        out += "\"}";
    }
    out += "]";
    return env->NewStringUTF(out.c_str());
}

}
