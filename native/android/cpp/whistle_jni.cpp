// JNI bridge to the Cactus "needle" engine, which runs Whistle (speech to text) for Editorr captions.
// The engine ships as libneedle.a + needle.h (fetched in CI by scripts/fetch-needle.py into third_party/needle).
// Whistle takes 16 kHz mono float samples, up to 30 s per call. The Java side cuts longer audio into windows.
#include <jni.h>
#include <android/log.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

extern "C" {
#include "needle.h"
}

#define TAG "EditorrWhistle"

static std::mutex g_lock;                 // the engine owns one process-global model and is not thread-safe
static std::vector<unsigned char> g_cact; // the engine may keep pointing into the archive, so it stays alive until the next load

static std::string last_error() {
    const char *e = needle_last_error();
    return e && *e ? std::string(e) : std::string("unknown error");
}

extern "C" {

// Loads a Whistle .cact (English Whistle, Shruti Hindi, Bangla ...). Returns null on success, else a readable error.
JNIEXPORT jstring JNICALL Java_com_tuik_editorr_agy_WhistleNative_nativeLoad(JNIEnv *env, jclass, jstring path) {
    const char *p = env->GetStringUTFChars(path, nullptr);
    FILE *f = p ? fopen(p, "rb") : nullptr;
    if (p) env->ReleaseStringUTFChars(path, p);
    if (!f) return env->NewStringUTF("Could not open the Whistle model file.");
    fseek(f, 0, SEEK_END);
    long bytes = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (bytes <= 0) { fclose(f); return env->NewStringUTF("The Whistle model file is empty."); }
    std::vector<unsigned char> buf((size_t) bytes);
    size_t got = fread(buf.data(), 1, buf.size(), f);
    fclose(f);
    if (got != buf.size()) return env->NewStringUTF("Could not read the Whistle model file.");

    std::lock_guard<std::mutex> lk(g_lock);
    int rc = needle_load(buf.data(), (uint64_t) buf.size());
    if (rc < 0) {
        std::string msg = "Whistle could not load the model: " + last_error();
        __android_log_print(ANDROID_LOG_ERROR, TAG, "%s", msg.c_str());
        return env->NewStringUTF(msg.c_str());
    }
    g_cact.swap(buf);   // keep the new archive alive; the old one is released here
    return nullptr;
}

// Transcribes one window (max 30 s, 16 kHz mono, -1..1). Returns the engine's JSON text, or null on failure (see nativeLastError).
JNIEXPORT jstring JNICALL Java_com_tuik_editorr_agy_WhistleNative_nativeTranscribe(JNIEnv *env, jclass, jfloatArray samples, jstring lang, jboolean words) {
    jsize n = env->GetArrayLength(samples);
    if (n <= 0) return env->NewStringUTF("{\"text\":\"\"}");
    std::vector<float> pcm((size_t) n);
    env->GetFloatArrayRegion(samples, 0, n, pcm.data());

    std::string language;
    if (lang) {
        const char *lg = env->GetStringUTFChars(lang, nullptr);
        if (lg) language = lg;
        if (lg) env->ReleaseStringUTFChars(lang, lg);
    }

    const int OUT = 256 * 1024;
    std::vector<char> out((size_t) OUT, 0);
    std::lock_guard<std::mutex> lk(g_lock);
    int rc = needle_transcribe(pcm.data(), (int) n, language.empty() ? nullptr : language.c_str(), nullptr,
                               words == JNI_TRUE ? 1 : 0, out.data(), OUT);
    if (rc < 0) {
        __android_log_print(ANDROID_LOG_ERROR, TAG, "needle_transcribe failed: %s", last_error().c_str());
        return nullptr;
    }
    out[(size_t) OUT - 1] = 0;
    return env->NewStringUTF(out.data());
}

JNIEXPORT jstring JNICALL Java_com_tuik_editorr_agy_WhistleNative_nativeLastError(JNIEnv *env, jclass) {
    std::lock_guard<std::mutex> lk(g_lock);
    return env->NewStringUTF(last_error().c_str());
}

}
