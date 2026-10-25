package com.tuik.editorr;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.StatFs;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.util.Base64;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.media3.common.C;
import androidx.media3.common.Effect;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.Size;
import androidx.media3.common.OverlaySettings;
import androidx.media3.common.VideoCompositorSettings;
import androidx.media3.effect.StaticOverlaySettings;
import androidx.media3.effect.Crop;
import androidx.media3.effect.BitmapOverlay;
import androidx.media3.effect.OverlayEffect;
import androidx.media3.effect.TextureOverlay;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.effect.Presentation;
import androidx.media3.effect.ScaleAndRotateTransformation;
import androidx.media3.effect.FrameDropEffect;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.VideoEncoderSettings;
import android.view.WindowManager;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.collect.ImmutableList;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.BufferedOutputStream;
import java.io.RandomAccessFile;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Native bridge for Editorr.
 *  - pickVideo:     system picker, copy to cache, metadata
 *  - extractAudio:  MediaExtractor + MediaCodec -> mono 16 kHz PCM16 file
 *  - exportProject: Media3 Transformer composition (two sequences + compositor settings)
 *
 * NOTE: pickVideo/extractAudio are straightforward Android APIs. exportProject uses the
 * Media3 multi-sequence compositor and MUST be verified on a real device (the "spike" in the PRD).
 */
@CapacitorPlugin(name = "EditorrNative")
public class EditorrNativePlugin extends Plugin {

    private static final int TARGET_RATE = 16000;
    private Transformer transformer;
    private volatile Thread denoiseThread;
    private volatile boolean cancelDenoise;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable progressPoll;
    /** Export runs on its own thread so the WebView (UI thread) stays smooth while encoding. */
    private HandlerThread exportThread;
    private Handler exportHandler;

    private synchronized Handler exportHandler() {
        if (exportThread == null || !exportThread.isAlive()) {
            exportThread = new HandlerThread("editorr-export");
            exportThread.start();
            exportHandler = new Handler(exportThread.getLooper());
        }
        return exportHandler;
    }

    /** Stop preview-copy jobs so they do not fight the export for the video encoder. */
    private void cancelProxyJobs() {
        main.post(() -> {
            for (Transformer t : proxyJobs.values()) { try { t.cancel(); } catch (Exception ignored) { } }
            proxyJobs.clear();
        });
    }

    // ------------------------------------------------------------------ pick

