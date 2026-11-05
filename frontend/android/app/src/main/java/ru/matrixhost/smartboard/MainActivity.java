package ru.matrixhost.smartboard;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.MotionEvent;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NativeBoardView nativeBoard;
    private boolean nativePointerCaptured;

    void setNativeBoardView(NativeBoardView view) { nativeBoard = view; }

    private final int[] boardLocation = new int[2];

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (nativeBoard == null) return super.dispatchTouchEvent(event);
        int action = event.getActionMasked();
        // Window coordinates include anything above the content (a status bar or a window caption),
        // while the board works in its own view's coordinates, so shift the event into them.
        nativeBoard.getLocationInWindow(boardLocation);
        MotionEvent local = MotionEvent.obtain(event);
        local.offsetLocation(-boardLocation[0], -boardLocation[1]);
        try {
            if (action == MotionEvent.ACTION_DOWN) {
                nativePointerCaptured = nativeBoard.canCapture(local);
                // Deliver every pen sample as it arrives instead of batching them to the next frame.
                if (nativePointerCaptured) nativeBoard.requestUnbufferedDispatch(event);
            }
            if (nativePointerCaptured) {
                nativeBoard.handle(local);
                if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    nativePointerCaptured = false;
                }
                return true;
            }
        } finally {
            local.recycle();
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
        // Back first asks the page: an open screen such as help closes instead of the whole app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = bridge != null ? bridge.getWebView() : null;
                if (web == null) {
                    leave(this);
                    return;
                }
                web.evaluateJavascript("Boolean(window.__matrixBack && window.__matrixBack())", result -> {
                    if (!"true".equals(result)) leave(this);
                });
            }
        });
    }

    private void leave(OnBackPressedCallback callback) {
        callback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        callback.setEnabled(true);
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
