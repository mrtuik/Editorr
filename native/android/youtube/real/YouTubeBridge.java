package com.tuik.editorr;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Optional YouTube module (pure Java, no extra library, no Kotlin).
 * Search: YouTube Innertube "search" call. Audio: Innertube "player" call as an Android VR / iOS app,
 * which gives a direct audio link; the file is then downloaded in 10 MB range pieces (single big
 * requests get throttled).
 *
 * YouTube changes these client values from time to time. If search works but download says
 * "no direct audio link", update the CLIENT_* constants below first.
 */
public final class YouTubeBridge {
    public static final boolean ENABLED = true;

    public interface Progress { void on(int percent); }

    // ---- values that may need a refresh when YouTube changes ----
    private static final String WEB_VERSION = "2.20250925.01.00";
    private static final String WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    // Tried in this order until one gives a direct audio link: "ANDROID_VR:<version>" or "IOS".
    private static final String[] CLIENTS = { "ANDROID_VR:1.65.10", "ANDROID_VR:1.60.19", "IOS" };
    private static final String IOS_NAME = "IOS";
    private static final String IOS_VERSION = "20.10.4";
    private static final String IOS_UA = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
    // -------------------------------------------------------------

    private static final String API = "https://www.youtube.com/youtubei/v1/";
    private static final int CHUNK = 10 * 1024 * 1024;
    private static final long MAX_BYTES = 80L * 1024 * 1024;
    private static final int MAX_RESULTS = 15;
    private static volatile boolean cancelled;

    private YouTubeBridge() { }

    public static void cancel() { cancelled = true; }

    // ------------------------------------------------------------------ search

    public static JSONArray search(String query, boolean creativeCommonsOnly) throws Exception {
        JSONObject client = new JSONObject();
        client.put("clientName", "WEB");
        client.put("clientVersion", WEB_VERSION);
        client.put("hl", "en");
        client.put("gl", "US");
        JSONObject ctx = new JSONObject();
        ctx.put("client", client);
        JSONObject body = new JSONObject();
        body.put("context", ctx);
        body.put("query", query);
        // filter: type = video; with Creative Commons = video + CC licence
        body.put("params", creativeCommonsOnly ? "EgQQATAB" : "EgIQAQ==");
        JSONObject res = post("search", body, WEB_UA, "1", WEB_VERSION);
        JSONArray found = new JSONArray();
        collectVideos(res, found);
        JSONArray out = new JSONArray();
        for (int i = 0; i < found.length() && out.length() < MAX_RESULTS; i++) {
            JSONObject v = found.optJSONObject(i);
            if (v == null) continue;
            String id = v.optString("videoId", "");
            JSONObject lengthText = v.optJSONObject("lengthText");
            String len = lengthText != null ? lengthText.optString("simpleText", "") : "";
            if (id.isEmpty() || len.isEmpty()) continue; // live streams have no length
            JSONObject item = new JSONObject();
            item.put("id", id);
            item.put("title", runsText(v.optJSONObject("title")));
            item.put("channel", runsText(v.optJSONObject("ownerText")));
            item.put("durationMs", parseClock(len) * 1000L);
            out.put(item);
        }
        return out;
    }

    private static void collectVideos(Object node, JSONArray out) {
        if (node instanceof JSONObject) {
            JSONObject o = (JSONObject) node;
            JSONObject v = o.optJSONObject("videoRenderer");
            if (v != null) { out.put(v); return; }
            Iterator<String> keys = o.keys();
            while (keys.hasNext()) collectVideos(o.opt(keys.next()), out);
        } else if (node instanceof JSONArray) {
            JSONArray a = (JSONArray) node;
            for (int i = 0; i < a.length(); i++) collectVideos(a.opt(i), out);
        }
    }

    private static String runsText(JSONObject t) {
        if (t == null) return "";
        JSONArray runs = t.optJSONArray("runs");
        if (runs != null && runs.length() > 0) {
            JSONObject r = runs.optJSONObject(0);
            if (r != null) return r.optString("text", "");
        }
        return t.optString("simpleText", "");
    }

    private static long parseClock(String s) {
        long total = 0;
        for (String part : s.split(":")) {
            try { total = total * 60 + Long.parseLong(part.trim()); } catch (NumberFormatException e) { return 0; }
        }
        return total;
    }