    @PluginMethod
    public void pickVideos(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("video/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        if (Boolean.TRUE.equals(call.getBoolean("multiple", false))) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, Intent.createChooser(i, "Pick video"), "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Cancelled");
            return;
        }
        final List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int k = 0; k < clip.getItemCount(); k++) uris.add(clip.getItemAt(k).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) { call.reject("Cancelled"); return; }
        final int ignored = Math.max(0, uris.size() - 2);
        final List<Uri> use = uris.subList(0, Math.min(2, uris.size()));
        new Thread(() -> {
            try {
                JSArray videos = new JSArray();
                for (int idx = 0; idx < use.size(); idx++) videos.put(copyAndProbe(use.get(idx), idx, use.size()));
                JSObject res = new JSObject();
                res.put("videos", videos);
                res.put("ignored", ignored);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Could not read this video: " + e.getMessage());
            }
        }).start();
    }

    /** Copy one picked video into the app files folder (with progress), then read its metadata. */
    private JSObject copyAndProbe(Uri uri, int index, int count) throws Exception {
        String name = displayName(uri);
        long total = querySize(uri);
        File out = new File(videoDir(), System.currentTimeMillis() + "_" + index + "_" + name.replaceAll("[^A-Za-z0-9._-]", "_"));
        emitCopy(index, count, 0);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream os = new FileOutputStream(out)) {
            if (in == null) throw new Exception("the file cannot be opened");
            byte[] buf = new byte[1 << 20];
            int n;
            long done = 0;
            int lastPct = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int pct = (int) Math.min(99, done * 100 / total);
                    if (pct >= lastPct + 3) { lastPct = pct; emitCopy(index, count, pct); }
                }
            }
        }
        emitCopy(index, count, 100);
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        long dur;
        int w, hgt, rot;
        String fpsStr;
        try {
            r.setDataSource(out.getAbsolutePath());
            dur = parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            w = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            hgt = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            rot = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
            fpsStr = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE);
        } finally {
            r.release();
        }
        if (rot == 90 || rot == 270) { int t = w; w = hgt; hgt = t; }
        JSObject o = new JSObject();
        o.put("path", out.getAbsolutePath());
        o.put("name", name);
        o.put("durationMs", dur);
        o.put("width", w);
        o.put("height", hgt);
        int fps = 30;
        try { if (fpsStr != null) fps = Math.round(Float.parseFloat(fpsStr)); } catch (Exception ignored) { }
        String codec = null;
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(out.getAbsolutePath());
            for (int t = 0; t < ex.getTrackCount(); t++) {
                MediaFormat fm = ex.getTrackFormat(t);
                String mime = fm.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    codec = mime;
                    if (fpsStr == null) {
                        try { fps = fm.getInteger(MediaFormat.KEY_FRAME_RATE); }
                        catch (Exception e1) { try { fps = Math.round(fm.getFloat(MediaFormat.KEY_FRAME_RATE)); } catch (Exception e2) { /* keep default */ } }
                    }
                    break;
                }
            }
        } catch (Exception ignored) {
            // codec stays unknown
        } finally {
            ex.release();
        }
        o.put("fps", fps <= 0 ? 30 : fps);
        if (codec != null) o.put("codec", codec);
        if (dur > 0) o.put("bitrate", out.length() * 8000L / dur);
        return o;
    }

    private void emitCopy(int index, int count, int percent) {
        JSObject e = new JSObject();
        e.put("index", index);
        e.put("count", count);
        e.put("percent", percent);
        notifyListeners("copyProgress", e);
    }

    private long querySize(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx);
            }
        } catch (Exception ignored) { }
        return -1;
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) { }
        return "video.mp4";
    }

    private static long parseLong(String s) {
        try { return s == null ? 0 : Long.parseLong(s); } catch (Exception e) { return 0; }
    }

    // --------------------------------------------------------------- storage

    /** Picked videos live here until their project is deleted. */
    private File videoDir() {
        File d = new File(getContext().getFilesDir(), "videos");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Decoded audio of each picked video. Kept (not in cache) so it is read only once, like the video itself. */
    private File audioDir() {
        File d = new File(getContext().getFilesDir(), "audio");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Preview copies and timeline pictures. Kept (not in cache) so Android does not wipe them and they are made only once. */
    private File previewDir() {
        File d = new File(getContext().getFilesDir(), "preview");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** Rebuildable files (audio PCM, preview copies, export temp). Safe to delete. */
    private File cacheDir() {
        File d = new File(getContext().getCacheDir(), "editorr");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long n = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) n += dirSize(k);
        return n;
    }

    /** True only for a file inside the videos folder (blocks paths like ../../x). */
    private boolean isInsideVideoDir(File f) {
        try {
            return f.getCanonicalPath().startsWith(videoDir().getCanonicalPath() + File.separator);
        } catch (Exception e) { return false; }
    }

    /** Delete a video and the audio/preview files made from it. */
    private void deleteVideoAndDerived(File video) {
        String name = video.getName();
        if (isInsideVideoDir(video)) video.delete();
        new File(cacheDir(), name + ".pcm16k").delete();
        new File(audioDir(), name + ".pcm16k").delete();
        new File(audioDir(), name + ".pcm16k.meta").delete();
        new File(cacheDir(), "proxy_" + name + ".mp4").delete();
        new File(cacheDir(), "proxy_" + name + ".mp4.tmp").delete();
        new File(previewDir(), "proxy_" + name + ".mp4").delete();
        new File(previewDir(), "proxy_" + name + ".mp4.tmp").delete();
        for (File dir : new File[] { cacheDir(), previewDir() }) {
            File[] cached = dir.listFiles();
            if (cached != null) for (File c : cached) if (c.getName().startsWith("thumb_" + name + "_")) c.delete();
        }
    }

    private static String stripFileScheme(String p) {
        return p != null && p.startsWith("file://") ? p.substring(7) : p;
    }

    @PluginMethod
    public void fileExists(PluginCall call) {
        String path = stripFileScheme(call.getString("path"));
        File f = path == null ? null : new File(path);
        JSObject o = new JSObject();
        o.put("exists", f != null && f.isFile() && f.length() > 0);
        call.resolve(o);
    }

    /** Delete the videos of a deleted project (only files inside the videos folder). */
    @PluginMethod
    public void deleteVideos(PluginCall call) {
        try {
            JSArray arr = call.getArray("paths");
            int n = 0;
            for (int i = 0; arr != null && i < arr.length(); i++) {
                File f = new File(stripFileScheme(arr.getString(i)));
                if (isInsideVideoDir(f)) { deleteVideoAndDerived(f); n++; }
            }
            JSObject o = new JSObject();
            o.put("deleted", n);
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Could not delete videos: " + e.getMessage());
        }
    }

    /** Delete every video that no saved project uses (left over from cancelled imports). */
    @PluginMethod
    public void pruneVideos(PluginCall call) {
        new Thread(() -> {
            try {
                java.util.HashSet<String> keep = new java.util.HashSet<>();
                JSArray arr = call.getArray("keep");
                for (int i = 0; arr != null && i < arr.length(); i++) keep.add(new File(stripFileScheme(arr.getString(i))).getCanonicalPath());
                int n = 0;
                File[] kids = videoDir().listFiles();
                if (kids != null) for (File k : kids) {
                    if (k.isFile() && !keep.contains(k.getCanonicalPath()) && System.currentTimeMillis() - k.lastModified() > 24L * 3600 * 1000) { deleteVideoAndDerived(k); n++; }
                }
                JSObject o = new JSObject();
                o.put("deleted", n);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Could not clean videos: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void storageInfo(PluginCall call) {
        new Thread(() -> {
            JSObject o = new JSObject();
            o.put("videosBytes", dirSize(videoDir()) + dirSize(audioDir()) + dirSize(previewDir()));
            o.put("cacheBytes", dirSize(cacheDir()));
            o.put("freeMb", new StatFs(getContext().getFilesDir().getAbsolutePath()).getAvailableBytes() / (1024 * 1024));
            call.resolve(o);
        }).start();
    }

    /** Empty the cache folder only. Projects and their videos are not touched. */
    @PluginMethod
    public void clearCache(PluginCall call) {
        new Thread(() -> {
            long before = dirSize(cacheDir());
            File[] kids = cacheDir().listFiles();
            if (kids != null) for (File k : kids) if (k.isFile()) k.delete();
            JSObject o = new JSObject();
            o.put("freedBytes", before - dirSize(cacheDir()));
            call.resolve(o);
        }).start();
    }

    @PluginMethod
    public void freeSpaceMb(PluginCall call) {
        StatFs fs = new StatFs(getContext().getCacheDir().getAbsolutePath());
        JSObject o = new JSObject();
        o.put("mb", fs.getAvailableBytes() / (1024 * 1024));
        call.resolve(o);
    }

    // ----------------------------------------------------------- audio decode

    @PluginMethod
    public void extractAudio(PluginCall call) {
        final String path = call.getString("path");
        if (path == null) { call.reject("path missing"); return; }
        new Thread(() -> {
            MediaExtractor ex = null;
            MediaCodec codec = null;
            try {
                // Already decoded before (same source file)? Reuse it: no "Reading audio" wait on every open.
                File srcFile = new File(stripFileScheme(path));
                File cachedPcm = new File(audioDir(), srcFile.getName() + ".pcm16k");
                File cachedMeta = new File(audioDir(), srcFile.getName() + ".pcm16k.meta");
                if (cachedPcm.exists() && cachedPcm.length() > 0 && cachedMeta.exists()) {
                    try {
                        String meta = new String(java.nio.file.Files.readAllBytes(cachedMeta.toPath()), "UTF-8").trim();
                        if (meta.equals(String.valueOf(srcFile.length()))) {
                            JSObject pe = new JSObject();
                            pe.put("path", path);
                            pe.put("percent", 100);
                            notifyListeners("audioProgress", pe);
                            JSObject hit = new JSObject();
                            hit.put("pcmPath", cachedPcm.getAbsolutePath());
                            hit.put("samples", cachedPcm.length() / 2);
                            call.resolve(hit);
                            return;
                        }
                    } catch (Exception ignored) { /* decode again */ }
                }
                ex = openSource(path);
                int track = -1;
                MediaFormat fmt = null;
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    MediaFormat f = ex.getTrackFormat(i);
                    String mime = f.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
                }
                if (track < 0) { call.reject("This video has no audio track."); return; }
                ex.selectTrack(track);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                codec = MediaCodec.createDecoderByType(mime);
                codec.configure(fmt, null, null, 0);
                codec.start();

                File outFile = new File(audioDir(), new File(stripFileScheme(path)).getName() + ".pcm16k.tmp");
                long samplesOut = 0;
                long durUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
                int lastPct = -10;

                int channels = fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
                int rate = fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
                boolean floatPcm = false;

                // resampler state (linear, streaming)
                double step = rate / (double) TARGET_RATE;
                double next = 0;
                long idx = 0;
                float prev = 0;

                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                boolean inDone = false, outDone = false;
                ByteBuffer outBytes = ByteBuffer.allocate(1 << 16).order(ByteOrder.LITTLE_ENDIAN);

                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    while (!outDone) {
                        // 1. feed every input buffer the decoder will take right now (no waiting)
                        while (!inDone) {
                            int ii = codec.dequeueInputBuffer(0);
                            if (ii < 0) break;
                            ByteBuffer b = codec.getInputBuffer(ii);
                            int n = ex.readSampleData(b, 0);
                            if (n < 0) {
                                codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inDone = true;
                            } else {
                                codec.queueInputBuffer(ii, 0, n, ex.getSampleTime(), 0);
                                ex.advance();
                            }
                        }
                        // 2. take everything that is ready; wait only a few ms when nothing is
                        long waitUs = 4000;
                        while (true) {
                            int oi = codec.dequeueOutputBuffer(info, waitUs);
                            if (oi == MediaCodec.INFO_TRY_AGAIN_LATER) break;
                            if (oi >= 0) {
                                waitUs = 0;
                                ByteBuffer ob = codec.getOutputBuffer(oi);
                                if (ob != null && info.size > 0) {
                                    ob.position(info.offset);
                                    ob.limit(info.offset + info.size);
                                    ByteBuffer src = ob.order(ByteOrder.LITTLE_ENDIAN);
                                    int frameBytes = (floatPcm ? 4 : 2) * channels;
                                    int frames = info.size / frameBytes;
                                    for (int f = 0; f < frames; f++) {
                                        float s = 0;
                                        for (int c = 0; c < channels; c++) {
                                            s += floatPcm ? src.getFloat() : src.getShort() / 32768f;
                                        }
                                        s /= channels;
                                        while (next <= idx) {
                                            double frac = next - (idx - 1);
                                            float v = prev + (s - prev) * (float) frac;
                                            int q = Math.max(-32768, Math.min(32767, Math.round(v * 32767f)));
                                            if (outBytes.remaining() < 2) { fos.write(outBytes.array(), 0, outBytes.position()); outBytes.clear(); }
                                            outBytes.putShort((short) q);
                                            samplesOut++;
                                            next += step;
                                        }
                                        prev = s;
                                        idx++;
                                    }
                                }
                                if (durUs > 0) {
                                    int pct = (int) Math.min(100, info.presentationTimeUs * 100 / durUs);
                                    if (pct >= lastPct + 2) {
                                        lastPct = pct;
                                        JSObject pe = new JSObject();
                                        pe.put("path", path);
                                        pe.put("percent", pct);
                                        notifyListeners("audioProgress", pe);
                                    }
                                }
                                codec.releaseOutputBuffer(oi, false);
                                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) { outDone = true; break; }
                            } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                                MediaFormat of = codec.getOutputFormat();
                                channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                                int newRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                                if (newRate != rate) { rate = newRate; step = rate / (double) TARGET_RATE; }
                                floatPcm = of.containsKey(MediaFormat.KEY_PCM_ENCODING)
                                        && of.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT;
                            }
                        }
                    }
                    if (outBytes.position() > 0) fos.write(outBytes.array(), 0, outBytes.position());
                }
                File finalPcm = new File(audioDir(), new File(stripFileScheme(path)).getName() + ".pcm16k");
                finalPcm.delete();
                if (!outFile.renameTo(finalPcm)) throw new java.io.IOException("could not save the audio");
                java.nio.file.Files.write(new File(audioDir(), finalPcm.getName() + ".meta").toPath(),
                        String.valueOf(new File(stripFileScheme(path)).length()).getBytes("UTF-8"));
                JSObject o = new JSObject();
                o.put("pcmPath", finalPcm.getAbsolutePath());
                o.put("samples", samplesOut);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Could not read audio: " + e.getMessage());
            } finally {
                try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) { }
                if (ex != null) ex.release();
            }
        }).start();
    }

    /**
     * Decode the selected source at its native sample rate, then create a mono, denoised WAV.
     * This is an export-only source; the 16 kHz PCM used by editor analysis is never changed.
     */
    @PluginMethod
    public void prepareDenoiseAudio(PluginCall call) {
        final String path = stripFileScheme(call.getString("path"));
        final int strength = Math.max(0, Math.min(100, call.getInt("strength", 0)));
        if (path == null) { call.reject("path missing"); return; }
        synchronized (this) {
            if (denoiseThread != null) { call.reject("Noise reduction is already running."); return; }
            cancelDenoise = false;
            Thread job = new Thread(() -> {
                File raw = null;
                File wav = null;
                try {
                    raw = new File(cacheDir(), "denoise_" + System.currentTimeMillis() + ".f32");
                    wav = new File(cacheDir(), "denoised_" + System.currentTimeMillis() + ".wav");
                    int sampleRate = decodeFullRateMono(path, raw);
                    checkDenoiseCancelled();
                    denoisePcmFile(raw, wav, sampleRate, strength, path);
                    checkDenoiseCancelled();
                    JSObject result = new JSObject();
                    result.put("audioUri", Uri.fromFile(wav).toString());
                    call.resolve(result);
                } catch (InterruptedException e) {
                    if (wav != null) wav.delete();
                    call.reject("Noise reduction cancelled.");
                } catch (Exception e) {
                    if (wav != null) wav.delete();
                    call.reject("Could not prepare noise-reduced audio: " + e.getMessage());
                } finally {
                    if (raw != null) raw.delete();
                    synchronized (EditorrNativePlugin.this) {
                        if (denoiseThread == Thread.currentThread()) denoiseThread = null;
                    }
                }
            }, "EditorrDenoise");
            denoiseThread = job;
            job.start();
        }
    }

    private void checkDenoiseCancelled() throws InterruptedException {
        if (cancelDenoise || Thread.currentThread().isInterrupted()) throw new InterruptedException("cancelled");
    }

    private void reportDenoiseProgress(String path, int percent) {
        JSObject event = new JSObject();
        event.put("path", path);
        event.put("percent", Math.max(0, Math.min(100, percent)));
        notifyListeners("denoiseProgress", event);
    }

    /** Decoder output is downmixed to mono, but is deliberately not resampled. */
    private int decodeFullRateMono(String path, File rawFile) throws Exception {
        MediaExtractor ex = null;
        MediaCodec codec = null;
        try {
            ex = openSource(path);
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
            }
            if (track < 0 || fmt == null) throw new IOException("This video has no audio track.");
            ex.selectTrack(track);
            int rate = fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            int channels = fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
            long durationUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();
            boolean floatPcm = false, inDone = false, outDone = false, wroteSamples = false;
            long totalSamples = 0;
            int lastPct = -5;
            ByteBuffer bytes = ByteBuffer.allocate(1 << 16).order(ByteOrder.LITTLE_ENDIAN);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            try (FileOutputStream fos = new FileOutputStream(rawFile)) {
                while (!outDone) {
                    checkDenoiseCancelled();
                    while (!inDone) {
                        int ii = codec.dequeueInputBuffer(0);
                        if (ii < 0) break;
                        ByteBuffer input = codec.getInputBuffer(ii);
                        int n = ex.readSampleData(input, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inDone = true;
                        } else {
                            codec.queueInputBuffer(ii, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                    long waitUs = 4000;
                    while (true) {
                        int oi = codec.dequeueOutputBuffer(info, waitUs);
                        if (oi == MediaCodec.INFO_TRY_AGAIN_LATER) break;
                        if (oi >= 0) {
                            waitUs = 0;
                            ByteBuffer output = codec.getOutputBuffer(oi);
                            if (output != null && info.size > 0) {
                                output.position(info.offset);
                                output.limit(info.offset + info.size);
                                ByteBuffer src = output.order(ByteOrder.LITTLE_ENDIAN);
                                int frameBytes = (floatPcm ? 4 : 2) * channels;
                                int frames = info.size / frameBytes;
                                for (int frame = 0; frame < frames; frame++) {
                                    float sample = 0;
                                    for (int c = 0; c < channels; c++)
                                        sample += floatPcm ? src.getFloat() : src.getShort() / 32768f;
                                    sample /= channels;
                                    if (bytes.remaining() < 4) {
                                        fos.write(bytes.array(), 0, bytes.position());
                                        bytes.clear();
                                    }
                                    bytes.putFloat(sample);
                                    totalSamples++;
                                }
                                wroteSamples |= frames > 0;
                            }
                            if (durationUs > 0) {
                                int pct = (int) Math.min(20, Math.max(0, info.presentationTimeUs * 20 / durationUs));
                                if (pct >= lastPct + 2) { lastPct = pct; reportDenoiseProgress(path, pct); }
                            }
                            codec.releaseOutputBuffer(oi, false);
                            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) { outDone = true; break; }
                        } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            MediaFormat out = codec.getOutputFormat();
                            int outChannels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                            int outRate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                            if (wroteSamples && (outChannels != channels || outRate != rate))
                                throw new IOException("Audio format changed during decode.");
                            channels = outChannels;
                            rate = outRate;
                            floatPcm = out.containsKey(MediaFormat.KEY_PCM_ENCODING)
                                    && out.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT;
                        }
                    }
                }
                if (bytes.position() > 0) fos.write(bytes.array(), 0, bytes.position());
            }
            if (totalSamples == 0) throw new IOException("The audio decoder returned no samples.");
            reportDenoiseProgress(path, 20);
            return rate;
        } finally {
            try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) { }
            if (ex != null) ex.release();
        }
    }

    private static final int DENOISE_FRAME = 1024;
    private static final int DENOISE_HOP = 256;
    private static final int DENOISE_HALF = DENOISE_FRAME / 2;
    private static final int DENOISE_BINS = DENOISE_HALF + 1;

    private void denoisePcmFile(File rawFile, File wavFile, int sampleRate, int strength, String sourcePath) throws Exception {
        long samples = rawFile.length() / 4L;
        if (samples <= 0) throw new IOException("No audio samples were decoded.");
        if (samples * 2L > Integer.MAX_VALUE - 36L) throw new IOException("The audio track is too long for a WAV export.");
        long frameCountLong = (long) Math.ceil((samples + DENOISE_HALF) / (double) DENOISE_HOP);
        if (frameCountLong > Integer.MAX_VALUE - 8) throw new IOException("The audio track is too long to process.");
        int frameCount = (int) frameCountLong;
        float[] rms = new float[frameCount];
        float[] frame = new float[DENOISE_FRAME];
        byte[] frameBytes = new byte[DENOISE_FRAME * 4];
        float[] window = new float[DENOISE_FRAME];
        for (int i = 0; i < DENOISE_FRAME; i++)
            window[i] = 0.5f - 0.5f * (float) Math.cos(2.0 * Math.PI * i / (DENOISE_FRAME - 1));

        try (RandomAccessFile input = new RandomAccessFile(rawFile, "r")) {
            int reportEvery = Math.max(1, frameCount / 30);
            for (int f = 0; f < frameCount; f++) {
                checkDenoiseCancelled();
                long start = (long) f * DENOISE_HOP - DENOISE_HALF;
                readDenoiseFrame(input, samples, start, frame, frameBytes);
                double sum = 0;
                long from = Math.max(0, start), to = Math.min(samples, start + DENOISE_FRAME);
                for (long at = from; at < to; at++) {
                    float v = frame[(int) (at - start)];
                    sum += v * v;
                }
                rms[f] = to > from ? (float) Math.sqrt(sum / (to - from)) : 0;
                if (f % reportEvery == 0) reportDenoiseProgress(sourcePath, 20 + (int) (f * 5L / frameCount));
            }

            float[] sorted = rms.clone();
            Arrays.sort(sorted);
            int quietTarget = Math.max(1, (int) Math.ceil(frameCount * 0.1));
            float threshold = sorted[quietTarget - 1];
            int below = 0;
            for (float value : rms) if (value < threshold) below++;
            int tiesLeft = Math.max(0, quietTarget - below);
            float[] noise = new float[DENOISE_BINS];
            float[] re = new float[DENOISE_FRAME], im = new float[DENOISE_FRAME];
            int profiled = 0;
            for (int f = 0; f < frameCount; f++) {
                checkDenoiseCancelled();
                boolean selected = rms[f] < threshold || (Float.compare(rms[f], threshold) == 0 && tiesLeft > 0);
                if (!selected) continue;
                if (Float.compare(rms[f], threshold) == 0) tiesLeft--;
                analyseDenoiseFrame(input, samples, (long) f * DENOISE_HOP - DENOISE_HALF, frame, frameBytes, window, re, im);
                for (int k = 0; k < DENOISE_BINS; k++) noise[k] += (float) Math.hypot(re[k], im[k]);
                profiled++;
                if (profiled % Math.max(1, quietTarget / 20) == 0)
                    reportDenoiseProgress(sourcePath, 25 + (int) (profiled * 5L / quietTarget));
            }
            if (profiled == 0) throw new IOException("Could not estimate the background noise.");
            for (int k = 0; k < DENOISE_BINS; k++) noise[k] /= profiled;

            float amount = strength / 100f;
            float overSubtract = 1f + 2.5f * amount;
            float floor = 0.5f - 0.42f * amount;
            float[] rawGain = new float[DENOISE_BINS];
            float[] gain = new float[DENOISE_BINS];
            float[] previous = new float[DENOISE_BINS];
            Arrays.fill(previous, 1f);
            final int ringSize = DENOISE_FRAME * 2;
            float[] ring = new float[ringSize], weights = new float[ringSize];
            long cursor = 0;
            try (PcmWavWriter writer = new PcmWavWriter(wavFile, sampleRate, samples)) {
                int writeReportEvery = Math.max(1, frameCount / 70);
                for (int f = 0; f < frameCount; f++) {
                    checkDenoiseCancelled();
                    long start = (long) f * DENOISE_HOP - DENOISE_HALF;
                    analyseDenoiseFrame(input, samples, start, frame, frameBytes, window, re, im);
                    for (int k = 0; k < DENOISE_BINS; k++) {
                        float magnitude = (float) Math.hypot(re[k], im[k]);
                        float clean = Math.max(magnitude - noise[k] * overSubtract, magnitude * floor);
                        rawGain[k] = magnitude > 1e-8f ? Math.max(floor, Math.min(1f, clean / magnitude)) : 1f;
                    }
                    for (int k = 0; k < DENOISE_BINS; k++) {
                        float left = rawGain[Math.max(0, k - 1)];
                        float right = rawGain[Math.min(DENOISE_BINS - 1, k + 1)];
                        float acrossFrequency = left * 0.25f + rawGain[k] * 0.5f + right * 0.25f;
                        gain[k] = previous[k] * 0.55f + acrossFrequency * 0.45f;
                        previous[k] = gain[k];
                        re[k] *= gain[k];
                        im[k] *= gain[k];
                        if (k > 0 && k < DENOISE_HALF) {
                            int mirror = DENOISE_FRAME - k;
                            re[mirror] *= gain[k];
                            im[mirror] *= gain[k];
                        }
                    }
                    fftDenoise(re, im, true);
                    for (int i = 0; i < DENOISE_FRAME; i++) {
                        long at = start + i;
                        if (at < 0 || at >= samples) continue;
                        int slot = (int) Math.floorMod(at, (long) ringSize);
                        float w = window[i];
                        ring[slot] += re[i] * w;
                        weights[slot] += w * w;
                    }
                    long flushTo = Math.min(samples, start + DENOISE_HOP);
                    while (cursor < flushTo) {
                        int slot = (int) Math.floorMod(cursor, (long) ringSize);
                        float value = weights[slot] > 1e-8f ? ring[slot] / weights[slot] : 0f;
                        writer.write(value);
                        ring[slot] = 0f;
                        weights[slot] = 0f;
                        cursor++;
                    }
                    if (f % writeReportEvery == 0)
                        reportDenoiseProgress(sourcePath, 30 + (int) (f * 70L / frameCount));
                }
                while (cursor < samples) {
                    int slot = (int) Math.floorMod(cursor, (long) ringSize);
                    writer.write(weights[slot] > 1e-8f ? ring[slot] / weights[slot] : 0f);
                    ring[slot] = 0f; weights[slot] = 0f; cursor++;
                }
                writer.finish();
            }
        }
        reportDenoiseProgress(sourcePath, 100);
    }

    private static void readDenoiseFrame(RandomAccessFile input, long sampleCount, long start, float[] frame, byte[] bytes) throws IOException {
        Arrays.fill(frame, 0f);
        long from = Math.max(0, start);
        long to = Math.min(sampleCount, start + DENOISE_FRAME);
        if (to <= from) return;
        int count = (int) (to - from);
        input.seek(from * 4L);
        input.readFully(bytes, 0, count * 4);
        int destination = (int) (from - start);
        for (int i = 0; i < count; i++) {
            int at = i * 4;
            int bits = (bytes[at] & 255) | ((bytes[at + 1] & 255) << 8)
                    | ((bytes[at + 2] & 255) << 16) | ((bytes[at + 3] & 255) << 24);
            frame[destination + i] = Float.intBitsToFloat(bits);
        }
    }

    private static void analyseDenoiseFrame(RandomAccessFile input, long samples, long start, float[] frame,
                                              byte[] bytes, float[] window, float[] re, float[] im) throws IOException {
        readDenoiseFrame(input, samples, start, frame, bytes);
        for (int i = 0; i < DENOISE_FRAME; i++) { re[i] = frame[i] * window[i]; im[i] = 0f; }
        fftDenoise(re, im, false);
    }

    private static void fftDenoise(float[] re, float[] im, boolean inverse) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                float tr = re[i]; re[i] = re[j]; re[j] = tr;
                float ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double angle = (inverse ? 2.0 : -2.0) * Math.PI / len;
            float wrStep = (float) Math.cos(angle), wiStep = (float) Math.sin(angle);
            for (int start = 0; start < n; start += len) {
                float wr = 1f, wi = 0f;
                int half = len >> 1;
                for (int j = 0; j < half; j++) {
                    int even = start + j, odd = even + half;
                    float or = re[odd] * wr - im[odd] * wi;
                    float oi = re[odd] * wi + im[odd] * wr;
                    float er = re[even], ei = im[even];
                    re[even] = er + or; im[even] = ei + oi;
                    re[odd] = er - or; im[odd] = ei - oi;
                    float nextWr = wr * wrStep - wi * wiStep;
                    wi = wr * wiStep + wi * wrStep;
                    wr = nextWr;
                }
            }
        }
        if (inverse) for (int i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    private static final class PcmWavWriter implements AutoCloseable {
        private final BufferedOutputStream out;
        private final byte[] buffer = new byte[8192];
        private int used = 0;

        PcmWavWriter(File file, int sampleRate, long samples) throws IOException {
            long dataLength = samples * 2L;
            ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            h.put(new byte[]{(byte) 'R',(byte) 'I',(byte) 'F',(byte) 'F'}).putInt((int) (36 + dataLength))
                    .put(new byte[]{(byte) 'W',(byte) 'A',(byte) 'V',(byte) 'E'});
            h.put(new byte[]{(byte) 'f',(byte) 'm',(byte) 't',(byte) ' '}).putInt(16).putShort((short) 1).putShort((short) 1);
            h.putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16);
            h.put(new byte[]{(byte) 'd',(byte) 'a',(byte) 't',(byte) 'a'}).putInt((int) dataLength);
            out = new BufferedOutputStream(new FileOutputStream(file), 64 * 1024);
            out.write(h.array());
        }

        void write(float value) throws IOException {
            int sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767f)));
            if (used + 2 > buffer.length) flushBuffer();
            buffer[used++] = (byte) (sample & 255);
            buffer[used++] = (byte) ((sample >>> 8) & 255);
        }

        private void flushBuffer() throws IOException {
            if (used > 0) { out.write(buffer, 0, used); used = 0; }
        }

        void finish() throws IOException { flushBuffer(); out.flush(); }
        @Override public void close() throws IOException { flushBuffer(); out.close(); }
    }

    /** Open a MediaExtractor on a local file. File descriptor first (most reliable), Uri as fallback. */
    private MediaExtractor openSource(String path) throws Exception {
        File f = new File(path);
        if (!f.exists() || f.length() == 0) {
            throw new Exception("video file is missing or empty (" + f.length() + " bytes)");
        }
        String err1;
        MediaExtractor a = new MediaExtractor();
        try (java.io.FileInputStream fis = new java.io.FileInputStream(f)) {
            a.setDataSource(fis.getFD(), 0, f.length());
            return a;
        } catch (Exception e) {
            err1 = String.valueOf(e.getMessage());
            a.release();
        }
        MediaExtractor b = new MediaExtractor();
        try {
            b.setDataSource(getContext(), Uri.fromFile(f), null);
            return b;
        } catch (Exception e) {
            b.release();
            throw new Exception(err1 + " / " + e.getMessage() + " (file " + (f.length() / 1024) + " KB, " + f.getName() + ")");
        }
    }


    // ------------------------------------------------------------ preview proxy

    /** One Transformer per source video, so both previews can be made at the same time. */
    private final java.util.Map<String, Transformer> proxyJobs = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.Map<String, PluginCall> proxyCalls = new java.util.concurrent.ConcurrentHashMap<>();

    /** Stop one preview-copy job (the user cancelled it in the task list). Its makeProxy call is rejected with "Cancelled". */
    @PluginMethod
    public void cancelProxy(PluginCall call) {
        final String path = stripFileScheme(call.getString("path"));
        main.post(() -> {
            if (path != null) {
                Transformer t = proxyJobs.remove(path);
                if (t != null) { try { t.cancel(); } catch (Exception ignored) { } }
                new File(previewDir(), "proxy_" + new File(path).getName() + ".mp4.tmp").delete();
                PluginCall pc = proxyCalls.remove(path);
                if (pc != null) pc.reject("Cancelled");
            }
            call.resolve();
        });
    }

    /** Transcode one video to a small H.264 file so the WebView can preview it smoothly. Cached per source file. */
    @PluginMethod
    public void makeProxy(PluginCall call) {
        final String path = stripFileScheme(call.getString("path"));
        final int height = call.getInt("height", 540);
        final int pw = call.getInt("outW", 0);
        final int ph = call.getInt("outH", 0);
        if (path == null) { call.reject("path missing"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                final File out = new File(previewDir(), "proxy_" + new File(path).getName() + ".mp4");
                if (out.exists() && out.length() > 0) {
                    JSObject o = new JSObject();
                    o.put("proxyPath", out.getAbsolutePath());
                    call.resolve(o);
                    return;
                }
                if (proxyJobs.containsKey(path)) { call.reject("A preview copy of this video is already being made."); return; }
                final File tmp = new File(out.getAbsolutePath() + ".tmp");
                if (tmp.exists()) tmp.delete();
                MediaItem mi = MediaItem.fromUri(Uri.fromFile(new File(path)));
                ImmutableList<Effect> video = (pw > 0 && ph > 0)
                        ? ImmutableList.<Effect>of(Presentation.createForWidthAndHeight(pw, ph, Presentation.LAYOUT_SCALE_TO_FIT))
                        : ImmutableList.<Effect>of(Presentation.createForHeight(height));
                EditedMediaItem item = new EditedMediaItem.Builder(mi)
                        .setEffects(new Effects(ImmutableList.of(), video))
                        .build();
                final ProgressHolder holder = new ProgressHolder();
                final Runnable[] poll = new Runnable[1];
                final Transformer[] self = new Transformer[1];
                self[0] = new Transformer.Builder(getContext())
                        .setVideoMimeType(MimeTypes.VIDEO_H264)
                        .setAudioMimeType(MimeTypes.AUDIO_AAC)
                        .addListener(new Transformer.Listener() {
                            @Override public void onCompleted(@NonNull Composition c, @NonNull ExportResult r) {
                                main.removeCallbacks(poll[0]);
                                proxyJobs.remove(path); proxyCalls.remove(path);
                                if (tmp.renameTo(out)) {
                                    JSObject o = new JSObject();
                                    o.put("proxyPath", out.getAbsolutePath());
                                    call.resolve(o);
                                } else call.reject("Could not save the preview copy.");
                            }
                            @Override public void onError(@NonNull Composition c, @NonNull ExportResult r, @NonNull ExportException e) {
                                main.removeCallbacks(poll[0]);
                                proxyJobs.remove(path); proxyCalls.remove(path);
                                tmp.delete();
                                call.reject("Preview copy failed: " + e.getMessage());
                            }
                        })
                        .build();
                proxyJobs.put(path, self[0]);
                proxyCalls.put(path, call);
                poll[0] = new Runnable() {
                    @Override public void run() {
                        if (!proxyJobs.containsKey(path)) return;
                        if (self[0].getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) {
                            JSObject e = new JSObject();
                            e.put("path", path);
                            e.put("percent", holder.progress);
                            notifyListeners("proxyProgress", e);
                        }
                        main.postDelayed(this, 500);
                    }
                };
                self[0].start(item, tmp.getAbsolutePath());
                main.post(poll[0]);
            } catch (Exception e) {
                proxyJobs.remove(path); proxyCalls.remove(path);
                call.reject("Preview copy failed to start: " + e.getMessage());
            }
        });
    }

    // ---------------------------------------------------------------- thumbnails

    /**
     * Picture strip for the timeline: `count` frames spread over the video, saved as small JPEGs in the cache.
     * Each finished frame is announced with a 'thumb' event so the timeline can fill in while it works.
     */
    @PluginMethod
    public void makeThumbs(PluginCall call) {
        final String path = stripFileScheme(call.getString("path"));
        final int count = Math.max(1, Math.min(300, call.getInt("count", 1)));
        final int height = Math.max(48, Math.min(720, call.getInt("height", 96)));
        if (path == null) { call.reject("path missing"); return; }
        new Thread(() -> {
            MediaMetadataRetriever r = new MediaMetadataRetriever();
            try {
                r.setDataSource(path);
                long durMs = parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                String base = new File(path).getName();
                JSArray files = new JSArray();
                for (int i = 0; i < count; i++) {
                    File f = new File(previewDir(), "thumb_" + base + "_" + count + "_" + i + ".jpg");
                    if (!f.exists() || f.length() == 0) {
                        long tUs = (long) (((i + 0.5) / count) * durMs * 1000.0);
                        Bitmap bmp = r.getFrameAtTime(tUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                        if (bmp == null) { files.put(""); continue; }
                        int w = Math.max(1, Math.round(bmp.getWidth() * (height / (float) bmp.getHeight())));
                        Bitmap small = Bitmap.createScaledBitmap(bmp, w, height, true);
                        try (FileOutputStream fo = new FileOutputStream(f)) {
                            small.compress(Bitmap.CompressFormat.JPEG, 72, fo);
                        }
                        if (small != bmp) small.recycle();
                        bmp.recycle();
                    }
                    files.put(f.getAbsolutePath());
                    JSObject e = new JSObject();
                    e.put("path", path);
                    e.put("index", i);
                    e.put("count", count);
                    e.put("file", f.getAbsolutePath());
                    notifyListeners("thumb", e);
                }
                JSObject res = new JSObject();
                res.put("files", files);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Could not make thumbnails: " + e.getMessage());
            } finally {
                try { r.release(); } catch (Exception ignored) { }
            }
        }).start();
    }

    // ----------------------------------------------------------------- export

    /** Captions drawn onto every frame. Same maths as captions.ts drawCaption, so preview and export match. */
    private static final class CaptionOverlay extends BitmapOverlay {
        private final int w, h;
        private final long[] ps, pe;
        private final String[][] words;
        private final long[][] ws;
        private final double size, y, stroke, activeScale;
        private final int weight, color, highlight, strokeColor, boxColor;
        private final boolean shadow, activeColor, hasBox;
        private int lastKey = -2;
        private Bitmap lastBmp;

        private CaptionOverlay(int w, int h, long[] ps, long[] pe, String[][] words, long[][] ws, JSONObject st) {
            this.w = w; this.h = h; this.ps = ps; this.pe = pe; this.words = words; this.ws = ws;
            this.size = st.optDouble("size", 0.055); this.y = st.optDouble("y", 0.78);
            this.stroke = st.optDouble("stroke", 0); this.activeScale = st.optDouble("activeScale", 1);
            this.weight = st.optInt("weight", 700);
            this.color = css(st.optString("color", "#FFFFFF"), Color.WHITE);
            this.highlight = css(st.optString("highlight", "#FFD60A"), Color.YELLOW);
            this.strokeColor = css(st.optString("strokeColor", "#000000"), Color.BLACK);
            String box = st.optString("box", "");
            this.hasBox = box != null && box.length() > 0;
            this.boxColor = css(box, Color.BLACK);
            this.shadow = st.optBoolean("shadow", false);
            this.activeColor = st.optBoolean("activeColor", false);
        }

        static int css(String s, int def) {
            try {
                if (s == null || s.isEmpty()) return def;
                if (s.startsWith("#")) return Color.parseColor(s);
                if (s.startsWith("rgba(")) {
                    String[] p = s.substring(5, s.indexOf(')')).split(",");
                    int r = Integer.parseInt(p[0].trim()), g = Integer.parseInt(p[1].trim()), b = Integer.parseInt(p[2].trim());
                    int a = Math.round(Float.parseFloat(p[3].trim()) * 255f);
                    return Color.argb(a, r, g, b);
                }
            } catch (Exception ignored) { }
            return def;
        }

        static CaptionOverlay create(JSONObject cap, int w, int h, long[] ra, long[] rb) {
            try {
                JSONArray pages = cap.optJSONArray("pages");
                JSONObject st = cap.optJSONObject("style");
                if (pages == null || st == null || pages.length() == 0) return null;
                long[] cum = new long[ra.length];
                long run = 0;
                for (int i = 0; i < ra.length; i++) { cum[i] = run; run += rb[i] - ra[i]; }
                List<Long> starts = new ArrayList<>(), ends = new ArrayList<>();
                List<String[]> allWords = new ArrayList<>();
                List<long[]> allStarts = new ArrayList<>();
                for (int pi = 0; pi < pages.length(); pi++) {
                    JSONObject page = pages.getJSONObject(pi);
                    JSONArray wa = page.getJSONArray("words");
                    double pageE = page.getDouble("e");
                    List<String> t = new ArrayList<>();
                    List<Long> s = new ArrayList<>();
                    long lastMappedEnd = -1;
                    double lastWordE = 0;
                    for (int k = 0; k < wa.length(); k++) {
                        JSONObject wo = wa.getJSONObject(k);
                        double sMs = wo.getDouble("s"), eMs = wo.getDouble("e");
                        long m = -1;
                        for (int i = 0; i < ra.length; i++) {
                            if (sMs >= ra[i] && sMs < rb[i]) { m = cum[i] + Math.round(sMs - ra[i]); break; }
                        }
                        if (m < 0) continue;
                        t.add(wo.getString("t"));
                        s.add(m);
                        lastMappedEnd = m + Math.round(Math.max(0, eMs - sMs));
                        lastWordE = eMs;
                    }
                    if (t.isEmpty()) continue;
                    long pad = Math.round(Math.max(0, pageE - lastWordE));
                    long[] sa = new long[s.size()];
                    for (int k = 0; k < sa.length; k++) sa[k] = s.get(k);
                    starts.add(sa[0]);
                    ends.add(lastMappedEnd + pad);
                    allWords.add(t.toArray(new String[0]));
                    allStarts.add(sa);
                }
                if (starts.isEmpty()) return null;
                long[] ps = new long[starts.size()], pe = new long[starts.size()];
                for (int i = 0; i < ps.length; i++) { ps[i] = starts.get(i); pe[i] = ends.get(i); }
                return new CaptionOverlay(w, h, ps, pe, allWords.toArray(new String[0][]), allStarts.toArray(new long[0][]), st);
            } catch (Exception e) {
                return null;
            }
        }

        @Override
        public Bitmap getBitmap(long presentationTimeUs) throws VideoFrameProcessingException {
            long tc = presentationTimeUs / 1000;
            int pi = -1;
            for (int i = 0; i < ps.length; i++) { if (tc >= ps[i] && tc < pe[i]) { pi = i; break; } }
            int wi = -1;
            if (pi >= 0) { for (int k = 0; k < ws[pi].length; k++) { if (tc >= ws[pi][k]) wi = k; } }
            int key = pi < 0 ? -1 : pi * 64 + (wi + 1);
            if (key == lastKey && lastBmp != null) return lastBmp;
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            if (pi >= 0) drawPage(new Canvas(bmp), pi, wi);
            lastKey = key;
            lastBmp = bmp;
            return bmp;
        }

        private void drawPage(Canvas c, int pi, int active) {
            String[] t = words[pi];
            float fs = (float) Math.max(8, size * h);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setTypeface(Typeface.create(Typeface.SANS_SERIF, weight >= 700 ? Typeface.BOLD : Typeface.NORMAL));
            p.setStrokeJoin(Paint.Join.ROUND);
            float gap = fs * 0.28f;
            float[] wd = new float[t.length];
            float total = 0;
            for (int i = 0; i < t.length; i++) {
                p.setTextSize(fs * (i == active ? (float) activeScale : 1f));
                wd[i] = p.measureText(t[i]);
                total += wd[i];
            }
            total += gap * (t.length - 1);
            float k = 1f;
            float maxW = w * 0.9f;
            if (total > maxW) k = maxW / total;
            total *= k;
            float cy = (float) (y * h);
            float x = (w - total) / 2f;
            if (hasBox) {
                float padX = fs * 0.45f, padY = fs * 0.3f, r = fs * 0.3f;
                float top = cy - fs * 0.62f - padY;
                RectF rf = new RectF(x - padX, top, x + total + padX, top + fs * 1.24f + padY * 2f);
                p.setStyle(Paint.Style.FILL);
                p.setColor(boxColor);
                c.drawRoundRect(rf, r, r, p);
            }
            for (int i = 0; i < t.length; i++) {
                boolean on = i == active;
                float sc = (on ? (float) activeScale : 1f) * k;
                p.setTextSize(fs * sc);
                float tw = wd[i] * k;
                float base = cy + fs * 0.34f;
                if (stroke > 0) {
                    p.clearShadowLayer();
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth((float) (fs * stroke));
                    p.setColor(strokeColor);
                    c.drawText(t[i], x, base, p);
                }
                p.setStyle(Paint.Style.FILL);
                if (shadow) p.setShadowLayer(fs * 0.25f, 0f, fs * 0.06f, 0xBF000000); else p.clearShadowLayer();
                p.setColor(activeColor && on ? highlight : color);
                c.drawText(t[i], x, base, p);
                p.clearShadowLayer();
                x += tw + gap * k;
            }
        }
    }

    private static class Seg {
        long start, end;
        String style, main, corner, size;
        /** Own crop of this clip; null = use the project crop. */
        CropSpec cropHost, cropConst;
    }

    /** Pan/zoom of one video inside its frame. zoom 1 = no crop. x,y in -1..1 move the picture. */
    private static class CropSpec {
        float zoom = 1f, x = 0f, y = 0f, rotate = 0f, ratio = 0f, frameRatio = 0f, px = 0f, py = 0f, ps = 1f;
    }

    private static CropSpec readCrop(JSONObject o) {
        CropSpec c = new CropSpec();
        if (o == null) return c;
        c.zoom = (float) o.optDouble("zoom", 1.0);
        c.x = (float) o.optDouble("x", 0.0);
        c.y = (float) o.optDouble("y", 0.0);
        c.rotate = (float) o.optDouble("rotate", 0.0);
        c.px = (float) o.optDouble("px", 0.0);
        c.py = (float) o.optDouble("py", 0.0);
        c.ps = (float) Math.max(0.2, Math.min(6.0, o.optDouble("ps", 1.0)));
        c.frameRatio = (float) o.optDouble("frameRatio", 0.0);
        String ratio = o.optString("ratio", "custom");
        if (!"custom".equals(ratio)) {
            String[] parts = ratio.split(":");
            if (parts.length == 2) {
                try {
                    float rw = Float.parseFloat(parts[0]), rh = Float.parseFloat(parts[1]);
                    if (rw > 0f && rh > 0f) c.ratio = rw / rh;
                } catch (NumberFormatException ignored) { /* use the output frame ratio */ }
            }
        }
        return c;
    }

    /** A kept part of the timeline, in Host time. Parts removed by silence cut are not in the list. */
    private static class Range {
        long a, b;
        CropSpec cropHost, cropConst;
    }

    private static boolean sameCrop(CropSpec p, CropSpec q) {
        if (p == q) return true;
        if (p == null || q == null) return false;
        return Math.abs(p.zoom - q.zoom) < 0.0005f && Math.abs(p.x - q.x) < 0.0005f && Math.abs(p.y - q.y) < 0.0005f
                && Math.abs(p.rotate - q.rotate) < 0.0005f && Math.abs(p.px - q.px) < 0.0005f && Math.abs(p.py - q.py) < 0.0005f && Math.abs(p.ps - q.ps) < 0.0005f && Math.abs(p.ratio - q.ratio) < 0.0005f && Math.abs(p.frameRatio - q.frameRatio) < 0.0005f;
    }

    // ------------------------------------------------------------------ YouTube (optional module, see YouTubeBridge)

    private final java.util.concurrent.ExecutorService ytPool = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** True only in builds made with EDITORR_YOUTUBE=1. */
    @PluginMethod
    public void youtubeEnabled(PluginCall call) {
        JSObject o = new JSObject();
        o.put("enabled", YouTubeBridge.ENABLED);
        call.resolve(o);
    }

    @PluginMethod
    public void youtubeSearch(PluginCall call) {
        final String q = call.getString("query");
        final boolean cc = call.getBoolean("ccOnly", true);
        if (q == null || q.trim().isEmpty()) { call.reject("Type a song name."); return; }
        ytPool.execute(() -> {
            try {
                JSONArray items = YouTubeBridge.search(q.trim(), cc);
                JSObject o = new JSObject();
                o.put("items", items);
                call.resolve(o);
            } catch (Exception e) {
                call.reject("YouTube search failed: " + (e.getMessage() != null ? e.getMessage() : "unknown error"));
            }
        });
    }

    /** Downloads the audio of one video into the app music folder. Emits 'ytProgress' {id, percent}. */
    @PluginMethod
    public void youtubeDownload(PluginCall call) {
        final String id = call.getString("id");
        if (id == null || id.isEmpty()) { call.reject("No video chosen."); return; }
        final File dir = new File(getContext().getFilesDir(), "music");
        ytPool.execute(() -> {
            try {
                JSONObject r = YouTubeBridge.download(id, dir, pct -> {
                    JSObject ev = new JSObject();
                    ev.put("id", id);
                    ev.put("percent", pct);
                    notifyListeners("ytProgress", ev);
                });
                JSObject o = new JSObject();
                o.put("path", r.optString("path"));
                o.put("title", r.optString("title"));
                o.put("durationMs", r.optLong("durationMs", 0));
                call.resolve(o);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed.");
            }
        });
    }

    @PluginMethod
    public void youtubeCancel(PluginCall call) {
        YouTubeBridge.cancel();
        call.resolve();
    }

    /** Saves a chunk of a file (base64) in the app files folder. Used for the baked music track. */
    @PluginMethod
    public void writeBytes(PluginCall call) {
        try {
            String name = call.getString("name");
            String data = call.getString("data");
            boolean append = call.getBoolean("append", false);
            if (name == null || name.isEmpty() || name.contains("/") || name.contains("..") || data == null) { call.reject("Bad file name"); return; }
            File dir = new File(getContext().getFilesDir(), "music");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, name);
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            try (FileOutputStream os = new FileOutputStream(f, append)) { os.write(bytes); }
            JSObject o = new JSObject();
            o.put("path", f.getAbsolutePath());
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void exportProject(PluginCall call) {
        try {
            final String hostUri = call.getString("hostUri");
            final String constUri = call.getString("constUri");
            // call.getLong() silently returns the default for non-integer JSON numbers (Double); optLong accepts any number.
            final long offsetMs = call.getData().optLong("offsetMs", 0L);
            long durationRaw = call.getData().optLong("durationMs", 0L);
            final int shortSide = call.getInt("height", 720);
            final int outW = call.getInt("outW", (shortSide * 16 / 9) / 2 * 2);
            final int outH = call.getInt("outH", shortSide);
            final int fps = Math.max(10, Math.min(60, call.getInt("fps", 30)));
            final int shortForRate = Math.min(outW, outH);
            final int defBitrate = (shortForRate >= 2160 ? 40 : shortForRate >= 1440 ? 22 : shortForRate >= 1080 ? 10 : shortForRate >= 720 ? 6 : 3) * 1_000_000;
            final int bitrate = Math.max(1_000_000, Math.min(100_000_000, call.getInt("bitrate", defBitrate)));
            final CropSpec cropHost = readCrop(call.getObject("cropHost"));
            final CropSpec cropConst = readCrop(call.getObject("cropConst"));
            final boolean mirrorHost = call.getBoolean("mirrorHost", false);
            final boolean mirrorConst = call.getBoolean("mirrorConst", false);
            final boolean hostAudio = "host".equals(call.getString("mainAudio", "host"));
            final String cleanAudioUri = call.getString("cleanAudioUri");
            final JSONObject captionsJson = call.getData().optJSONObject("captions");
            final String bgmUri = call.getString("bgmUri");
            final float gain = (float) Math.max(0.0, Math.min(10.0, call.getDouble("gain", 1.0)));
            final List<Seg> segs = new ArrayList<>();
            JSArray arr = call.getArray("segments");
            for (int i = 0; arr != null && i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Seg s = new Seg();
                s.start = Math.round(o.getDouble("startMs")); s.end = Math.round(o.getDouble("endMs"));
                s.style = o.optString("style", "one"); s.main = o.optString("main", "host");
                s.corner = o.optString("corner", "br"); s.size = o.optString("size", "M");
                JSONObject ch = o.optJSONObject("cropHost"), cc = o.optJSONObject("cropConst");
                s.cropHost = ch == null ? cropHost : readCrop(ch);
                s.cropConst = cc == null ? cropConst : readCrop(cc);
                segs.add(s);
            }
            // A missing/zero duration must never cut everything: fall back to the end of the last segment.
            if (durationRaw <= 0) { for (Seg s : segs) durationRaw = Math.max(durationRaw, s.end); }
            final long durationMs = durationRaw;
            cancelProxyJobs();
            exportHandler().post(() ->
                    startTransformer(call, hostUri, constUri, cleanAudioUri, captionsJson, bgmUri, offsetMs, durationMs, outW, outH, hostAudio, segs, cropHost, cropConst, mirrorHost, mirrorConst, gain, fps, bitrate));
        } catch (JSONException e) {
            call.reject("Bad export request: " + e.getMessage());
        }
    }

    private void startTransformer(PluginCall call, String hostUri, String constUri, String cleanAudioUri, JSONObject captionsJson, String bgmUri, long offsetMs, long durationMs,
                                  int outW, int outH, boolean hostAudio, List<Seg> segs,
                                  CropSpec cropHost, CropSpec cropConst, boolean mirrorHost, boolean mirrorConst,
                                  float gain, int fps, int bitrate) {
        try {
            // Timeline time = Host time. The Constant video is offsetMs ahead of it.
            final long hostStart = Math.max(0, -offsetMs);

            // Kept parts (silence cut leaves gaps). Touching segments are joined into one part.
            final List<Range> ranges = new ArrayList<>();
            for (Seg s : segs) {
                long a = Math.max(s.start, hostStart);
                long b = Math.min(s.end, durationMs);
                if (b - a < 100) continue;
                // a clip with its own crop keeps its own part, so every clip is cropped like in the preview
                CropSpec segHost = s.cropHost != null ? s.cropHost : cropHost;
                CropSpec segConst = s.cropConst != null ? s.cropConst : cropConst;
                Range last = ranges.isEmpty() ? null : ranges.get(ranges.size() - 1);
                if (last != null && a - last.b <= 1 && sameCrop(last.cropHost, segHost) && sameCrop(last.cropConst, segConst)) last.b = Math.max(last.b, b);
                else { Range r = new Range(); r.a = a; r.b = b; r.cropHost = segHost; r.cropConst = segConst; ranges.add(r); }
            }
            if (ranges.isEmpty() && segs.isEmpty() && durationMs - hostStart >= 100) {
                // no layout segments arrived: export the whole overlap as one part
                Range r = new Range(); r.a = hostStart; r.b = durationMs; r.cropHost = cropHost; r.cropConst = cropConst; ranges.add(r);
                Seg whole = new Seg(); whole.start = hostStart; whole.end = durationMs;
                whole.style = "one"; whole.main = hostAudio ? "host" : "constant"; whole.corner = "br"; whole.size = "M";
                segs.add(whole);
            }
            if (ranges.isEmpty()) {
                call.reject("Nothing to export. Every part was cut. (segments=" + segs.size() + ", length=" + durationMs + " ms, offset=" + offsetMs + " ms)");
                return;
            }

            // composition start of each kept part, so the layout lookup can map output time back to Host time
            final long[] cumStart = new long[ranges.size()];
            long run = 0;
            for (int i = 0; i < ranges.size(); i++) { cumStart[i] = run; run += ranges.get(i).b - ranges.get(i).a; }

            // burned-in captions (null when the project has none)
            final long[] capRa = new long[ranges.size()];
            final long[] capRb = new long[ranges.size()];
            for (int i = 0; i < ranges.size(); i++) { capRa[i] = ranges.get(i).a; capRb[i] = ranges.get(i).b; }
            final CaptionOverlay captionOverlay = captionsJson == null ? null : CaptionOverlay.create(captionsJson, outW, outH, capRa, capRb);

            List<EditedMediaItem> hostItems = new ArrayList<>();
            List<EditedMediaItem> constItems = new ArrayList<>();
            List<EditedMediaItem> cleanAudioItems = new ArrayList<>();
            for (Range r : ranges) {
                boolean useCleanTrack = cleanAudioUri != null && !cleanAudioUri.isEmpty();
                hostItems.add(item(hostUri, r.a, r.b - r.a, outW, outH, useCleanTrack || !hostAudio, mirrorHost, r.cropHost, hostAudio ? gain : 1f));
                constItems.add(item(constUri, r.a + offsetMs, r.b - r.a, outW, outH, useCleanTrack || hostAudio, mirrorConst, r.cropConst, hostAudio ? 1f : gain));
                if (useCleanTrack) {
                    long audioStart = hostAudio ? r.a : r.a + offsetMs;
                    cleanAudioItems.add(audioItem(cleanAudioUri, audioStart, r.b - r.a, gain));
                }
            }

            EditedMediaItemSequence hostSeq = new EditedMediaItemSequence.Builder(hostItems.toArray(new EditedMediaItem[0])).build();
            EditedMediaItemSequence constSeq = new EditedMediaItemSequence.Builder(constItems.toArray(new EditedMediaItem[0])).build();
            EditedMediaItemSequence cleanAudioSeq = cleanAudioItems.isEmpty() ? null
                    : new EditedMediaItemSequence.Builder(cleanAudioItems.toArray(new EditedMediaItem[0])).build();

            VideoCompositorSettings settings = new VideoCompositorSettings() {
                @Override public Size getOutputSize(List<Size> inputSizes) { return new Size(outW, outH); }
                @Override public OverlaySettings getOverlaySettings(int inputId, long presentationTimeUs) {
                    long tc = presentationTimeUs / 1000;
                    int idx = 0;
                    for (int i = 0; i < cumStart.length; i++) { if (tc >= cumStart[i]) idx = i; else break; }
                    long hostT = ranges.get(idx).a + (tc - cumStart[idx]);
                    return overlayFor(segs, hostT, inputId == 0);
                }
            };

            // Frame rate: drop frames to the chosen rate (never invents frames, so it also lowers the work per second).
            // background music / sound effects: one baked track at timeline time, cut per kept part like the clean audio
            List<EditedMediaItem> bgmItems = new ArrayList<>();
            if (bgmUri != null && !bgmUri.isEmpty()) {
                for (Range r : ranges) bgmItems.add(audioItem(bgmUri, r.a, r.b - r.a, 1f));
            }
            List<EditedMediaItemSequence> seqList = new ArrayList<>();
            seqList.add(hostSeq);
            seqList.add(constSeq);
            if (cleanAudioSeq != null) seqList.add(cleanAudioSeq);
            if (!bgmItems.isEmpty()) seqList.add(new EditedMediaItemSequence.Builder(bgmItems.toArray(new EditedMediaItem[0])).build());
            ImmutableList<EditedMediaItemSequence> sequences = ImmutableList.copyOf(seqList);
            Composition composition = new Composition.Builder(sequences)
                    .setVideoCompositorSettings(settings)
                    .setEffects(new Effects(
                            ImmutableList.<AudioProcessor>of(),
                            captionOverlay == null
                                    ? ImmutableList.<Effect>of(FrameDropEffect.createDefaultFrameDropEffect(fps))
                                    : ImmutableList.<Effect>of(
                                            new OverlayEffect(ImmutableList.<TextureOverlay>of(captionOverlay)),
                                            FrameDropEffect.createDefaultFrameDropEffect(fps))))
                    .build();

            // Hardware H.264 encoder with the chosen bitrate. Fallback lets the phone pick the nearest size it supports (big 2K/4K).
            DefaultEncoderFactory encoderFactory = new DefaultEncoderFactory.Builder(getContext())
                    .setRequestedVideoEncoderSettings(new VideoEncoderSettings.Builder()
                            .setBitrate(bitrate)
                            .setiFrameIntervalSeconds(1f)
                            .build())
                    .setEnableFallback(true)
                    .build();

            // Like CapCut: keep the screen awake so the export is not paused when the screen turns off.
            setKeepAwake(true);

            File out = new File(getContext().getCacheDir(), "editorr/export_" + System.currentTimeMillis() + ".mp4");
            out.getParentFile().mkdirs();

            transformer = new Transformer.Builder(getContext())
                    .setLooper(exportHandler().getLooper())
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(encoderFactory)
                    .addListener(new Transformer.Listener() {
                        @Override public void onCompleted(@NonNull Composition c, @NonNull ExportResult r) {
                            stopPolling();
                            setKeepAwake(false);
                            new Thread(() -> {
                                try {
                                    Uri saved = saveToGallery(out);
                                    JSObject o = new JSObject();
                                    o.put("outputUri", saved.toString());
                                    call.resolve(o);
                                } catch (Exception e) {
                                    call.reject("Saved the video but could not add it to the gallery: " + e.getMessage());
                                } finally {
                                    deleteDenoiseUri(cleanAudioUri);
                                }
                            }).start();
                        }
                        @Override public void onError(@NonNull Composition c, @NonNull ExportResult r, @NonNull ExportException e) {
                            stopPolling();
                            setKeepAwake(false);
                            deleteDenoiseUri(cleanAudioUri);
                            call.reject("Export failed: " + e.getMessage());
                        }
                    })
                    .build();
            transformer.start(composition, out.getAbsolutePath());
            startPolling();
        } catch (Exception e) {
            setKeepAwake(false);
            deleteDenoiseUri(cleanAudioUri);
            call.reject("Export failed to start: " + e.getMessage());
        }
    }

    private EditedMediaItem item(String uri, long startMs, long totalMs, int w, int h, boolean removeAudio, boolean mirror, CropSpec crop, float gain) {
        MediaItem mi = new MediaItem.Builder()
                .setUri(uri)
                .setClippingConfiguration(new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs)
                        .setEndPositionMs(startMs + totalMs)
                        .build())
                .build();
        ImmutableList.Builder<Effect> video = new ImmutableList.Builder<>();
        video.add(Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
        if (mirror) {
            video.add(new ScaleAndRotateTransformation.Builder()
                    .setScale(-1f, 1f)
                    .build());
        }
        float aspect = (float) w / Math.max(1, h);
        float angle = crop == null ? 0f : crop.rotate;
        float cover = rotationCoverZoom(angle, aspect);
        if (crop != null && (Math.abs(angle) > 0.001f || cover > 1.001f)) {
            // UI positive angles are clockwise; Media3 rotation degrees are counter-clockwise.
            video.add(new ScaleAndRotateTransformation.Builder()
                    .setScale(cover, cover)
                    .setRotationDegrees(-angle)
                    .build());
        }
        if (crop != null) {
            // Same math as the preview: uniform scale without stretching distortion.
            float zoom = Math.max(0.2f, Math.min(6.0f, crop.zoom));
            if (Math.abs(zoom - 1f) > 0.001f || Math.abs(crop.x) > 0.001f || Math.abs(crop.y) > 0.001f) {
                float half = 1f / zoom;
                float cx = -crop.x * (zoom > 1f ? (1f - half) : 1f);
                float cy = crop.y * (zoom > 1f ? (1f - half) : 1f); // picture moves down -> window moves up (NDC y is up)
                video.add(new Crop(cx - half, cx + half, cy - half, cy + half));
                video.add(Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
            }
        }
        return new EditedMediaItem.Builder(mi)
                .setRemoveAudio(removeAudio)
                .setEffects(new Effects(
                        (removeAudio || Math.abs(gain - 1f) < 0.005f) ? ImmutableList.<AudioProcessor>of() : ImmutableList.<AudioProcessor>of(new GainProcessor(gain)),
                        video.build()))
                .build();
    }

    private EditedMediaItem audioItem(String uri, long startMs, long totalMs, float gain) {
        MediaItem mi = new MediaItem.Builder()
                .setUri(uri)
                .setClippingConfiguration(new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs)
                        .setEndPositionMs(startMs + totalMs)
                        .build())
                .build();
        return new EditedMediaItem.Builder(mi)
                .setEffects(new Effects(
                        Math.abs(gain - 1f) < 0.005f ? ImmutableList.<AudioProcessor>of() : ImmutableList.<AudioProcessor>of(new GainProcessor(gain)),
                        ImmutableList.<Effect>of()))
                .build();
    }

    private void deleteDenoiseUri(String uri) {
        if (uri == null) return;
        try {
            File f = new File(stripFileScheme(uri));
            if (f.getCanonicalPath().startsWith(cacheDir().getCanonicalPath() + File.separator)) f.delete();
        } catch (Exception ignored) { }
    }

    /** Extra uniform zoom needed to keep a rotated frame covering its unrotated viewport. */
    private static float rotationCoverZoom(float degrees, float aspect) {
        double radians = Math.toRadians(Math.abs(degrees));
        float c = (float) Math.abs(Math.cos(radians));
        float s = (float) Math.abs(Math.sin(radians));
        return Math.max(c + s / aspect, c + s * aspect);
    }

    /** Volume gain for 16-bit or float PCM, with a soft clip so a big boost (up to 10x) does not hard-distort. */
    private static final class GainProcessor extends BaseAudioProcessor {
        private final float gain;
        GainProcessor(float gain) { this.gain = gain; }

        @Override
        protected AudioProcessor.AudioFormat onConfigure(AudioProcessor.AudioFormat in) throws AudioProcessor.UnhandledAudioFormatException {
            if (in.encoding != C.ENCODING_PCM_16BIT && in.encoding != C.ENCODING_PCM_FLOAT) throw new AudioProcessor.UnhandledAudioFormatException(in);
            return in;
        }

        private static float soft(float x) {
            float a = Math.abs(x);
            if (a <= 0.8f) return x;
            float y = 0.8f + 0.2f * (float) Math.tanh((a - 0.8f) / 0.2f);
            return x < 0 ? -y : y;
        }

        @Override
        public void queueInput(ByteBuffer input) {
            int n = input.remaining();
            if (n == 0) return;
            ByteBuffer out = replaceOutputBuffer(n);
            if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT) {
                while (input.remaining() >= 2) out.putShort((short) Math.round(soft(input.getShort() / 32768f * gain) * 32767f));
            } else {
                while (input.remaining() >= 4) out.putFloat(soft(input.getFloat() * gain));
            }
            out.flip();
        }
    }

    /** Layout math. inputId 0 = Host (bottom), 1 = Constant (top). Both are pre-scaled to the output frame. */
    private static OverlaySettings overlayFor(List<Seg> segs, long tMs, boolean isHost) {
        Seg s = segs.get(segs.size() - 1);
        for (Seg x : segs) if (tMs >= x.start && tMs < x.end) { s = x; break; }
        StaticOverlaySettings.Builder b = new StaticOverlaySettings.Builder();
        boolean mainIsHost = "host".equals(s.main);
        // free placement of this clip (move in slot sizes, extra size)
        CropSpec fc = isHost ? s.cropHost : s.cropConst;
        float fpx = fc == null ? 0f : fc.px, fpy = fc == null ? 0f : fc.py, fps = fc == null ? 1f : fc.ps;
        boolean placed = Math.abs(fpx) > 0.001f || Math.abs(fpy) > 0.001f || Math.abs(fps - 1f) > 0.001f;
        switch (s.style) {
            case "side":
                // uniform scale 0.5 (letterboxed in each half). TODO: crop shader for true 50/50 fill.
                b.setScale(0.5f * fps, 0.5f * fps).setBackgroundFrameAnchor((isHost ? -0.5f : 0.5f) + fpx, -2f * fpy);
                break;
            case "updown":
                b.setScale(0.5f * fps, 0.5f * fps).setBackgroundFrameAnchor(2f * fpx, (isHost ? 0.5f : -0.5f) - fpy);
                break;
            case "popup": {
                boolean isMain = isHost == mainIsHost;
                if (isMain) {
                    if (placed) b.setScale(fps, fps).setBackgroundFrameAnchor(2f * fpx, -2f * fpy);
                    break; // full frame
                }
                float sc = "S".equals(s.size) ? 0.24f : "L".equals(s.size) ? 0.42f : 0.32f;
                float ax = (s.corner.endsWith("l") ? -1f : 1f);
                float ay = (s.corner.startsWith("t") ? 1f : -1f);
                b.setScale(sc * fps, sc * fps)
                 .setOverlayFrameAnchor(ax, ay)
                 .setBackgroundFrameAnchor(ax * 0.94f + 2f * fpx * sc, ay * 0.90f - 2f * fpy * sc);
                break;
            }
            default: { // one-to-one
                boolean isMain = isHost == mainIsHost;
                if (!isMain) b.setAlphaScale(0f);
                else if (placed) b.setScale(fps, fps).setBackgroundFrameAnchor(2f * fpx, -2f * fpy);
            }
        }
        return b.build();
    }

    private void startPolling() {
        final ProgressHolder holder = new ProgressHolder();
        final int[] last = { -1 };
        progressPoll = new Runnable() {
            @Override public void run() {
                if (transformer == null) return;
                if (transformer.getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) {
                    int tenth = Math.round(holder.progress * 10f);
                    if (tenth != last[0]) { // only talk to the WebView when the number changed: keeps the UI thread free for the encoder
                        last[0] = tenth;
                        JSObject o = new JSObject();
                        o.put("percent", holder.progress);
                        notifyListeners("exportProgress", o);
                    }
                }
                exportHandler().postDelayed(this, 1000);
            }
        };
        exportHandler().post(progressPoll);
    }

    private void setKeepAwake(boolean on) {
        try {
            getActivity().runOnUiThread(() -> {
                if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        } catch (Exception ignored) { }
    }

    private void stopPolling() {
        if (progressPoll != null) exportHandler().removeCallbacks(progressPoll);
        progressPoll = null;
    }

    @PluginMethod
    public void cancelExport(PluginCall call) {
        cancelDenoise = true;
        Thread job = denoiseThread;
        if (job != null) job.interrupt();
        exportHandler().post(() -> {
            if (transformer != null) transformer.cancel();
            stopPolling();
            setKeepAwake(false);
            call.resolve();
        });
    }

    /** A content:// uri other apps can read. Old devices (< Android 10) hand back file:// paths, which cannot be shared. */
    private Uri shareableUri(Uri uri) {
        if (!"file".equals(uri.getScheme())) return uri;
        try (Cursor c = getContext().getContentResolver().query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.Video.Media._ID}, MediaStore.Video.Media.DATA + "=?", new String[]{uri.getPath()}, null)) {
            if (c != null && c.moveToFirst()) return android.content.ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, c.getLong(0));
        } catch (Exception ignored) { }
        return uri;
    }

    @PluginMethod
    public void shareVideo(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null) { call.reject("No video to share."); return; }
        try {
            Uri uri = shareableUri(Uri.parse(raw));
            JSArray arr = call.getArray("pkgs");
            java.util.List<String> pkgs = new java.util.ArrayList<>();
            if (arr != null) for (int i = 0; i < arr.length(); i++) pkgs.add(arr.getString(i));
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("video/mp4");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("video", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Activity act = getActivity();
            if (pkgs.isEmpty()) {
                Intent chooser = Intent.createChooser(send, "Share video");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                act.startActivity(chooser);
                call.resolve();
                return;
            }
            for (String pkg : pkgs) {
                try {
                    Intent i = new Intent(send);
                    i.setPackage(pkg);
                    act.startActivity(i);
                    call.resolve();
                    return;
                } catch (android.content.ActivityNotFoundException ignored) { /* try the next package */ }
            }
            call.reject("not_installed");
        } catch (Exception e) {
            call.reject("Could not share: " + e.getMessage());
        }
    }

    @PluginMethod
    public void viewVideo(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null) { call.reject("No video."); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(shareableUri(Uri.parse(raw)), "video/mp4");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can open this video.");
        }
    }

    private Uri saveToGallery(File file) throws Exception {
        String name = "Editorr_" + System.currentTimeMillis() + ".mp4";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Video.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Editorr");
            Uri uri = getContext().getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            try (InputStream in = new java.io.FileInputStream(file);
                 OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            file.delete();
            return uri;
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "Editorr");
            dir.mkdirs();
            File dest = new File(dir, name);
            try (InputStream in = new java.io.FileInputStream(file); OutputStream os = new FileOutputStream(dest)) {
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            file.delete();
            MediaScannerConnection.scanFile(getContext(), new String[]{dest.getAbsolutePath()}, new String[]{"video/mp4"}, null);
            return Uri.fromFile(dest);
        }
    }
}
