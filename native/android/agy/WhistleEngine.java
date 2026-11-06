package com.tuik.editorr.agy;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Whistle (Cactus needle engine) on the phone: model download, audio hand-over in chunks, and the run.
 * Runs outside the WebView, so it cannot crash it. One small model per language:
 * english = Cactus-Compute/whistle, hindi = udgamlabs/Shruti, bengali = ehzawad/whistle-bn-BD-2bit (gated, needs a Hugging Face token).
 */
public final class WhistleEngine {
    public interface Percent { void on(int percent); }

    private static final int SR = 16000;
    private static final int MAX_WINDOW = SR * 28;      // Whistle takes up to 30 s per call
    private static final int SEARCH_BACK = SR * 4;      // look for a quiet spot in the last 4 s of a window to cut at
    private static final String HF = "https://huggingface.co/";

    private final Context context;
    private final File dir;
    private final Object runLock = new Object();
    private volatile boolean cancelled;
    private File pcmFile;
    private int pcmSeq = 0;
    private FileOutputStream pcmOut;
    private String loadedLang = "";

    public WhistleEngine(Context context) {
        this.context = context.getApplicationContext();
        dir = new File(this.context.getFilesDir(), "whistle");
        pcmFile = new File(this.context.getCacheDir(), "whistle-pcm-0.raw");
    }

    public static boolean available() { return WhistleNative.AVAILABLE; }

    private static String lang(String l) { return "bengali".equals(l) || "hindi".equals(l) ? l : "english"; }

    private static String fileName(String l) {
        switch (lang(l)) {
            case "bengali": return "whistle-bn-BD-2bit.cact";
            case "hindi": return "shruti.cact";
            default: return "whistle.cact";
        }
    }

    private static String url(String l) {
        switch (lang(l)) {
            case "bengali": return HF + "ehzawad/whistle-bn-BD-2bit/resolve/main/whistle-bn-BD-2bit.cact";
            case "hindi": return HF + "udgamlabs/Shruti/resolve/main/shruti.cact";
            default: return HF + "Cactus-Compute/whistle/resolve/main/whistle.cact";
        }
    }

    /** Language hint for the engine. Shruti detects Hindi/Hinglish by itself. */
    private static String engineLang(String l) {
        switch (lang(l)) {
            case "bengali": return "bn";
            case "english": return "en";
            default: return "";
        }
    }

    /** Real files are 16.9 / 29.5 / 30.5 MB. Anything far smaller is a damaged or error download. */
    private static long minBytes(String l) { return "english".equals(lang(l)) ? 12_000_000L : 20_000_000L; }

    private File modelFile(String l) { return new File(dir, fileName(l)); }

    public boolean modelReady(String l) {
        File f = modelFile(l);
        return f.isFile() && f.length() >= minBytes(l);
    }

