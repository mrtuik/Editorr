package com.tuik.editorr.agy;

import android.content.Context;
import android.net.ConnectivityManager;
import android.system.Os;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream;
import org.apache.commons.compress.compressors.zstandard.ZstdCompressorInputStream;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Editorr's own private Linux runtime for the Antigravity CLI (agy). No other app is needed:
 *  - the Core Ubuntu bundle (bash, certificates, ...) is downloaded once and unpacked into app-private storage,
 *  - Google's official Antigravity CLI binary is downloaded straight from Google and checksum-verified,
 *  - everything runs inside PRoot (built into this APK as libproot.so).
 */
public final class AgyRuntime {
    public interface Progress { void on(String message, float fraction); }

    public static final String AGY_GUEST_PATH = "/root/.local/bin/agy";

    // Core Linux bundle (Ubuntu 20.04 arm64 + bash, git, ca-certificates). The base URL is filled in by scripts/patch-android.py.
    private static final String RUNTIME_BASE_URL = "@RUNTIME_BASE_URL@";
    private static final String CORE_FILE = "pocketdev-core-arm64-2026.09.5.tar.zst";
    private static final String CORE_SHA256 = "df0cf7251c74f82d424231e3804114a4ca66b16130eea9abab11e220dc7ac012";

    // Google's official Antigravity CLI (linux arm64). The manifest gives the newest build; the constants are the fallback.
    private static final String AGY_MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json";
    private static final String AGY_FALLBACK_VERSION = "1.1.27";
    private static final String AGY_FALLBACK_URL = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.27-5211191891591168/linux-arm/cli_linux_arm64.tar.gz";
    private static final String AGY_FALLBACK_SHA512 = "ed45f6930785aa4b42f14e07ace1c9d91a94fb76e760f54acbd7d3d3951e1f957fd456a0dae2a3124dd9a3b689bf7afb7c9303a3e4ba95037fc10063424d9bf9";

    private final Context context;
    private final File runtimeDir;
    private final File rootfs;
    private final File downloads;
    private final File coreMarker;
    private final File agyMarker;

    public AgyRuntime(Context context) {
        this.context = context.getApplicationContext();
        runtimeDir = new File(this.context.getFilesDir(), "agy-runtime");
        rootfs = new File(runtimeDir, "ubuntu");
        downloads = new File(this.context.getCacheDir(), "agy-downloads");
        coreMarker = new File(rootfs, ".editorr-core-ready");
        agyMarker = new File(rootfs, ".editorr-agy-version");
    }

    public File rootfs() { return rootfs; }

    public File proot() { return new File(context.getApplicationInfo().nativeLibraryDir, "libproot.so"); }

