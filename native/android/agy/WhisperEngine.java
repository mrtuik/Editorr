package com.tuik.editorr.agy;

import android.content.Context;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

/** Whisper on the phone: model download, audio hand-over in chunks, and the run. Runs outside the WebView, so it cannot crash it. */
public final class WhisperEngine {
    public interface Percent { void on(int percent); }

    private static final String BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
    private final Context context;
    private final File dir;
    private final Object runLock = new Object();
    private File pcmFile;
    private int pcmSeq = 0;
    private FileOutputStream pcmOut;
    private long ctx;
    private String ctxModel = "";

    public WhisperEngine(Context context) {
        this.context = context.getApplicationContext();
        dir = new File(this.context.getFilesDir(), "whisper");
        pcmFile = new File(this.context.getCacheDir(), "whisper-pcm-0.raw");
    }

    public static boolean available() { return WhisperNative.AVAILABLE; }

    /** "tiny" | "base" | "small" -> the compact (q5_1) model file. */
    private static String fileName(String model) {
        String m = "tiny".equals(model) || "small".equals(model) ? model : "base";
        return "ggml-" + m + "-q5_1.bin";
    }

    private static long minBytes(String model) {
        return "tiny".equals(model) ? 20_000_000L : "small".equals(model) ? 120_000_000L : 40_000_000L;
    }

    private File modelFile(String model) { return new File(dir, fileName(model)); }

    public boolean modelReady(String model) {
        File f = modelFile(model);
        return f.isFile() && f.length() >= minBytes(model) && hasMagic(f);
    }

    private static boolean hasMagic(File f) {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            byte[] b = new byte[4];
            r.readFully(b);
            return (b[0] & 0xff) == 0x6c && (b[1] & 0xff) == 0x6d && (b[2] & 0xff) == 0x67 && (b[3] & 0xff) == 0x67; // "lmgg"
        } catch (Exception e) { return false; }
    }

    /** Downloads the model once (resumes if interrupted). */
    public synchronized void downloadModel(String model, Percent cb) throws Exception {
        if (modelReady(model)) { cb.on(100); return; }
        dir.mkdirs();
        File dest = modelFile(model);
        File part = new File(dir, dest.getName() + ".part");
        long have = part.isFile() ? part.length() : 0L;
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + dest.getName()).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        int code = c.getResponseCode();
        if (code < 200 || code > 299) throw new IllegalStateException("Model download failed (HTTP " + code + ")");
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
        if (part.length() < minBytes(model) || !hasMagic(part)) { part.delete(); throw new IllegalStateException("The model download was damaged. Try again."); }
        dest.delete();
        if (!part.renameTo(dest)) throw new IllegalStateException("Could not save the model.");
        cb.on(100);
    }

    // ---- audio hand-over: the WebView sends 16 kHz mono 16-bit audio in small base64 pieces

    public synchronized void begin() throws Exception {
        if (pcmOut != null) { try { pcmOut.close(); } catch (Exception ignored) { } }
        // a fresh file per hand-over: a cancelled run that is still winding down must not touch the next run's audio
        pcmFile = new File(context.getCacheDir(), "whisper-pcm-" + (++pcmSeq) + ".raw");
        pcmFile.delete();
        pcmOut = new FileOutputStream(pcmFile);
    }

    public synchronized void push(String base64) throws Exception {
        if (pcmOut == null) throw new IllegalStateException("Audio was not started.");
        pcmOut.write(Base64.decode(base64, Base64.DEFAULT));
    }

    /** Runs Whisper on the audio sent so far. Returns the JSON segment list. */
    public String run(String model, String lang, boolean words, Percent cb) throws Exception {
        final File audio;
        synchronized (this) {
            if (pcmOut != null) { pcmOut.flush(); pcmOut.close(); pcmOut = null; }
            audio = pcmFile;
        }
        if (!WhisperNative.AVAILABLE) throw new IllegalStateException("native-unavailable");
        if (!modelReady(model)) throw new IllegalStateException("The Whisper model is not downloaded yet.");
        // one run at a time: a cancelled run may still be stopping; the next one waits for it
        synchronized (runLock) {
            long handle;
            synchronized (this) {
                if (ctx == 0 || !ctxModel.equals(model)) {
                    if (ctx != 0) WhisperNative.nativeFree(ctx);
                    ctx = WhisperNative.nativeInit(modelFile(model).getAbsolutePath());
                    ctxModel = model;
                    if (ctx == 0) throw new IllegalStateException("The Whisper model could not be loaded.");
                }
                handle = ctx;
            }
            int cores = Runtime.getRuntime().availableProcessors();
            String json;
            try {
                json = WhisperNative.nativeRun(handle, audio.getAbsolutePath(), lang == null ? "" : lang, words, Math.max(2, Math.min(4, cores - 1)), cb::on);
            } finally { audio.delete(); }
            if (json == null) throw new IllegalStateException("cancelled");
            return json;
        }
    }

    public void cancel() { if (WhisperNative.AVAILABLE) WhisperNative.nativeCancel(); }
}
