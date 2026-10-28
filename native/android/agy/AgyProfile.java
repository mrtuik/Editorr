package com.tuik.editorr.agy;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The signed-in Google account (name, email, photo) for Editorr's profile.
 * It reads Antigravity's sign-in file on this phone only to ask Google "who is this?" (the ID token already carries the name,
 * email and photo; the access token is the fallback). Nothing is sent anywhere except to Google, and only the name, email
 * and a small round photo are kept (in Editorr's private storage).
 */
public final class AgyProfile {
    private static final Pattern ID_TOKEN = Pattern.compile("eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}");
    private static final Pattern ACCESS_TOKEN = Pattern.compile("ya29\\.[A-Za-z0-9._-]{20,}");

    private AgyProfile() {}

    private static File cacheFile(Context c) { return new File(c.getFilesDir(), "agy-profile.json"); }

    public static void clear(Context c) { cacheFile(c).delete(); }

    /** Name, email and photo (data URL) as JSON, or null when nothing is known. Never throws. */
    public static JSONObject load(Context context, AgyRuntime runtime, String emailHint) {
        JSONObject cached = readCache(context);
        String name = "", email = "", picture = "";
        try {
            File cred = runtime.credentialFile();
            if (cred.isFile()) {
                String raw = new String(Files.readAllBytes(cred.toPath()), "UTF-8");
                // 1) ID token claims: no network needed
                Matcher m = ID_TOKEN.matcher(raw);
                while (m.find()) {
                    JSONObject claims = decodeJwt(m.group());
                    if (claims == null) continue;
                    if (name.isEmpty()) name = claims.optString("name", "");
                    if (email.isEmpty()) email = claims.optString("email", "");
                    if (picture.isEmpty()) picture = claims.optString("picture", "");
                }
                // 2) userinfo with the access token for anything still missing
                if (name.isEmpty() || email.isEmpty() || picture.isEmpty()) {
                    Matcher a = ACCESS_TOKEN.matcher(raw);
                    if (a.find()) {
                        JSONObject info = userInfo(a.group());
                        if (info != null) {
                            if (name.isEmpty()) name = info.optString("name", info.optString("given_name", ""));
                            if (email.isEmpty()) email = info.optString("email", "");
                            if (picture.isEmpty()) picture = info.optString("picture", "");
                        }
                    }
                }
            }
        } catch (Exception ignored) { }
        if (email.isEmpty() && emailHint != null) email = emailHint;
        if (cached != null) {
            if (name.isEmpty()) name = cached.optString("name", "");
            if (email.isEmpty()) email = cached.optString("email", "");
        }
        if (name.isEmpty() && !email.isEmpty()) name = nameFromEmail(email);
        String photo = cached == null ? "" : cached.optString("picture", "");
        if (!picture.isEmpty() && picture.startsWith("https://")) {
            String data = fetchPhoto(picture);
            if (!data.isEmpty()) photo = data;
        }
        if (name.isEmpty() && email.isEmpty() && photo.isEmpty()) return null;
        try {
            JSONObject out = new JSONObject().put("name", name).put("email", email).put("picture", photo);
            try (FileOutputStream f = new FileOutputStream(cacheFile(context))) { f.write(out.toString().getBytes("UTF-8")); }
            return out;
        } catch (Exception e) { return null; }
    }

    private static JSONObject readCache(Context c) {
        try { return new JSONObject(new String(Files.readAllBytes(cacheFile(c).toPath()), "UTF-8")); } catch (Exception e) { return null; }
    }

    private static String nameFromEmail(String email) {
        String local = email.contains("@") ? email.substring(0, email.indexOf('@')) : email;
        String[] parts = local.replaceAll("[0-9]+$", "").split("[._-]+");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(p.charAt(0))).append(p.substring(1));
        }
        return sb.length() == 0 ? local : sb.toString();
    }

    private static JSONObject decodeJwt(String jwt) {
        try {
            String[] parts = jwt.split("\\.");
            byte[] payload = Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            return new JSONObject(new String(payload, "UTF-8"));
        } catch (Exception e) { return null; }
    }

    private static JSONObject userInfo(String accessToken) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("https://www.googleapis.com/oauth2/v3/userinfo").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("Authorization", "Bearer " + accessToken);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
                return new JSONObject(b.toString("UTF-8"));
            }
        } catch (Exception e) { return null; } finally { if (c != null) c.disconnect(); }
    }

    /** Google photo -> small square JPEG as a data URL (works offline and on every screen). */
    private static String fetchPhoto(String url) {
        HttpURLConnection c = null;
        try {
            String base = url.replaceAll("=s\\d+(-c)?$", "");
            String sized = base.contains("googleusercontent.com") ? base + "=s192-c" : base;
            c = (HttpURLConnection) new URL(sized).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return "";
            Bitmap bmp;
            try (InputStream in = c.getInputStream()) { bmp = BitmapFactory.decodeStream(in); }
            if (bmp == null) return "";
            int side = Math.min(bmp.getWidth(), bmp.getHeight());
            Bitmap sq = Bitmap.createBitmap(bmp, (bmp.getWidth() - side) / 2, (bmp.getHeight() - side) / 2, side, side);
            Bitmap small = Bitmap.createScaledBitmap(sq, 192, 192, true);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 85, out);
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) { return ""; } finally { if (c != null) c.disconnect(); }
    }
}
