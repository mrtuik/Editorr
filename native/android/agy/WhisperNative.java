package com.tuik.editorr.agy;

/** JNI to whisper.cpp (libeditorrwhisper.so). Use through {@link WhisperEngine}. */
final class WhisperNative {
    interface Progress { void on(int percent); }

    static final boolean AVAILABLE;

    static {
        boolean ok;
        try { System.loadLibrary("editorrwhisper"); ok = true; } catch (Throwable t) { ok = false; }
        AVAILABLE = ok;
    }

    private WhisperNative() {}

    static native long nativeInit(String modelPath);

    static native void nativeFree(long ctx);

    static native void nativeCancel();

    /** JSON array [{"t0":ms,"t1":ms,"text":"..."}], or null when it failed or was cancelled. */
    static native String nativeRun(long ctx, String pcmPath, String lang, boolean words, int threads, Progress cb);
}
