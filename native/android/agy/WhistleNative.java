package com.tuik.editorr.agy;

/** JNI to the Cactus needle engine running Whistle (libeditorrwhistle.so). Use through {@link WhistleEngine}. */
final class WhistleNative {
    static final boolean AVAILABLE;

    static {
        boolean ok;
        try {
            System.loadLibrary("editorrwhistle");
            ok = true;
        } catch (Throwable t) { ok = false; }
        AVAILABLE = ok;
    }

    private WhistleNative() {}

    /** Loads a .cact model file. null = loaded, otherwise a readable error. */
    static native String nativeLoad(String modelPath);

    /** One window (max 30 s, 16 kHz mono float). The engine's JSON text, or null when it failed. */
    static native String nativeTranscribe(float[] samples, String lang, boolean words);

    static native String nativeLastError();
}
