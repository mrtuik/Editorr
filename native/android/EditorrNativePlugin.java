package com.tuik.editorr;

import android.app.Activity;
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

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.Size;
import androidx.media3.common.OverlaySettings;
import androidx.media3.common.VideoCompositorSettings;
import androidx.media3.effect.StaticOverlaySettings;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
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
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
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
    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable progressPoll;

    // ------------------------------------------------------------------ pick

    @PluginMethod
    public void pickVideo(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("video/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(call, Intent.createChooser(i, "Pick video"), "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Cancelled");
            return;
        }
        final Uri uri = result.getData().getData();
        new Thread(() -> {
            try {
                String name = displayName(uri);
                File dir = new File(getContext().getCacheDir(), "editorr");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, System.currentTimeMillis() + "_" + name.replaceAll("[^A-Za-z0-9._-]", "_"));
                try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                     OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                MediaMetadataRetriever r = new MediaMetadataRetriever();
                r.setDataSource(out.getAbsolutePath());
                long dur = parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                int w = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                int hgt = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                int rot = (int) parseLong(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
                String fpsStr = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE);
                r.release();
                if (rot == 90 || rot == 270) { int t = w; w = hgt; hgt = t; }
                JSObject o = new JSObject();
                o.put("path", out.getAbsolutePath());
                o.put("name", name);
                o.put("durationMs", dur);
                o.put("width", w);
                o.put("height", hgt);
                o.put("fps", fpsStr == null ? 30 : Math.round(Float.parseFloat(fpsStr)));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("Could not read this video: " + e.getMessage());
            }
        }).start();
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
            MediaExtractor ex = new MediaExtractor();
            MediaCodec codec = null;
            try {
                ex.setDataSource(path);
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
                        if (!inDone) {
                            int ii = codec.dequeueInputBuffer(10000);
                            if (ii >= 0) {
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
                        }
                        int oi = codec.dequeueOutputBuffer(info, 10000);
                        if (oi >= 0) {
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
                            codec.releaseOutputBuffer(oi, false);
                            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                        } else if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            MediaFormat of = codec.getOutputFormat();
                            channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                            int newRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                            if (newRate != rate) { rate = newRate; step = rate / (double) TARGET_RATE; }
                            floatPcm = of.containsKey(MediaFormat.KEY_PCM_ENCODING)
                                    && of.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT;
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
                ex.release();
            }
        }).start();
    }

    // ----------------------------------------------------------------- export

    private static class Seg {
        long start, end;
        String style, main, corner, size;
    }

    @PluginMethod
    public void exportProject(PluginCall call) {
        try {
            final String hostUri = call.getString("hostUri");
            final String constUri = call.getString("constUri");
            final long offsetMs = call.getLong("offsetMs", 0L);
            final long durationMs = call.getLong("durationMs", 0L);
            final int outH = call.getInt("height", 720);
            final boolean hostAudio = "host".equals(call.getString("mainAudio", "host"));
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
                    startTransformer(call, hostUri, constUri, offsetMs, durationMs, outH, hostAudio, segs));
        } catch (JSONException e) {
            call.reject("Bad export request: " + e.getMessage());
        }
    }

    private void startTransformer(PluginCall call, String hostUri, String constUri, long offsetMs, long durationMs,
                                  int outH, boolean hostAudio, List<Seg> segs) {
        try {
            final int outW = (outH * 16 / 9) / 2 * 2;
            final long hostStart = Math.max(0, -offsetMs);
            final long constStart = Math.max(0, offsetMs);
            final long total = Math.max(1000, durationMs - hostStart);

            EditedMediaItem host = item(hostUri, hostStart, total, outW, outH, !hostAudio);
            EditedMediaItem cons = item(constUri, constStart, total, outW, outH, hostAudio);

            EditedMediaItemSequence hostSeq = new EditedMediaItemSequence.Builder(host).build();
            EditedMediaItemSequence constSeq = new EditedMediaItemSequence.Builder(cons).build();

            VideoCompositorSettings settings = new VideoCompositorSettings() {
                @Override public Size getOutputSize(List<Size> inputSizes) { return new Size(outW, outH); }
                @Override public OverlaySettings getOverlaySettings(int inputId, long presentationTimeUs) {
                    long t = presentationTimeUs / 1000 + hostStart;
                    return overlayFor(segs, t, inputId == 0);
                }
            };

            Composition composition = new Composition.Builder(ImmutableList.of(hostSeq, constSeq))
                    .setVideoCompositorSettings(settings)
                    .build();

            File out = new File(getContext().getCacheDir(), "editorr/export_" + System.currentTimeMillis() + ".mp4");
            out.getParentFile().mkdirs();

            transformer = new Transformer.Builder(getContext())
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .addListener(new Transformer.Listener() {
                        @Override public void onCompleted(@NonNull Composition c, @NonNull ExportResult r) {
                            stopPolling();
                            new Thread(() -> {
                                try {
                                    Uri saved = saveToGallery(out);
                                    JSObject o = new JSObject();
                                    o.put("outputUri", saved.toString());
                                    call.resolve(o);
                                } catch (Exception e) {
                                    call.reject("Saved the video but could not add it to the gallery: " + e.getMessage());
                                }
                            }).start();
                        }
                        @Override public void onError(@NonNull Composition c, @NonNull ExportResult r, @NonNull ExportException e) {
                            stopPolling();
                            call.reject("Export failed: " + e.getMessage());
                        }
                    })
                    .build();
            transformer.start(composition, out.getAbsolutePath());
            startPolling();
        } catch (Exception e) {
            call.reject("Export failed to start: " + e.getMessage());
        }
    }

    private EditedMediaItem item(String uri, long startMs, long totalMs, int w, int h, boolean removeAudio) {
        MediaItem mi = new MediaItem.Builder()
                .setUri(uri)
                .setClippingConfiguration(new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs)
                        .setEndPositionMs(startMs + totalMs)
                        .build())
                .build();
        ImmutableList<Effect> video = ImmutableList.of(
                Presentation.createForWidthAndHeight(w, h, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
        return new EditedMediaItem.Builder(mi)
                .setRemoveAudio(removeAudio)
                .setEffects(new Effects(ImmutableList.of(), video))
                .build();
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
        progressPoll = new Runnable() {
            @Override public void run() {
                if (transformer == null) return;
                if (transformer.getProgress(holder) != Transformer.PROGRESS_STATE_NOT_STARTED) {
                    JSObject o = new JSObject();
                    o.put("percent", holder.progress);
                    notifyListeners("exportProgress", o);
                }
                main.postDelayed(this, 500);
            }
        };
        main.post(progressPoll);
    }

    private void stopPolling() {
        if (progressPoll != null) main.removeCallbacks(progressPoll);
        progressPoll = null;
    }

    @PluginMethod
    public void cancelExport(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (transformer != null) transformer.cancel();
            stopPolling();
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
                byte[] buf = new byte[1 << 16];
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
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            file.delete();
            MediaScannerConnection.scanFile(getContext(), new String[]{dest.getAbsolutePath()}, new String[]{"video/mp4"}, null);
            return Uri.fromFile(dest);
        }
    }
}
