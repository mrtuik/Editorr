package com.tuik.editorr.agy;

import android.content.Context;

import java.io.File;
import java.io.RandomAccessFile;
import java.util.LinkedHashMap;
import java.util.Collections;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Drives agy's own interactive Google sign-in (browser URL + one-time code). Credentials are never read. */
public final class AgyAuth {
    public interface Listener { void onState(String status, String message, String url, String email); }

    private static final String HANDSHAKE = "\u001B[?2026;1$y\u001B[?2027;1$y\u001B[?1u\n";
    private static final Pattern ANSI = Pattern.compile("\\u001B(?:\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)|\\[[0-?]*[ -/]*[@-~]|[()][A-Z0-9])");
    private static final Pattern OAUTH = Pattern.compile("https://accounts\\.google\\.com/[^\\s\\\"'<>]*?[?&]state=[A-Za-z0-9._~-]+");
    private static final Pattern EMAIL = Pattern.compile("[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", Pattern.CASE_INSENSITIVE);

    private final Context context;
    private final AgyRuntime runtime;
    private final Listener listener;
    private volatile Process process;
    private volatile boolean codeSubmitted;
    private volatile Thread worker;
    private volatile String status = "signed_out";
    private volatile String email = "";

    public AgyAuth(Context context, AgyRuntime runtime, Listener listener) {
        this.context = context.getApplicationContext();
        this.runtime = runtime;
        this.listener = listener;
    }

    public String status() { return runtime.isSignedIn() && !"awaiting_code".equals(status) && !"completing".equals(status) && !"starting".equals(status) ? "signed_in" : status; }

    public String email() { return email; }

    private void emit(String s, String msg, String url) {
        status = s;
        listener.onState(s, msg, url, email);
    }

    public synchronized void begin() {
        if (process != null && process.isAlive()) return;
        if (!runtime.isInstalled()) { emit("error", "Set up Antigravity first.", null); return; }
        codeSubmitted = false;
        emit("starting", "Starting Google sign-in...", null);
        worker = new Thread(this::run, "editorr-agy-login");
        worker.setDaemon(true);
        worker.start();
    }

