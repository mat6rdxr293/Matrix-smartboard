package ru.matrixhost.smartboard;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.os.SystemClock;
import android.view.SurfaceView;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.graphics.lowlatency.CanvasFrontBufferedRenderer;

import java.util.Collection;

/**
 * The stroke under the pen, drawn straight into the buffer being scanned out. It skips the frame
 * queue and SurfaceFlinger composition that the board view waits for, which is most of the
 * pen-to-ink delay. Finished strokes move to {@link NativeBoardView}; this layer only ever holds
 * the live one.
 */
@RequiresApi(29)
final class WetInkLayer {
    /** Screen-pixel segment. {@code eventTime} is the input event's uptime, kept for latency stats. */
    static final class Segment {
        final float x0, y0, x1, y1, width;
        final int color;
        final float clipLeft, clipTop, clipRight, clipBottom;
        final long eventTime;

        Segment(float x0, float y0, float x1, float y1, float width, int color,
                float clipLeft, float clipTop, float clipRight, float clipBottom, long eventTime) {
            this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
            this.width = width; this.color = color;
            this.clipLeft = clipLeft; this.clipTop = clipTop; this.clipRight = clipRight; this.clipBottom = clipBottom;
            this.eventTime = eventTime;
        }
    }

    interface LatencySink { void record(long millis); }

    private final SurfaceView surface;
    private final CanvasFrontBufferedRenderer<Segment> renderer;
    // Only the renderer's thread touches this paint.
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private volatile LatencySink latencySink;

    WetInkLayer(Context context) {
        surface = new SurfaceView(context);
        // Above the WebView so ink is never hidden behind it; transparent everywhere else.
        surface.setZOrderOnTop(true);
        surface.getHolder().setFormat(PixelFormat.TRANSLUCENT);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        renderer = new CanvasFrontBufferedRenderer<>(surface, new CanvasFrontBufferedRenderer.Callback<Segment>() {
            @Override
            public void onDrawFrontBufferedLayer(@NonNull Canvas canvas, int bufferWidth, int bufferHeight, @NonNull Segment s) {
                canvas.save();
                canvas.clipRect(s.clipLeft, s.clipTop, s.clipRight, s.clipBottom);
                paint.setColor(s.color);
                paint.setStrokeWidth(s.width);
                canvas.drawLine(s.x0, s.y0, s.x1, s.y1, paint);
                canvas.restore();
                LatencySink sink = latencySink;
                if (sink != null) sink.record(SystemClock.uptimeMillis() - s.eventTime);
            }

            @Override
            public void onDrawMultiBufferedLayer(@NonNull Canvas canvas, int bufferWidth, int bufferHeight, @NonNull Collection<? extends Segment> params) {
                // Committed ink lives in the board view, so the slow layer stays empty.
                canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
            }
        });
    }

    View view() { return surface; }

    void setLatencySink(LatencySink sink) { latencySink = sink; }

    void draw(Segment segment) { renderer.renderFrontBufferedLayer(segment); }

    void clear() { renderer.clear(); }

    void release() { renderer.release(true); }
}