    // ------------------------------------------------------------------ download

    private static final class Pick {
        String url, ext, mime;
        long size;
    }

    public static JSONObject download(String videoId, File dir, Progress progress) throws Exception {
        if (videoId == null || !videoId.matches("[A-Za-z0-9_-]{11}")) throw new IOException("Bad video link.");
        cancelled = false;
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cannot make the music folder.");
        prune(dir);

        Pick pick = null;
        String title = "";
        long durationMs = 0;
        String lastError = "no direct audio link";
        String ua = IOS_UA;
        for (String spec : CLIENTS) {
            try {
                boolean vr = spec.startsWith("ANDROID_VR");
                String ver = vr ? spec.substring(spec.indexOf(':') + 1) : IOS_VERSION;
                ua = vr ? vrUa(ver) : IOS_UA;
                JSONObject res = post("player", playerBody(vr ? "ANDROID_VR" : IOS_NAME, ver, videoId), ua, vr ? "28" : "5", ver);
                JSONObject ps = res.optJSONObject("playabilityStatus");
                String status = ps != null ? ps.optString("status", "") : "";
                if (!"OK".equals(status)) {
                    lastError = ps != null ? ps.optString("reason", status) : "not playable";
                    continue;
                }
                JSONObject vd = res.optJSONObject("videoDetails");
                if (vd != null) {
                    title = vd.optString("title", "");
                    durationMs = vd.optLong("lengthSeconds", 0) * 1000L;
                }
                pick = pickAudio(res.optJSONObject("streamingData"));
                if (pick != null) break;
                lastError = "no direct audio link";
            } catch (IOException e) {
                lastError = e.getMessage() != null ? e.getMessage() : "network error";
            }
        }
        if (pick == null) throw new IOException("YouTube gave no audio: " + lastError);
        if (pick.size <= 0) throw new IOException("YouTube did not tell the file size.");
        if (pick.size > MAX_BYTES) throw new IOException("This audio is too long (over 80 MB).");

        File out = new File(dir, "yt_" + videoId + "." + pick.ext);
        File tmp = new File(dir, "yt_" + videoId + ".part");
        byte[] buf = new byte[64 * 1024];
        long pos = 0;
        int lastPct = -1;
        try (OutputStream os = new BufferedOutputStream(new FileOutputStream(tmp))) {
            while (pos < pick.size) {
                if (cancelled) throw new IOException("Cancelled");
                long end = Math.min(pick.size, pos + CHUNK) - 1;
                HttpURLConnection c = open(pick.url, ua);
                c.setRequestMethod("GET");
                c.setRequestProperty("Range", "bytes=" + pos + "-" + end);
                long before = pos;
                try {
                    int code = c.getResponseCode();
                    if (code == 403 || code == 416) {
                        // Some links refuse the Range header; the same piece asked as a link parameter is accepted.
                        c.disconnect();
                        c = open(pick.url + (pick.url.contains("?") ? "&" : "?") + "range=" + pos + "-" + end, ua);
                        c.setRequestMethod("GET");
                        code = c.getResponseCode();
                    }
                    if (code != 206 && code != 200) throw new IOException("YouTube refused the download (" + code + ").");
                    if (code == 200 && pos > 0) throw new IOException("YouTube ignored the range request.");
                    try (InputStream in = c.getInputStream()) {
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            if (cancelled) throw new IOException("Cancelled");
                            os.write(buf, 0, n);
                            pos += n;
                            int pct = (int) Math.min(100, (pos * 100L) / pick.size);
                            if (pct != lastPct && progress != null) { lastPct = pct; progress.on(pct); }
                        }
                    }
                } finally { c.disconnect(); }
                if (pos == before) throw new IOException("YouTube sent no data.");
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw e;
        }
        if (out.exists() && !out.delete()) throw new IOException("Cannot replace the old file.");
        if (!tmp.renameTo(out)) throw new IOException("Cannot save the audio file.");

        JSONObject r = new JSONObject();
        r.put("path", out.getAbsolutePath());
        r.put("title", title.isEmpty() ? videoId : title);
        r.put("durationMs", durationMs);
        r.put("mime", pick.mime);
        return r;
    }

