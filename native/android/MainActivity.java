package com.tuik.editorr;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** Soft black, same as the editor top bar (like CapCut). Used for the status bar and the navigation bar on every screen. */
    private static final int BAR = Color.parseColor("#141416");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EditorrNativePlugin.class);
        super.onCreate(savedInstanceState);
        darkSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        darkSystemBars();
    }

    private void darkSystemBars() {
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(BAR);
        w.setNavigationBarColor(BAR);
        if (Build.VERSION.SDK_INT >= 28) w.setNavigationBarDividerColor(BAR);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
        c.setAppearanceLightStatusBars(false);     // white clock / battery icons
        c.setAppearanceLightNavigationBars(false); // white back / home buttons
    }
}