    /** Downloads the model once (resumes if interrupted). token = Hugging Face access token, only needed for the gated Bangla model. */
    public synchronized void downloadModel(String l, String token, Percent cb) throws Exception {
        if (modelReady(l)) { cb.on(100); return; }
        dir.mkdirs();
        File dest = modelFile(l);
        File part = new File(dir, dest.getName() + ".part");
        long have = part.isFile() ? part.length() : 0L;

        // Follow redirects by hand: the Hugging Face token must only go to huggingface.co, never to the CDN it redirects to.
        String cur = url(l);
        HttpURLConnection c = null;
        int code = 0;
        for (int hop = 0; hop < 6; hop++) {
            c = (HttpURLConnection) new URL(cur).openConnection();
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(false);
            if (token != null && !token.trim().isEmpty() && new URL(cur).getHost().equals("huggingface.co")) {
                c.setRequestProperty("Authorization", "Bearer " + token.trim());
            }
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            code = c.getResponseCode();
            if (code >= 300 && code < 400 && code != 304) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new IllegalStateException("Model download failed (bad redirect)");
                cur = new URL(new URL(cur), loc).toString();
                continue;
            }
            break;
        }
        if (c == null) throw new IllegalStateException("Model download failed");
        if (code == 401 || code == 403) {
            c.disconnect();
            if ("bengali".equals(lang(l))) {
                throw new IllegalStateException("The Bangla Whistle model is gated on Hugging Face. Accept its license on huggingface.co/ehzawad/whistle-bn-BD-2bit, make a read token, and paste it in the caption screen (HTTP " + code + ").");
            }
            throw new IllegalStateException("Model download was refused (HTTP " + code + ")");
        }
        if (code < 200 || code > 299) { c.disconnect(); throw new IllegalStateException("Model download failed (HTTP " + code + ")"); }
        boolean resumed = code == HttpURLConnection.HTTP_PARTIAL && have > 0;
        if (!resumed) { part.delete(); have = 0; }
        long total = c.getContentLengthLong() >= 0 ? c.getContentLengthLong() + have : -1;
        try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part, resumed)) {
            byte[] buf = new byte[128 * 1024];
            long done = have;
            int n, last = -1;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                done += n;
                if (total > 0) { int p = (int) (done * 100 / total); if (p != last) { last = p; cb.on(Math.min(99, p)); } }
            }
        } finally { c.disconnect(); }
        if (part.length() < minBytes(l)) { part.delete(); throw new IllegalStateException("The model download was damaged. Try again."); }
        dest.delete();
        if (!part.renameTo(dest)) throw new IllegalStateException("Could not save the model.");
        cb.on(100);
    }

    // ---- audio hand-over: the WebView sends 16 kHz mono 16-bit audio in small base64 pieces

    public synchronized void begin() throws Exception {
        if (pcmOut != null) { try { pcmOut.close(); } catch (Exception ignored) { } }
        // a fresh file per hand-over: a cancelled run that is still winding down must not touch the next run's audio
        pcmFile = new File(context.getCacheDir(), "whistle-pcm-" + (++pcmSeq) + ".raw");
        pcmFile.delete();
        pcmOut = new FileOutputStream(pcmFile);
    }

    public synchronized void push(String base64) throws Exception {
        if (pcmOut == null) throw new IllegalStateException("Audio was not started.");
        pcmOut.write(Base64.decode(base64, Base64.DEFAULT));
    }

    /** Picks where to end a window that starts at `from`: the quietest 50 ms inside the last seconds of a full window. */
    private static int cutPoint(RandomAccessFile raf, int from, int total) throws Exception {
        if (total - from <= MAX_WINDOW) return total;
        int lo = from + MAX_WINDOW - SEARCH_BACK, hi = from + MAX_WINDOW;
        int frame = SR / 20;
        byte[] b = new byte[(hi - lo) * 2];
        raf.seek((long) lo * 2);
        raf.readFully(b);
        double best = Double.MAX_VALUE;
        int bestAt = hi;
        for (int s = 0; s + frame <= hi - lo; s += frame) {
            double e = 0;
            for (int i = 0; i < frame; i++) {
                int idx = (s + i) * 2;
                short v = (short) ((b[idx] & 0xff) | (b[idx + 1] << 8));
                e += (double) v * v;
            }
            if (e < best) { best = e; bestAt = lo + s + frame / 2; }
        }
        return bestAt;
    }

    private static void parseWindow(String res, long offMs, long winMs, boolean words, JSONArray out) throws Exception {
        if (res == null) return;
        String t = res.trim();
        if (t.isEmpty()) return;
        JSONObject o = null;
        if (t.startsWith("{")) { try { o = new JSONObject(t); } catch (Exception ignored) { o = null; } }
        if (o != null && words && o.optJSONArray("words") != null && o.optJSONArray("words").length() > 0) {
            JSONArray ws = o.getJSONArray("words");
            for (int i = 0; i < ws.length(); i++) {
                JSONObject w = ws.optJSONObject(i);
                if (w == null) continue;
                String text = w.optString("word", w.optString("text", "")).trim();
                if (text.isEmpty()) continue;
                long s = offMs + Math.round(w.optDouble("start", 0) * 1000.0);
                long e = offMs + Math.round(w.optDouble("end", w.optDouble("start", 0) + 0.3) * 1000.0);
                JSONObject r = new JSONObject();
                r.put("t0", s); r.put("t1", Math.max(s + 80, e)); r.put("text", text);
                out.put(r);
            }
            return;
        }
        String text = o != null ? o.optString("text", "").trim() : t;
        if (text.isEmpty()) return;
        // no word times from the engine: the whole window as one piece, the app spreads the words inside it
        JSONObject r = new JSONObject();
        r.put("t0", offMs); r.put("t1", offMs + winMs); r.put("text", text); r.put("seg", true);
        out.put(r);
    }

    /** Runs Whistle on the audio sent so far. Returns the JSON list [{t0,t1,text,seg?}] in ms. */
    public String run(String l, boolean words, Percent cb) throws Exception {
        final File audio;
        synchronized (this) {
            if (pcmOut != null) { pcmOut.flush(); pcmOut.close(); pcmOut = null; }
            audio = pcmFile;
        }
        if (!WhistleNative.AVAILABLE) throw new IllegalStateException("native-unavailable");
        if (!modelReady(l)) throw new IllegalStateException("The Whistle model is not downloaded yet.");
        // one run at a time: a cancelled run may still be stopping; the next one waits for it
        synchronized (runLock) {
            cancelled = false;
            try {
                if (!lang(l).equals(loadedLang)) {
                    loadedLang = "";
                    String err = WhistleNative.nativeLoad(modelFile(l).getAbsolutePath());
                    if (err != null) throw new IllegalStateException(err);
                    loadedLang = lang(l);
                }
                int total = (int) (audio.length() / 2);
                JSONArray out = new JSONArray();
                if (total <= 0) return out.toString();
                String hint = engineLang(l);
                try (RandomAccessFile raf = new RandomAccessFile(audio, "r")) {
                    int at = 0;
                    cb.on(0);
                    while (at < total) {
                        if (cancelled) throw new IllegalStateException("cancelled");
                        int end = cutPoint(raf, at, total);
                        if (end <= at) end = Math.min(total, at + MAX_WINDOW);
                        int n = end - at;
                        byte[] b = new byte[n * 2];
                        raf.seek((long) at * 2);
                        raf.readFully(b);
                        float[] pcm = new float[n];
                        float peak = 0;
                        for (int i = 0; i < n; i++) {
                            short v = (short) ((b[i * 2] & 0xff) | (b[i * 2 + 1] << 8));
                            pcm[i] = v / 32768f;
                            float a = Math.abs(pcm[i]);
                            if (a > peak) peak = a;
                        }
                        // a window with no sound at all is skipped: nothing to hear, and silence is where fillers come from
                        if (peak >= 0.003f && n >= SR / 5) {
                            String res = WhistleNative.nativeTranscribe(pcm, hint, words);
                            if (res == null) throw new IllegalStateException("Whistle failed: " + WhistleNative.nativeLastError());
                            parseWindow(res, (long) at * 1000L / SR, (long) n * 1000L / SR, words, out);
                        }
                        at = end;
                        cb.on(Math.min(99, (int) ((long) at * 100L / total)));
                    }
                }
                return out.toString();
            } finally { audio.delete(); }
        }
    }

    public void cancel() { cancelled = true; }
}