    private static String clean(String raw) {
        String s = ANSI.matcher(raw).replaceAll("");
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '\n' || c == '\r' || c == '\t' || c >= 0x20) b.append(c); }
        return b.toString();
    }

    private static String findUrl(String out) {
        String compact = out.replaceAll("[\\r\\n\\t ]+", "");
        Matcher m = OAUTH.matcher(compact);
        if (m.find()) {
            String u = m.group();
            if (u.contains("client_id=") && u.contains("code_challenge=")) return u;
        }
        return null;
    }

    private static void write(Process p, String s) { try { p.getOutputStream().write(s.getBytes("UTF-8")); p.getOutputStream().flush(); } catch (Exception ignored) { } }

    private void run() {
        File outFile = new File(context.getCacheDir(), "agy-auth-output.log");
        outFile.delete();
        Process running = null;
        try {
            runtime.prepareForRun();
            File ws = new File(context.getFilesDir(), "workspaces/antigravity-auth");
            Map<String, String> env = new LinkedHashMap<>();
            env.put("SSH_CONNECTION", "127.0.0.1 1 127.0.0.1 1"); // selects agy's manual URL + one-time-code flow
            env.put("TERM", "xterm-256color");
            env.put("NO_COLOR", "1");
            running = runtime.process(ws, "/workspace/antigravity-auth", env, Collections.singletonList(AgyRuntime.AGY_GUEST_PATH), outFile, true, 40, 120);
            process = running;
            long offset = 0;
            StringBuilder output = new StringBuilder();
            int handshakeReplies = 0, lastLen = 0;
            boolean menu = false, color = false, render = false, privacy = false, trust = false, haveUrl = false;
            while (running.isAlive() || outFile.length() > offset) {
                long avail = outFile.length() - offset;
                if (avail <= 0) { Thread.sleep(80); continue; }
                byte[] buf = new byte[(int) Math.min(avail, 16 * 1024)];
                int n;
                try (RandomAccessFile f = new RandomAccessFile(outFile, "r")) { f.seek(offset); n = f.read(buf); }
                if (n <= 0) continue;
                offset += n;
                output.append(new String(buf, 0, n, "UTF-8"));
                String c = clean(output.toString());
                if (c.length() > 40000) c = c.substring(c.length() - 40000);

                if (handshakeReplies < 5 && output.length() - lastLen > 200 && output.substring(lastLen).contains("\u001B[?u")) {
                    write(running, HANDSHAKE); handshakeReplies++; lastLen = output.length();
                }
                String lc = c.toLowerCase();
                if (handshakeReplies > 0 && !menu && lc.contains("select login method") && lc.contains("> 1. google oauth") && findUrl(c) == null) {
                    write(running, "\r\n"); menu = true;
                    if ("starting".equals(status)) emit("starting", "Waiting for the Google sign-in link...", null);
                }
                String url = findUrl(c);
                if (url != null && !haveUrl) {
                    haveUrl = true;
                    emit("awaiting_code", "Finish signing in with Google, then paste the one-time code.", url);
                }
                if (lc.contains("for shortcuts") || (lc.contains("antigravity cli") && lc.contains("google ai"))) {
                    Matcher m = EMAIL.matcher(c);
                    while (m.find()) { if (!m.group().toLowerCase().endsWith(".apps.googleusercontent.com")) { email = m.group(); break; } }
                    emit("signed_in", email.isEmpty() ? "Google account connected" : "Connected as " + email, null);
                    write(running, "/quit\r\n");
                    for (int i = 0; i < 20 && running.isAlive(); i++) Thread.sleep(50);
                    if (running.isAlive()) running.destroy();
                    return;
                }
                if (!color && lc.contains("choose your color scheme")) { write(running, "\r\n"); color = true; }
                if (!render && lc.contains("no flickering (altscreen)") && lc.contains("native terminal experience (inline)")) { write(running, "\u001B[B\r\n"); render = true; }
                if (!privacy && lc.contains("terms of service & data use") && lc.contains("help improve antigravity cli")) {
                    write(running, lc.contains("[x] yes") ? " \t\t\r\n" : "\t\t\r\n"); // opt out of optional data sharing
                    privacy = true;
                    emit("completing", "Google connected - finishing setup...", null);
                }
                if (!trust && lc.contains("do you trust the contents of this project") && lc.contains("yes, i trust this folder")) { write(running, "\r\n"); trust = true; }
                if (lc.contains("authentication failed") || lc.contains("failed to exchange")) throw new IllegalStateException("Google sign-in failed. Start a new sign-in attempt.");
            }
            if (!codeSubmitted && "starting".equals(status)) {
                throw new IllegalStateException("Sign-in closed before it produced a link (exit " + running.waitFor() + ").");
            }
        } catch (Throwable t) {
            if (!"signed_in".equals(status)) {
                String m = t.getMessage();
                emit("error", m == null ? "Antigravity sign-in failed" : (m.length() > 240 ? m.substring(0, 240) : m), null);
            }
        } finally {
            if (running != null && running.isAlive()) running.destroy();
            outFile.delete(); // OAuth terminal output is ephemeral
            process = null;
            codeSubmitted = false;
        }
    }

    public void submitCode(String code) {
        String v = code == null ? "" : code.trim();
        if (v.isEmpty()) throw new IllegalArgumentException("Paste the code from Google");
        Process p = process;
        if (p == null || !p.isAlive()) throw new IllegalStateException("The sign-in expired. Start again.");
        write(p, v + "\r\n");
        codeSubmitted = true;
        emit("completing", "Completing Google sign-in...", null);
    }

    public void cancel() {
        Process p = process;
        if (p != null) p.destroy();
        emit("signed_out", "", null);
    }

    public void logout() {
        Process p = process;
        if (p != null) p.destroy();
        File cred = runtime.credentialFile();
        if (cred.exists() && !cred.delete()) throw new IllegalStateException("Could not sign out.");
        email = "";
        emit("signed_out", "Signed out", null);
    }
}