    private static String vrUa(String ver) {
        return "com.google.android.apps.youtube.vr.oculus/" + ver + " (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";
    }

    private static JSONObject playerBody(String clientName, String version, String videoId) throws Exception {
        JSONObject client = new JSONObject();
        client.put("clientName", clientName);
        client.put("hl", "en");
        client.put("gl", "US");
        if ("ANDROID_VR".equals(clientName)) {
            client.put("clientVersion", version);
            client.put("deviceMake", "Oculus");
            client.put("deviceModel", "Quest 3");
            client.put("osName", "Android");
            client.put("osVersion", "12L");
            client.put("androidSdkVersion", 32);
        } else {
            client.put("clientVersion", version);
            client.put("deviceMake", "Apple");
            client.put("deviceModel", "iPhone16,2");
            client.put("osName", "iPhone");
            client.put("osVersion", "18.3.2.22D82");
        }
        JSONObject ctx = new JSONObject();
        ctx.put("client", client);
        JSONObject body = new JSONObject();
        body.put("context", ctx);
        body.put("videoId", videoId);
        body.put("contentCheckOk", true);
        body.put("racyCheckOk", true);
        return body;
    }

    /** Best audio-only stream that has a plain url (m4a / AAC first: every phone plays it). */
    private static Pick pickAudio(JSONObject streaming) {
        if (streaming == null) return null;
        JSONArray formats = streaming.optJSONArray("adaptiveFormats");
        if (formats == null) return null;
        JSONObject best = null;
        boolean bestIsMp4 = false;
        for (int i = 0; i < formats.length(); i++) {
            JSONObject f = formats.optJSONObject(i);
            if (f == null) continue;
            String mime = f.optString("mimeType", "");
            if (!mime.startsWith("audio/")) continue;
            if (f.optString("url", "").isEmpty()) continue;
            boolean mp4 = mime.startsWith("audio/mp4");
            if (best == null || (mp4 && !bestIsMp4) || (mp4 == bestIsMp4 && f.optLong("bitrate", 0) > best.optLong("bitrate", 0))) {
                best = f;
                bestIsMp4 = mp4;
            }
        }
        if (best == null) return null;
        Pick p = new Pick();
        p.url = best.optString("url");
        p.mime = best.optString("mimeType");
        p.ext = bestIsMp4 ? "m4a" : "webm";
        p.size = Long.parseLong(best.optString("contentLength", "0").replaceAll("[^0-9]", "0"));
        if (p.size <= 0) p.size = clenFromUrl(p.url);
        return p;
    }

    private static long clenFromUrl(String url) {
        int i = url.indexOf("clen=");
        if (i < 0) return 0;
        int j = i + 5, k = j;
        while (k < url.length() && Character.isDigit(url.charAt(k))) k++;
        try { return Long.parseLong(url.substring(j, k)); } catch (NumberFormatException e) { return 0; }
    }

    /** Remove YouTube audio older than 2 days so the app folder does not grow. */
    private static void prune(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long limit = System.currentTimeMillis() - 2L * 24 * 3600 * 1000;
        for (File f : files) {
            if (f.getName().startsWith("yt_") && f.lastModified() < limit) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    // ------------------------------------------------------------------ http

    private static HttpURLConnection open(String url, String ua) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", ua);
        return c;
    }

    private static JSONObject post(String endpoint, JSONObject body, String ua, String clientId, String clientVersion) throws Exception {
        HttpURLConnection c = open(API + endpoint + "?prettyPrint=false", ua);
        try {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Origin", "https://www.youtube.com");
            c.setRequestProperty("X-YouTube-Client-Name", clientId);
            c.setRequestProperty("X-YouTube-Client-Version", clientVersion);
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = c.getOutputStream()) { os.write(data); }
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("YouTube answered " + code + ".");
            StringBuilder sb = new StringBuilder();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[16 * 1024];
                int n;
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                while ((n = in.read(b)) > 0) bos.write(b, 0, n);
                sb.append(new String(bos.toByteArray(), StandardCharsets.UTF_8));
            }
            return new JSONObject(sb.toString());
        } finally { c.disconnect(); }
    }
}
