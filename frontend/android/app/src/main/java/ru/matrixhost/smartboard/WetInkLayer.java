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
final class WetInkLayer implements LiveInk {

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
        // A full-screen translucent layer is blended into every frame by SurfaceFlinger, on boards
        // without overlay planes by the GPU at 4K. Kept at alpha 0 between strokes, it is left out.
        surface.setAlpha(0f);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        renderer = new CanvasFrontBufferedRenderer<>(surface, new CanvasFrontBufferedRenderer.Callback<Segment>() {
            @Override
            public void onDrawFrontBufferedLayer(@NonNull Canvas canvas, int bufferWidth, int bufferHeight, @NonNull Segment s) {
                canvas.save();
                canvas.clipRect(s.clipLeft, s.clipTop, s.clipRight, s.clipBottom);
                // This layer sits above the WebView, so without these cuts a stroke dragged onto the
                // toolbar would be drawn over it until the pen lifts.
                float[] c = s.cutouts;
                for (int i = 0; i + 3 < c.length; i += 4) canvas.clipOutRect(c[i], c[i + 1], c[i + 2], c[i + 3]);
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

    @Override public void setShown(boolean shown) { surface.setVisibility(shown ? View.VISIBLE : View.GONE); }

    @Override public void setLatencySink(LatencySink sink) { latencySink = sink; }

    /** UI thread. The first segment shows the layer; it lands in the front buffer either way. */
    @Override public void draw(Segment segment) {
        if (surface.getAlpha() != 1f) surface.setAlpha(1f);
        renderer.renderFrontBufferedLayer(segment);
    }

    /** UI thread. */
    @Override public void clear() {
        renderer.clear();
        surface.setAlpha(0f);
    }

    @Override public void release() { renderer.release(true); }
}
