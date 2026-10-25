package com.tuik.editorr;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/**
 * Default build: the YouTube module is NOT included. The app still compiles and runs the same;
 * the YouTube button is hidden. Build with EDITORR_YOUTUBE=1 to get the real one
 * (native/android/youtube/real/YouTubeBridge.java).
 */
public final class YouTubeBridge {
    public static final boolean ENABLED = false;

    public interface Progress { void on(int percent); }

    private YouTubeBridge() { }

    public static JSONArray search(String query, boolean creativeCommonsOnly) throws IOException {
        throw new IOException("YouTube is not included in this build.");
    }

    public static JSONObject download(String videoId, File dir, Progress progress) throws IOException {
        throw new IOException("YouTube is not included in this build.");
    }

    public static void cancel() { }
}