    public boolean isSupportedDevice() {
        for (String abi : android.os.Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi)) return true;
        return false;
    }

    public boolean isInstalled() {
        return proot().canExecute()
                && coreMarker.exists()
                && new File(rootfs, "usr/bin/bash").exists()
                && new File(rootfs, AGY_GUEST_PATH.substring(1)).canExecute()
                && agyMarker.exists();
    }

    public String agyVersion() { return read(agyMarker); }

    /** agy keeps its Google sign-in in this app-private file (inside the private Linux home). Its content is never read. */
    public File credentialFile() {
        return new File(rootfs, "root/.gemini/antigravity-cli/antigravity-oauth-token");
    }

    public boolean isSignedIn() { return credentialFile().isFile(); }

    // ------------------------------------------------------------------ install

    public synchronized void install(Progress p) throws Exception {
        if (!isSupportedDevice()) throw new IllegalStateException("Antigravity needs a 64-bit ARM (arm64) phone.");
        if (!proot().canExecute()) throw new IllegalStateException("The built-in PRoot launcher is missing from this build.");
        if (!coreMarker.exists() || !new File(rootfs, "usr/bin/bash").exists()) installCore(p);
        ensureCompatLinks();
        writeResolver();
        if (!agyMarker.exists() || !new File(rootfs, AGY_GUEST_PATH.substring(1)).canExecute()) installAgy(p);
        p.on("Ready", 1f);
    }

    private void installCore(Progress p) throws Exception {
        p.on("Downloading the Linux base", 0.02f);
        File archive = new File(downloads, CORE_FILE);
        download(RUNTIME_BASE_URL + "/" + CORE_FILE, archive, CORE_SHA256, "SHA-256", (done, total) ->
                p.on("Downloading the Linux base", 0.02f + (total > 0 ? 0.55f * done / total : 0f)));
        p.on("Unpacking the Linux base (one time)", 0.6f);
        File staging = new File(runtimeDir, "ubuntu.installing");
        deleteRecursively(staging);
        staging.mkdirs();
        extractZstdTar(archive, staging);
        stripMacMetadata(staging);
        if (!new File(staging, "usr/bin/bash").isFile()) throw new IllegalStateException("The Linux base download is incomplete.");
        deleteRecursively(rootfs);
        if (!staging.renameTo(rootfs)) throw new IllegalStateException("Could not activate the Linux base.");
        ensureCompatLinks();
        new File(rootfs, ".editorr-core-ready").createNewFile();
        archive.delete();
    }

    private void installAgy(Progress p) throws Exception {
        p.on("Finding the latest Antigravity", 0.82f);
        String version = AGY_FALLBACK_VERSION, url = AGY_FALLBACK_URL, sha512 = AGY_FALLBACK_SHA512;
        try {
            JSONObject m = new JSONObject(fetchText(AGY_MANIFEST));
            String v = m.getString("version"), u = m.getString("url"), s = m.getString("sha512");
            if (u.startsWith("https://") && s.length() >= 64) { version = v; url = u; sha512 = s; }
        } catch (Exception ignored) { /* fall back to the pinned build */ }
        File tgz = new File(downloads, "antigravity-" + version + "-linux-arm64.tar.gz");
        final String label = version;
        download(url, tgz, sha512, "SHA-512", (done, total) ->
                p.on("Downloading Antigravity " + label, 0.82f + (total > 0 ? 0.15f * done / total : 0f)));
        File dest = new File(rootfs, AGY_GUEST_PATH.substring(1));
        dest.getParentFile().mkdirs();
        boolean found = false;
        try (TarArchiveInputStream tar = new TarArchiveInputStream(new GzipCompressorInputStream(new BufferedInputStream(new java.io.FileInputStream(tgz))))) {
            TarArchiveEntry e;
            while ((e = tar.getNextTarEntry()) != null) {
                if (e.isFile() && e.getName().replaceFirst("^\\./", "").equals("antigravity")) {
                    File staged = new File(dest.getParentFile(), ".agy-" + version + ".installing");
                    try (FileOutputStream out = new FileOutputStream(staged)) { copy(tar, out); }
                    Os.chmod(staged.getAbsolutePath(), 0755);
                    Os.rename(staged.getAbsolutePath(), dest.getAbsolutePath());
                    found = true;
                    break;
                }
            }
        }
        tgz.delete();
        if (!found) throw new IllegalStateException("The Antigravity download is incomplete.");
        p.on("Checking Antigravity", 0.99f);
        String out = runGuest(new String[]{AGY_GUEST_PATH, "--version"}, 60);
        if (out == null) throw new IllegalStateException("Antigravity could not start on this phone.");
        try (FileOutputStream f = new FileOutputStream(agyMarker)) { f.write(version.getBytes("UTF-8")); }
    }

    /** Runs one command in the guest and returns its output, or null when it failed / timed out. */
    private String runGuest(String[] cmd, int timeoutSec) throws Exception {
        File out = new File(context.getCacheDir(), "agy-guest-" + System.nanoTime() + ".log");
        File ws = new File(context.getCacheDir(), "agy-check");
        Process pr = process(ws, "/workspace/check", new LinkedHashMap<>(), java.util.Arrays.asList(cmd), out, false, 40, 120);
        long end = System.currentTimeMillis() + timeoutSec * 1000L;
        while (pr.isAlive() && System.currentTimeMillis() < end) Thread.sleep(150);
        if (pr.isAlive()) { pr.destroyForcibly(); out.delete(); return null; }
        int code = pr.waitFor();
        String text = new String(Files.readAllBytes(out.toPath()), "UTF-8");
        out.delete();
        return code == 0 ? text : null;
    }

    // ------------------------------------------------------------------ process

    /** Starts a command inside the private Linux (PRoot). The workspace dir shows up as guestWorkspace. */
    public NativeSpawn.Child process(File workspace, String guestWorkspace, Map<String, String> extraEnv,
                                     List<String> guestCommand, File outputFile, boolean pty, int rows, int cols) throws Exception {
        if (!guestWorkspace.matches("^/workspace(/[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?)?$")) throw new IllegalArgumentException("Bad workspace path");
        ensureCompatLinks();
        workspace.mkdirs();
        new File(rootfs, guestWorkspace.substring(1)).mkdirs();
        List<String> args = new ArrayList<>();
        args.add(proot().getAbsolutePath());
        args.add("-0");
        args.add("-r"); args.add(rootfs.getAbsolutePath());
        for (String b : new String[]{"/dev", "/proc", "/sys"}) { args.add("-b"); args.add(b); }
        for (String host : new String[]{"/system", "/apex", "/vendor", "/product"}) {
            if (new File(host).exists()) {
                new File(rootfs, host.substring(1)).mkdirs();
                args.add("-b"); args.add(host);
            }
        }
        args.add("-b"); args.add(workspace.getAbsolutePath() + ":" + guestWorkspace);
        args.add("-w"); args.add(guestWorkspace);
        args.addAll(guestCommand);

        File prootTmp = new File(context.getCacheDir(), "proot-tmp");
        prootTmp.mkdirs();
        String nativeDir = context.getApplicationInfo().nativeLibraryDir;
        Map<String, String> env = new LinkedHashMap<>();
        env.put("HOME", "/root");
        env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        env.put("LANG", "C.UTF-8");
        env.put("TERM", "xterm-256color");
        env.put("LD_LIBRARY_PATH", nativeDir);
        env.put("PROOT_NO_SECCOMP", "1");
        env.put("PROOT_TMP_DIR", prootTmp.getAbsolutePath());
        env.put("PROOT_LOADER", new File(nativeDir, "libprootloader.so").getAbsolutePath());
        env.put("GLIBC_TUNABLES", "glibc.pthread.rseq=0");
        env.putAll(extraEnv);
        return NativeSpawn.start(args, env, context.getFilesDir().getAbsolutePath(), outputFile, pty, rows, cols);
    }

    private void ensureCompatLinks() throws Exception {
        if (!rootfs.isDirectory()) return;
        String[][] links = {{"bin", "usr/bin"}, {"lib", "usr/lib"}, {"sbin", "usr/sbin"}};
        for (String[] l : links) {
            File link = new File(rootfs, l[0]);
            if (Files.isSymbolicLink(link.toPath())) {
                if (!Files.readSymbolicLink(link.toPath()).toString().equals(l[1])) {
                    Files.delete(link.toPath());
                    Os.symlink(l[1], link.getAbsolutePath());
                }
            } else if (!link.exists()) {
                Os.symlink(l[1], link.getAbsolutePath());
            }
        }
    }

    private void writeResolver() {
        try {
            List<String> servers = new ArrayList<>();
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm != null && cm.getActiveNetwork() != null && cm.getLinkProperties(cm.getActiveNetwork()) != null) {
                for (InetAddress a : cm.getLinkProperties(cm.getActiveNetwork()).getDnsServers()) servers.add(a.getHostAddress());
            }
            if (servers.isEmpty()) { servers.add("8.8.8.8"); servers.add("1.1.1.1"); }
            StringBuilder sb = new StringBuilder();
            for (String s : servers) sb.append("nameserver ").append(s).append('\n');
            File f = new File(rootfs, "etc/resolv.conf");
            f.getParentFile().mkdirs();
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(sb.toString().getBytes("UTF-8")); }
        } catch (Exception ignored) { }
    }

    /** Refresh DNS before every run: the phone may have changed network since install. */
    public void prepareForRun() throws Exception {
        ensureCompatLinks();
        writeResolver();
    }

    // ------------------------------------------------------------------ helpers

    private interface Bytes { void on(long done, long total); }

    private void download(String url, File dest, String expected, String algo, Bytes cb) throws Exception {
        dest.getParentFile().mkdirs();
        if (dest.isFile() && digest(dest, algo).equalsIgnoreCase(expected)) { cb.on(dest.length(), dest.length()); return; }
        File part = new File(dest.getParentFile(), dest.getName() + ".part");
        long have = part.isFile() ? part.length() : 0L;
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setInstanceFollowRedirects(true);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        int code = c.getResponseCode();
        if (code < 200 || code > 299) throw new IllegalStateException("Download failed (HTTP " + code + ")");
        boolean resumed = code == HttpURLConnection.HTTP_PARTIAL && have > 0;
        if (!resumed) { part.delete(); have = 0; }
        long total = c.getContentLengthLong() >= 0 ? c.getContentLengthLong() + have : -1;
        try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part, resumed)) {
            byte[] buf = new byte[128 * 1024];
            long done = have;
            int n;
            while ((n = in.read(buf)) >= 0) { out.write(buf, 0, n); done += n; cb.on(done, total); }
        } finally { c.disconnect(); }
        if (!digest(part, algo).equalsIgnoreCase(expected)) { part.delete(); throw new IllegalStateException("The download was damaged. Try again."); }
        dest.delete();
        if (!part.renameTo(dest)) throw new IllegalStateException("Could not finish the download.");
    }

    private static String fetchText(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            copy(in, b);
            return b.toString("UTF-8");
        } finally { c.disconnect(); }
    }

    private static String digest(File f, String algo) throws Exception {
        MessageDigest md = MessageDigest.getInstance(algo);
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void copy(InputStream in, java.io.OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    }

    private static File safeChild(File root, String rel) throws java.io.IOException {
        File f = new File(root, rel);
        String rp = root.getCanonicalPath(), fp = f.getCanonicalFile().getParentFile() == null ? f.getPath() : new File(f.getCanonicalFile().getParentFile(), f.getName()).getPath();
        if (!fp.startsWith(rp)) throw new java.io.IOException("Unsafe path in archive");
        return f;
    }

    private static void extractZstdTar(File archive, File dest) throws Exception {
        List<File[]> deferred = new ArrayList<>();
        try (TarArchiveInputStream tar = new TarArchiveInputStream(new ZstdCompressorInputStream(new BufferedInputStream(new java.io.FileInputStream(archive))))) {
            TarArchiveEntry e;
            while ((e = tar.getNextTarEntry()) != null) {
                String name = e.getName().replaceFirst("^\\./", "");
                if (name.isEmpty()) continue;
                File target = safeChild(dest, name);
                if (e.isDirectory()) {
                    target.mkdirs();
                } else if (e.isSymbolicLink()) {
                    target.getParentFile().mkdirs();
                    if (target.exists() || Files.isSymbolicLink(target.toPath())) target.delete();
                    Os.symlink(e.getLinkName(), target.getAbsolutePath());
                } else if (e.isLink()) {
                    target.getParentFile().mkdirs();
                    File src = safeChild(dest, e.getLinkName().replaceFirst("^\\./", ""));
                    if (src.exists()) copyFile(src, target); else deferred.add(new File[]{target, src});
                } else if (e.isFile()) {
                    target.getParentFile().mkdirs();
                    try (FileOutputStream o = new FileOutputStream(target)) { copy(tar, o); }
                    try { Os.chmod(target.getAbsolutePath(), e.getMode() & 0777); } catch (Exception ignored) { }
                }
            }
        }
        for (File[] d : deferred) {
            if (!d[1].isFile()) throw new IllegalStateException("Archive hard-link target is missing");
            d[0].getParentFile().mkdirs();
            copyFile(d[1], d[0]);
            try { Os.chmod(d[0].getAbsolutePath(), Os.stat(d[1].getAbsolutePath()).st_mode & 0777); } catch (Exception ignored) { }
        }
    }

    private static void copyFile(File from, File to) throws java.io.IOException {
        try (InputStream in = new java.io.FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) { copy(in, out); }
    }

    private static void stripMacMetadata(File dir) {
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (Files.isSymbolicLink(f.toPath())) continue;
            if (f.getName().startsWith("._")) { f.delete(); continue; }
            if (f.isDirectory()) stripMacMetadata(f);
        }
    }

    static void deleteRecursively(File f) {
        if (f == null || !f.exists() && !Files.isSymbolicLink(f.toPath())) return;
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursively(k);
        }
        f.delete();
    }

    private static String read(File f) {
        try { return new String(Files.readAllBytes(f.toPath()), "UTF-8").trim(); } catch (Exception e) { return ""; }
    }
}
