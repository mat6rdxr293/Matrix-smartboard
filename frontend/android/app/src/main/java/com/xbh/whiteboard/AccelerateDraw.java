package com.xbh.whiteboard;

import android.graphics.Bitmap;

/**
 * Binding for the board maker's {@code libAccelerateDraw.so}, a public system library on XBH
 * boards. Its JNI names are tied to this class name, so it has to live in this package. The library
 * shows a hardware overlay plane over the whole screen and copies bitmap regions into it.
 */
public final class AccelerateDraw {
    private AccelerateDraw() {}

    private static AccelerateDraw instance;

    /** Null when this is not an XBH board or the library cannot be loaded. */
    public static synchronized AccelerateDraw get() {
        if (instance != null) return instance;
        if (!new java.io.File("/system/lib64/libAccelerateDraw.so").exists()
            && !new java.io.File("/system/lib/libAccelerateDraw.so").exists()) return null;
        try {
            System.loadLibrary("AccelerateDraw");
            instance = new AccelerateDraw();
        } catch (Throwable error) {
            return null;
        }
        return instance;
    }

    /** Called from the library when native event pulling is on; unused here. */
    public void callback(int action, float x, float y, float pressure, float width, float height, int id, int tool) {}

    public native void accelerateInit(int width, int height);
    public native void accelerateDeInit();
    public native void clearAccLayer();
    public native void clearAccLayerRect(int left, int top, int right, int bottom);
    public native String getVersion();
    /** Copies {@code bitmap} from (srcLeft, srcTop) to the screen rect at (left, top) of the given size. */
    public native void refreshAccelerateDrawV2(int left, int top, int width, int height, Bitmap bitmap, int srcLeft, int srcTop, boolean blend);
    public native void setRotate(int degrees);
    public native void setStartEventPull(boolean on);
    public native void startAccelerateDraw();
    // Not used here, but the library registers every one of its methods on load and fails without them.
    public native void showTrackBall(boolean show);
    public native boolean startEraser();
    public native void getActivityBitmap(Bitmap bitmap);
    public native void refreshAccelerateDraw(int left, int top, int width, int height, Bitmap bitmap);
    public native void refreshSurface(android.view.Surface surface, Bitmap bitmap);
    public native boolean stopAccelerateDraw();
}
