package com.tuik.editorr.agy;

import android.os.ParcelFileDescriptor;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** JNI bridge to pocket_spawn.c plus a java.lang.Process wrapper around the spawned child (optionally on a PTY). */
final class NativeSpawn {
    static final int STILL_RUNNING = -2;

    static {
        System.loadLibrary("pocketspawn");
    }

    private NativeSpawn() {}

    static native int[] spawn(String[] argv, String[] env, String cwd, String outputFile,
                              boolean pseudoTerminal, int ptyRows, int ptyColumns);

    static native int waitFor(int pid, boolean noHang);

    static native int kill(int pid, int signal);

    /** The spawned child as a Process. Its output is appended to {@link #outputFile}. */
    static final class Child extends Process {
        private final int pid;
        final File outputFile;
        private final OutputStream stdin;
        private final Thread pump;
        private volatile Integer result;

        private Child(int pid, File outputFile, OutputStream stdin, Thread pump) {
            this.pid = pid;
            this.outputFile = outputFile;
            this.stdin = stdin;
            this.pump = pump;
        }

        @Override public OutputStream getOutputStream() { return stdin; }

        @Override public InputStream getInputStream() {
            try { return new FileInputStream(outputFile); } catch (Exception e) { return new ByteArrayInputStream(new byte[0]); }
        }

        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }

        @Override public int waitFor() {
            Integer r = result;
            if (r != null) return r;
            int status = NativeSpawn.waitFor(pid, false);
            result = status;
            if (pump != null) {
                try { pump.join(1000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            }
            return status;
        }

        @Override public int exitValue() {
            Integer r = result;
            if (r != null) return r;
            int status = NativeSpawn.waitFor(pid, true);
            if (status == STILL_RUNNING) throw new IllegalThreadStateException("Process is still running");
            result = status;
            return status;
        }

        @Override public void destroy() { NativeSpawn.kill(pid, 15); }

        @Override public Process destroyForcibly() { NativeSpawn.kill(pid, 9); return this; }

        @Override public boolean isAlive() {
            try { exitValue(); return false; } catch (IllegalThreadStateException e) { return true; }
        }
    }

    static Child start(java.util.List<String> argv, java.util.Map<String, String> env, String cwd, File outputFile,
                       boolean pty, int rows, int cols) throws java.io.IOException {
        File parent = outputFile.getParentFile();
        if (parent != null) parent.mkdirs();
        if (pty) outputFile.delete();
        String[] envArr = new String[env.size()];
        int i = 0;
        for (java.util.Map.Entry<String, String> e : env.entrySet()) envArr[i++] = e.getKey() + "=" + e.getValue();
        int[] spawned = spawn(argv.toArray(new String[0]), envArr, cwd, outputFile.getAbsolutePath(), pty, rows, cols);
        if (spawned == null || spawned.length != 3 || spawned[0] <= 0) throw new java.io.IOException("Native runtime launch failed");
        OutputStream in = new ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.adoptFd(spawned[1]));
        Thread pump = null;
        if (spawned[2] >= 0) {
            final int outFd = spawned[2];
            pump = new Thread(() -> {
                try (InputStream src = new ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(outFd));
                     FileOutputStream dst = new FileOutputStream(outputFile, false)) {
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = src.read(buf)) >= 0) { dst.write(buf, 0, n); dst.flush(); }
                } catch (Exception ignored) { }
            }, "editorr-pty-output");
            pump.setDaemon(true);
            pump.start();
        }
        return new Child(spawned[0], outputFile, in, pump);
    }
}
