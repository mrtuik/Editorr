package com.tuik.editorr.agy;

/** JNI to whisper.cpp (libeditorrwhisper.so). Use through {@link WhisperEngine}. */
final class WhisperNative {
    interface Progress { void on(int percent); }

    static final boolean AVAILABLE;

    /** The native library is built for armv8.2 (dot product + fp16). Only load it when this CPU really has those instructions. */
    private static boolean cpuSupportsBuild() {
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader("/proc/cpuinfo"))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("Features")) return (line + " ").contains(" asimddp ") && (line + " ").contains(" asimdhp ");
            }
        } catch (Exception ignored) { }
        return false;
    }

    static {
        boolean ok;
        try {
            if (!cpuSupportsBuild()) throw new UnsatisfiedLinkError("cpu");
            System.loadLibrary("editorrwhisper");
            ok = true;
        } catch (Throwable t) { ok = false; }
        AVAILABLE = ok;
    }

    private WhisperNative() {}

    static native long nativeInit(String modelPath);

    static native void nativeFree(long ctx);

    static native void nativeCancel();

    /** JSON array [{"t0":ms,"t1":ms,"text":"..."}], or null when it failed or was cancelled. */
    static native String nativeRun(long ctx, String pcmPath, String lang, boolean words, int threads, Progress cb);
}
