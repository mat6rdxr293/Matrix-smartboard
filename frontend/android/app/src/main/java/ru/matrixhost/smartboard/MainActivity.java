package ru.matrixhost.smartboard;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.MotionEvent;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NativeBoardView nativeBoard;
    private boolean nativePointerCaptured;

    void setNativeBoardView(NativeBoardView view) { nativeBoard = view; }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            nativePointerCaptured = nativeBoard != null && nativeBoard.canCapture(event);
        }
        if (nativePointerCaptured && nativeBoard != null) {
            nativeBoard.handle(event);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                nativePointerCaptured = false;
            }
            return true;
        }
        return super.dispatchTouchEvent(event);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SshProvisionerPlugin.class);
        registerPlugin(ServerDiscoveryPlugin.class);
        registerPlugin(ServerSecurityPlugin.class);
        registerPlugin(NativeBoardPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new PinnedBridgeWebViewClient(bridge, this));
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
            return;
        }

        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }
}
