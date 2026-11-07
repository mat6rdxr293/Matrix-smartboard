package ru.matrixhost.smartboard;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;

import com.xbh.whiteboard.AccelerateDraw;

/**
 * Live ink on XBH boards, the way the board's own whiteboard does it: while the pen is down the
 * maker's library shows a hardware overlay plane above the whole screen, and each new piece of the
 * stroke is drawn on the CPU and copied into that plane as a small rect. Neither the GPU nor
 * SurfaceFlinger is involved, so the cost per segment does not grow with the screen or with how
 * much is already on the board.
 */
final class XbhAccelInk implements LiveInk {
    private static final String TAG = "MatrixInk";
    /** The overlay stays up this long after the stroke is committed, so the board view is on screen under it. */
    private static final long CLEAR_DELAY_MS = 120;

    private final AccelerateDraw lib;
    private final View anchor;
    private final int screenWidth, screenHeight;
    private final Handler worker;
    private final Handler main = new Handler(android.os.Looper.getMainLooper());
    private final int[] offset = new int[2];

    // Worker thread only.
    private final Bitmap bitmap;
    private final Canvas canvas;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Rect dirty = new Rect();
    private boolean started;
    private boolean overlayDirty;

    /** Bumped on the UI thread for every stroke, so a late clear never wipes the next one. */
    private int generation;
    private volatile LatencySink latencySink;

    static XbhAccelInk create(View anchor, int screenWidth, int screenHeight) {
        AccelerateDraw lib = AccelerateDraw.get();
        if (lib == null) return null;
        try {
            return new XbhAccelInk(lib, anchor, screenWidth, screenHeight);
        } catch (Throwable error) {
            Log.w(TAG, "XBH overlay ink unavailable", error);
            return null;
        }
    }

    private XbhAccelInk(AccelerateDraw lib, View anchor, int screenWidth, int screenHeight) {
        this.lib = lib;
        this.anchor = anchor;
        this.screenWidth = screenWidth;
        this.screenHeight = screenHeight;
        bitmap = Bitmap.createBitmap(screenWidth, screenHeight, Bitmap.Config.ARGB_8888);
        canvas = new Canvas(bitmap);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        HandlerThread thread = new HandlerThread("XbhInk", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY);
        thread.start();
        worker = new Handler(thread.getLooper());
        worker.post(() -> {
            lib.accelerateInit(screenWidth, screenHeight);
            lib.clearAccLayer();
            Log.i(TAG, "path=xbh-overlay version=" + lib.getVersion() + " size=" + screenWidth + "x" + screenHeight);
        });
    }

    @Override
    public void draw(Segment s) {
        anchor.getLocationOnScreen(offset);
        final int dx = offset[0], dy = offset[1];
        final boolean first = !strokeOpen;
        if (first) { strokeOpen = true; generation++; }
        worker.post(() -> drawOnWorker(s, dx, dy, first));
    }

    /** UI thread: a stroke is being drawn and has not been cleared yet. */
    private boolean strokeOpen;

    private void drawOnWorker(Segment s, int dx, int dy, boolean first) {
        if (first && !started) {
            lib.startAccelerateDraw();
            started = true;
        }
        float half = s.width / 2f + 2f;
        dirty.set((int) Math.floor(Math.min(s.x0, s.x1) - half) + dx, (int) Math.floor(Math.min(s.y0, s.y1) - half) + dy,
            (int) Math.ceil(Math.max(s.x0, s.x1) + half) + dx, (int) Math.ceil(Math.max(s.y0, s.y1) + half) + dy);
        if (!dirty.intersect(Math.round(s.clipLeft) + dx, Math.round(s.clipTop) + dy, Math.round(s.clipRight) + dx, Math.round(s.clipBottom) + dy)) return;
        if (!dirty.intersect(0, 0, screenWidth, screenHeight)) return;
        canvas.save();
        canvas.translate(dx, dy);
        canvas.clipRect(s.clipLeft, s.clipTop, s.clipRight, s.clipBottom);
        float[] c = s.cutouts;
        for (int i = 0; i + 3 < c.length; i += 4) canvas.clipOutRect(c[i], c[i + 1], c[i + 2], c[i + 3]);
        paint.setColor(s.color);
        paint.setStrokeWidth(s.width);
        canvas.drawLine(s.x0, s.y0, s.x1, s.y1, paint);
        canvas.restore();
        lib.refreshAccelerateDrawV2(dirty.left, dirty.top, dirty.width(), dirty.height(), bitmap, dirty.left, dirty.top, true);
        overlayDirty = true;
        LatencySink sink = latencySink;
        if (sink != null) sink.record(SystemClock.uptimeMillis() - s.eventTime);
    }

    @Override
    public void clear() {
        strokeOpen = false;
        final int at = generation;
        worker.post(() -> {
            if (started) {
                lib.stopAccelerateDraw();
                started = false;
            }
        });
        // The overlay sits above everything; it is wiped only after the board view has had time to
        // show the stroke underneath, and not at all if the next stroke has already begun.
        main.postDelayed(() -> {
            if (strokeOpen || generation != at) return;
            worker.post(() -> {
                if (started || !overlayDirty) return;
                bitmap.eraseColor(0);
                lib.clearAccLayer();
                overlayDirty = false;
            });
        }, CLEAR_DELAY_MS);
    }

    @Override
    public void setShown(boolean shown) {
        if (!shown) clear();
    }

    @Override
    public void setLatencySink(LatencySink sink) { latencySink = sink; }

    @Override
    public void release() {
        worker.post(() -> {
            if (started) lib.stopAccelerateDraw();
            started = false;
            lib.clearAccLayer();
            worker.getLooper().quitSafely();
        });
    }
}
