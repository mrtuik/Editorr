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
import android.os.Looper;
import android.os.StatFs;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.graphics.Bitmap;

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
        new File(cacheDir(), "proxy_" + name + ".mp4").delete();
        new File(cacheDir(), "proxy_" + name + ".mp4.tmp").delete();
        File[] cached = cacheDir().listFiles();
        if (cached != null) for (File c : cached) if (c.getName().startsWith("thumb_" + name + "_")) c.delete();
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
            o.put("videosBytes", dirSize(videoDir()));
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

                File outFile = new File(getContext().getCacheDir(), "editorr/" + new File(path).getName() + ".pcm16k");
                outFile.getParentFile().mkdirs();
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
                JSObject o = new JSObject();
                o.put("pcmPath", outFile.getAbsolutePath());
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
                final File out = new File(cacheDir(), "proxy_" + new File(path).getName() + ".mp4");
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
                                proxyJobs.remove(path);
                                if (tmp.renameTo(out)) {
                                    JSObject o = new JSObject();
                                    o.put("proxyPath", out.getAbsolutePath());
                                    call.resolve(o);
                                } else call.reject("Could not save the preview copy.");
                            }
                            @Override public void onError(@NonNull Composition c, @NonNull ExportResult r, @NonNull ExportException e) {
                                main.removeCallbacks(poll[0]);
                                proxyJobs.remove(path);
                                tmp.delete();
                                call.reject("Preview copy failed: " + e.getMessage());
                            }
                        })
                        .build();
                proxyJobs.put(path, self[0]);
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
                proxyJobs.remove(path);
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
                    File f = new File(cacheDir(), "thumb_" + base + "_" + count + "_" + i + ".jpg");
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

    private static class Seg {
        long start, end;
        String style, main, corner, size;
    }

    /** Pan/zoom of one video inside its frame. zoom 1 = no crop. x,y in -1..1 move the picture. */
    private static class CropSpec {
        float zoom = 1f, x = 0f, y = 0f, rotate = 0f, ratio = 0f, frameRatio = 0f;
    }

    private static CropSpec readCrop(JSObject o) {
        CropSpec c = new CropSpec();
        if (o == null) return c;
        c.zoom = (float) o.optDouble("zoom", 1.0);
        c.x = (float) o.optDouble("x", 0.0);
        c.y = (float) o.optDouble("y", 0.0);
        c.rotate = (float) o.optDouble("rotate", 0.0);
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
    }

    @PluginMethod
    public void exportProject(PluginCall call) {
        try {
            final String hostUri = call.getString("hostUri");
            final String constUri = call.getString("constUri");
            final long offsetMs = call.getLong("offsetMs", 0L);
            final long durationMs = call.getLong("durationMs", 0L);
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
            final float gain = (float) Math.max(0.0, Math.min(10.0, call.getDouble("gain", 1.0)));
            final List<Seg> segs = new ArrayList<>();
            JSArray arr = call.getArray("segments");
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Seg s = new Seg();
                s.start = o.getLong("startMs"); s.end = o.getLong("endMs");
                s.style = o.getString("style"); s.main = o.getString("main");
                s.corner = o.getString("corner"); s.size = o.getString("size");
                segs.add(s);
            }
            getActivity().runOnUiThread(() ->
                    startTransformer(call, hostUri, constUri, cleanAudioUri, offsetMs, durationMs, outW, outH, hostAudio, segs, cropHost, cropConst, mirrorHost, mirrorConst, gain, fps, bitrate));
        } catch (JSONException e) {
            call.reject("Bad export request: " + e.getMessage());
        }
    }

    private void startTransformer(PluginCall call, String hostUri, String constUri, String cleanAudioUri, long offsetMs, long durationMs,
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
                Range last = ranges.isEmpty() ? null : ranges.get(ranges.size() - 1);
                if (last != null && a - last.b <= 1) last.b = Math.max(last.b, b);
                else { Range r = new Range(); r.a = a; r.b = b; ranges.add(r); }
            }
            if (ranges.isEmpty()) { call.reject("Nothing to export. Every part was cut."); return; }

            // composition start of each kept part, so the layout lookup can map output time back to Host time
            final long[] cumStart = new long[ranges.size()];
            long run = 0;
            for (int i = 0; i < ranges.size(); i++) { cumStart[i] = run; run += ranges.get(i).b - ranges.get(i).a; }

            List<EditedMediaItem> hostItems = new ArrayList<>();
            List<EditedMediaItem> constItems = new ArrayList<>();
            List<EditedMediaItem> cleanAudioItems = new ArrayList<>();
            for (Range r : ranges) {
                boolean useCleanTrack = cleanAudioUri != null && !cleanAudioUri.isEmpty();
                hostItems.add(item(hostUri, r.a, r.b - r.a, outW, outH, useCleanTrack || !hostAudio, mirrorHost, cropHost, hostAudio ? gain : 1f));
                constItems.add(item(constUri, r.a + offsetMs, r.b - r.a, outW, outH, useCleanTrack || hostAudio, mirrorConst, cropConst, hostAudio ? 1f : gain));
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
            ImmutableList<EditedMediaItemSequence> sequences = cleanAudioSeq == null
                    ? ImmutableList.of(hostSeq, constSeq)
                    : ImmutableList.of(hostSeq, constSeq, cleanAudioSeq);
            Composition composition = new Composition.Builder(sequences)
                    .setVideoCompositorSettings(settings)
                    .setEffects(new Effects(
                            ImmutableList.<AudioProcessor>of(),
                            ImmutableList.<Effect>of(FrameDropEffect.createDefaultFrameDropEffect(fps))))
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
            // Same math as the preview: the visible window is 1/zoom of the frame, moved by x,y.
            float zoomX = Math.max(1f, crop.zoom);
            float ratio = crop.ratio > 0f ? crop.ratio : crop.frameRatio > 0f ? crop.frameRatio : aspect;
            float zoomY = Math.max(1f, zoomX * ratio / aspect);
            if (zoomX > 1.001f || zoomY > 1.001f) {
                float halfX = 1f / zoomX, halfY = 1f / zoomY;
                float cx = -crop.x * (1f - halfX);
                float cy = crop.y * (1f - halfY); // picture moves down -> window moves up (NDC y is up)
                video.add(new Crop(cx - halfX, cx + halfX, cy - halfY, cy + halfY));
                video.add(Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_STRETCH_TO_FIT));
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
        switch (s.style) {
            case "side":
                // uniform scale 0.5 (letterboxed in each half). TODO: crop shader for true 50/50 fill.
                b.setScale(0.5f, 0.5f).setBackgroundFrameAnchor(isHost ? -0.5f : 0.5f, 0f);
                break;
            case "updown":
                b.setScale(0.5f, 0.5f).setBackgroundFrameAnchor(0f, isHost ? 0.5f : -0.5f);
                break;
            case "popup": {
                boolean isMain = isHost == mainIsHost;
                if (isMain) break; // full frame
                float sc = "S".equals(s.size) ? 0.24f : "L".equals(s.size) ? 0.42f : 0.32f;
                float ax = (s.corner.endsWith("l") ? -1f : 1f);
                float ay = (s.corner.startsWith("t") ? 1f : -1f);
                b.setScale(sc, sc)
                 .setOverlayFrameAnchor(ax, ay)
                 .setBackgroundFrameAnchor(ax * 0.94f, ay * 0.90f);
                break;
            }
            default: { // one-to-one
                boolean isMain = isHost == mainIsHost;
                if (!isMain) b.setAlphaScale(0f);
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
                main.postDelayed(this, 1000);
            }
        };
        main.post(progressPoll);
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
        if (progressPoll != null) main.removeCallbacks(progressPoll);
        progressPoll = null;
    }

    @PluginMethod
    public void cancelExport(PluginCall call) {
        cancelDenoise = true;
        Thread job = denoiseThread;
        if (job != null) job.interrupt();
        getActivity().runOnUiThread(() -> {
            if (transformer != null) transformer.cancel();
            stopPolling();
            setKeepAwake(false);
            call.resolve();
        });
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
