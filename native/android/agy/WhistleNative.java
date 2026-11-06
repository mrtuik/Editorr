package com.tuik.editorr.agy;

/** JNI to the Cactus needle engine running Whistle (libeditorrwhistle.so). Use through {@link WhistleEngine}. */
final class WhistleNative {
    static final boolean AVAILABLE;
    /** Why libeditorrwhistle.so did not load (empty when it did). */
    static final String LOAD_ERROR;

    static {
        boolean ok;
        String err = "";
        try {
            System.loadLibrary("editorrwhistle");
            ok = true;
        } catch (Throwable t) { ok = false; err = String.valueOf(t.getMessage()); }
        AVAILABLE = ok;
        LOAD_ERROR = err;
    }

    private WhistleNative() {}

    /** Loads a .cact model file. null = loaded, otherwise a readable error. */
    static native String nativeLoad(String modelPath);

    /** One window (max 30 s, 16 kHz mono float). The engine's JSON text, or null when it failed. */
    static native String nativeTranscribe(float[] samples, String lang, boolean words);

    static native String nativeLastError();
}
