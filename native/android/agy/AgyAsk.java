package com.tuik.editorr.agy;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** One-shot question to the signed-in Antigravity CLI. No tools: the CLI runs in an empty private scratch folder. */
public final class AgyAsk {
    private AgyAsk() {}

    public static String ask(Context context, AgyRuntime runtime, String prompt, long timeoutMs) throws Exception {
        if (!runtime.isInstalled()) throw new IllegalStateException("Set up Antigravity first.");
        if (!runtime.isSignedIn()) throw new IllegalStateException("Sign in to Antigravity first.");
        runtime.prepareForRun();
        File scratch = new File(context.getCacheDir(), "agy-ask");
        File out = new File(context.getCacheDir(), "agy-ask-" + System.nanoTime() + ".log");
        List<String> cmd = new ArrayList<>();
        Collections.addAll(cmd, AgyRuntime.AGY_GUEST_PATH, "--input-format", "stream-json", "--output-format", "stream-json",
                "--print-timeout", "4m", "--dangerously-skip-permissions", "--new-project");
        Process p = runtime.process(scratch, "/workspace/ask", new java.util.LinkedHashMap<>(), cmd, out, false, 40, 120);
        try {
            JSONObject req = new JSONObject().put("event", "user").put("message", new JSONObject().put("content", prompt));
            p.getOutputStream().write((req.toString() + "\n").getBytes("UTF-8"));
            p.getOutputStream().flush();
            p.getOutputStream().close();

            long end = System.currentTimeMillis() + timeoutMs;
            long offset = 0;
            StringBuilder pending = new StringBuilder(), collected = new StringBuilder();
            String finalResponse = null;
            boolean done = false;
            while (!done && (p.isAlive() || out.length() > offset)) {
                if (System.currentTimeMillis() > end) throw new IllegalStateException("Antigravity did not answer. Try again.");
                long avail = out.length() - offset;
                if (avail <= 0) { Thread.sleep(100); continue; }
                byte[] buf = new byte[(int) Math.min(avail, 16 * 1024)];
                int n;
                try (RandomAccessFile f = new RandomAccessFile(out, "r")) { f.seek(offset); n = f.read(buf); }
                if (n <= 0) continue;
                offset += n;
                pending.append(new String(buf, 0, n, "UTF-8"));
                int nl;
                while ((nl = pending.indexOf("\n")) >= 0) {
                    String line = pending.substring(0, nl).trim();
                    pending.delete(0, nl + 1);
                    if (line.isEmpty()) continue;
                    JSONObject root;
                    try { root = new JSONObject(line); } catch (Exception e) { continue; }
                    String ev = root.optString("event");
                    if ("step_update".equals(ev)) {
                        JSONObject step = root.optJSONObject("step_update");
                        String d = step == null ? "" : step.optString("text_delta");
                        if (!d.isEmpty()) collected.append(d);
                    } else if ("result".equals(ev)) {
                        JSONObject r = root.optJSONObject("result");
                        if (r == null) r = root;
                        if ("SUCCESS".equalsIgnoreCase(r.optString("status", "ERROR"))) {
                            String resp = r.optString("response");
                            if (!resp.isEmpty()) finalResponse = resp;
                            done = true;
                            break;
                        }
                        throw new IllegalStateException(friendly(r.optString("error", r.optString("status"))));
                    }
                }
            }
            if (!done) throw new IllegalStateException(friendly(pending.toString().trim().isEmpty() ? "Antigravity exited without answering" : pending.toString()));
            String text = finalResponse != null && !finalResponse.trim().isEmpty() ? finalResponse.trim() : collected.toString().trim();
            if (text.isEmpty()) throw new IllegalStateException("Antigravity answered with nothing.");
            return text;
        } finally {
            try { p.destroy(); } catch (Exception ignored) { }
            out.delete();
        }
    }

    private static String friendly(String raw) {
        String v = raw.replaceAll("\\s+", " ").trim();
        String l = v.toLowerCase();
        if (l.contains("authentication required") || l.contains("authentication failed") || l.contains("not signed in")) return "Antigravity needs you to sign in again.";
        if (l.contains("out of credits") || l.contains("quota")) return "Your Antigravity account is out of credits for now.";
        if (l.contains("timed out") || l.contains("timeout")) return "Antigravity took too long. Try again.";
        if (v.isEmpty()) return "Antigravity could not answer.";
        return v.length() > 400 ? v.substring(0, 400) : v;
    }
}
