package ru.matrixhost.smartboard;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Android ink renderer. Coordinates and stroke document stay in CSS pixels. */
public final class NativeBoardView extends View {
    public interface Listener {
        void onStrokeStarted();
        void onStrokeCommitted(JSObject stroke);
        void onViewportChanged(float zoom, float panX, float panY);
    }

    private static final class Stroke {
        final ArrayList<float[]> points = new ArrayList<>();
        final Path path = new Path();
        int color;
        float width;
        boolean erase;
        void point(float x, float y) {
            if (points.isEmpty()) path.moveTo(x, y);
            else path.lineTo(x, y);
            points.add(new float[]{x, y});
        }
        JSObject toJSON() {
            JSObject json = new JSObject();
            JSONArray array = new JSONArray();
            for (float[] pt : points) {
                JSObject p = new JSObject();
                p.put("x", pt[0]);
                p.put("y", pt[1]);
                array.put(p);
            }
            json.put("points", array);
            json.put("width", width);
            json.put("color", Color.alpha(color) == 255
                ? String.format(java.util.Locale.US, "#%06X", color & 0xFFFFFF)
                : String.format(java.util.Locale.US, "#%06X%02X", color & 0xFFFFFF, Color.alpha(color)));
            json.put("mode", erase ? "erase" : "draw");
            json.put("source", "user");
            return json;
        }
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint clearPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF board = new RectF();
    private final ArrayList<Stroke> strokes = new ArrayList<>();
    private final ArrayList<RectF> blockers = new ArrayList<>();
    private Listener listener;
    private Stroke liveStroke;
    private Stroke previewStroke;
    private boolean active;
    private String mode = "draw";
    private String inputMode = "auto";
    private boolean zoomPanLocked;
    private int inkColor = Color.RED;
    private float inkWidth = 4f;
    private float eraseWidth = 16f;
    private int bg = Color.rgb(10, 14, 20);
    private int appBg = Color.rgb(10, 14, 20);
    private int gridColor = Color.argb(15, 255, 255, 255);
    private float gridStep = 28f;
    private boolean grid = true;
    private boolean lines;
    private float screenCssWidth = 1f, screenCssHeight = 1f;
    private float boardLeft, boardTop, boardWidth, boardHeight;
    private float panX, panY, zoom = 1f;
    private boolean pinching;
    private float pinchDistance, pinchStartZoom, pinchWorldX, pinchWorldY;
    private long lastGestureNotification;

    public NativeBoardView(Context context) {
        super(context);
        setWillNotDraw(false);
        setLayerType(View.LAYER_TYPE_HARDWARE, null);
        clearPaint.setStyle(Paint.Style.STROKE);
        clearPaint.setStrokeCap(Paint.Cap.ROUND);
        clearPaint.setStrokeJoin(Paint.Join.ROUND);
        clearPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
    }

    public void setListener(Listener value) { listener = value; }
    public void setActive(boolean value) {
        active = value;
        liveStroke = null;
        pinching = false;
        setVisibility(value ? VISIBLE : GONE);
        invalidate();
    }

    private static float finite(JSONObject o, String name, float fallback) {
        double n = o.optDouble(name, fallback);
        return Double.isFinite(n) ? (float)n : fallback;
    }
    private static int color(String value, int fallback) {
        try {
            // CSS 8-digit hex is #RRGGBBAA; Android uses #AARRGGBB.
            if (value != null && value.matches("#[0-9a-fA-F]{8}")) {
                return Color.parseColor("#" + value.substring(7) + value.substring(1, 7));
            }
            return Color.parseColor(value);
        } catch (Exception ignored) { return fallback; }
    }
    private float scaleX() { return getWidth() / Math.max(1f, screenCssWidth); }
    private float scaleY() { return getHeight() / Math.max(1f, screenCssHeight); }

    /** Optionally update the stroke document; viewport and tool changes never need retransmitting it. */
    public void present(JSONObject state) {
        if (state == null) return;
        JSONObject viewport = state.optJSONObject("viewport");
        if (viewport != null) {
            screenCssWidth = Math.max(1f, finite(viewport, "screenWidth", screenCssWidth));
            screenCssHeight = Math.max(1f, finite(viewport, "screenHeight", screenCssHeight));
            boardLeft = finite(viewport, "left", boardLeft);
            boardTop = finite(viewport, "top", boardTop);
            boardWidth = Math.max(0f, finite(viewport, "width", boardWidth));
            boardHeight = Math.max(0f, finite(viewport, "height", boardHeight));
        }
        mode = state.optString("mode", mode);
        inputMode = state.optString("inputMode", inputMode);
        zoomPanLocked = state.optBoolean("zoomPanLocked", zoomPanLocked);
        inkColor = color(state.optString("color", ""), inkColor);
        inkWidth = Math.max(0.5f, finite(state, "width", inkWidth));
        eraseWidth = Math.max(0.5f, finite(state, "eraserWidth", eraseWidth));
        bg = color(state.optString("bg", ""), bg);
        appBg = color(state.optString("appBg", ""), appBg);
        gridColor = color(state.optString("gridColor", ""), gridColor);
        grid = state.optBoolean("grid", grid);
        gridStep = Math.max(4f, finite(state, "gridStep", gridStep));
        lines = "lines".equals(state.optString("pattern", "grid"));
        zoom = Math.max(0.25f, finite(state, "zoom", zoom));
        JSONObject pan = state.optJSONObject("pan");
        if (pan != null) {
            panX = finite(pan, "x", panX);
            panY = finite(pan, "y", panY);
        }
        JSONArray incoming = state.optJSONArray("strokes");
        if (incoming != null) {
            strokes.clear();
            for (int i = 0; i < incoming.length(); i++) {
                Stroke stroke = parseStroke(incoming.optJSONObject(i));
                if (stroke != null) strokes.add(stroke);
            }
        }
        previewStroke = parseStroke(state.optJSONObject("preview"));
        invalidate();
    }

    private static Stroke parseStroke(JSONObject item) {
        if (item == null) return null;
        JSONArray points = item.optJSONArray("points");
        if (points == null || points.length() == 0) return null;
        Stroke stroke = new Stroke();
        stroke.color = color(item.optString("color", "#FFFFFF"), Color.WHITE);
        stroke.width = Math.max(0.5f, finite(item, "width", 4f));
        stroke.erase = "erase".equals(item.optString("mode", "draw"));
        for (int j = 0; j < points.length(); j++) {
            JSONObject point = points.optJSONObject(j);
            if (point == null) continue;
            float x = finite(point, "x", Float.NaN), y = finite(point, "y", Float.NaN);
            if (Float.isFinite(x) && Float.isFinite(y)) stroke.point(x, y);
        }
        return stroke.points.isEmpty() ? null : stroke;
    }

    public void setBlockers(JSONArray array) {
        blockers.clear();
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject rect = array.optJSONObject(i);
            if (rect == null) continue;
            float x = finite(rect, "left", 0), y = finite(rect, "top", 0);
            float w = finite(rect, "width", 0), h = finite(rect, "height", 0);
            if (w > 0 && h > 0) blockers.add(new RectF(x, y, x+w, y+h));
        }
    }

    public boolean canCapture(MotionEvent event) {
        if (!active || boardWidth < 2 || boardHeight < 2 || (!"draw".equals(mode) && !"erase".equals(mode))) return false;
        int tool = event.getToolType(0);
        if ("mouse".equals(inputMode) && tool != MotionEvent.TOOL_TYPE_MOUSE) return false;
        if ("touch".equals(inputMode) && tool == MotionEvent.TOOL_TYPE_MOUSE) return false;
        float x = event.getX() / scaleX(), y = event.getY() / scaleY();
        if (x < boardLeft || y < boardTop || x >= boardLeft + boardWidth || y >= boardTop + boardHeight) return false;
        for (RectF r : blockers) if (r.contains(x, y)) return false;
        return true;
    }

    private float worldX(float x) { return ((x / scaleX()) - boardLeft - panX) / zoom; }
    private float worldY(float y) { return ((y / scaleY()) - boardTop - panY) / zoom; }
    private void point(float x, float y) {
        if (liveStroke == null) return;
        float wx = worldX(x), wy = worldY(y);
        if (!liveStroke.points.isEmpty()) {
            float[] last = liveStroke.points.get(liveStroke.points.size()-1);
            float dx = last[0]-wx, dy = last[1]-wy;
            if (dx*dx+dy*dy < 0.35f) return;
        }
        if (liveStroke.points.size() < 4000) liveStroke.point(wx, wy);
    }
    private float distance(MotionEvent e) {
        return (float)Math.hypot(e.getX(0)-e.getX(1), e.getY(0)-e.getY(1));
    }
    private float centerX(MotionEvent e) { return (e.getX(0)+e.getX(1))/2f / scaleX() - boardLeft; }
    private float centerY(MotionEvent e) { return (e.getY(0)+e.getY(1))/2f / scaleY() - boardTop; }

    /** Called from Activity.dispatchTouchEvent so ink doesn't take a JS round-trip. */
    public void handle(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                pinching = false;
                liveStroke = new Stroke();
                liveStroke.erase = "erase".equals(mode);
                liveStroke.width = liveStroke.erase ? eraseWidth : inkWidth;
                liveStroke.color = inkColor;
                point(e.getX(), e.getY());
                if (listener != null) listener.onStrokeStarted();
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (e.getPointerCount() >= 2) {
                    liveStroke = null; // cancel the unfinished mark when starting pinch
                    pinching = true;
                    if (zoomPanLocked) break;
                    pinchDistance = Math.max(1f, distance(e));
                    pinchStartZoom = zoom;
                    pinchWorldX = (centerX(e)-panX)/zoom;
                    pinchWorldY = (centerY(e)-panY)/zoom;
                }
                break;
            case MotionEvent.ACTION_MOVE:
                if (pinching && !zoomPanLocked && e.getPointerCount() >= 2) {
                    float nextZoom = Math.max(0.5f, Math.min(2.5f, pinchStartZoom * distance(e)/pinchDistance));
                    float cx = centerX(e), cy = centerY(e);
                    zoom = nextZoom;
                    panX = cx - pinchWorldX * zoom;
                    panY = cy - pinchWorldY * zoom;
                    long now = android.os.SystemClock.uptimeMillis();
                    if (listener != null && now - lastGestureNotification >= 32L) {
                        lastGestureNotification = now;
                        listener.onViewportChanged(zoom, panX, panY);
                    }
                } else if (!pinching && liveStroke != null) {
                    for (int h = 0; h < e.getHistorySize(); h++) point(e.getHistoricalX(h), e.getHistoricalY(h));
                    point(e.getX(), e.getY());
                }
                break;
            case MotionEvent.ACTION_UP:
                if (pinching) {
                    if (listener != null) listener.onViewportChanged(zoom, panX, panY);
                } else if (liveStroke != null) {
                    point(e.getX(), e.getY());
                    strokes.add(liveStroke);
                    if (listener != null) listener.onStrokeCommitted(liveStroke.toJSON());
                }
                liveStroke = null;
                pinching = false;
                break;
            case MotionEvent.ACTION_CANCEL:
                liveStroke = null;
                pinching = false;
                break;
            default:
                break;
        }
        postInvalidateOnAnimation();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!active) return;
        float sx = scaleX(), sy = scaleY();
        board.set(boardLeft*sx, boardTop*sy, (boardLeft+boardWidth)*sx, (boardTop+boardHeight)*sy);
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(appBg);
        paint.setXfermode(null);
        canvas.drawColor(appBg);
        canvas.save();
        canvas.clipRect(board);
        paint.setColor(bg);
        canvas.drawRect(board, paint);
        if (boardWidth < 2 || boardHeight < 2) { canvas.restore(); return; }

        // Clear-mode strokes erase ink on this off-screen layer, not the board background.
        int layer = canvas.saveLayer(board, null);
        canvas.translate(board.left + panX*sx, board.top + panY*sy);
        canvas.scale(sx*zoom, sy*zoom);
        for (Stroke stroke : strokes) drawStroke(canvas, stroke);
        if (liveStroke != null) drawStroke(canvas, liveStroke);
        if (previewStroke != null) drawStroke(canvas, previewStroke);
        canvas.restoreToCount(layer);

        paint.setColor(gridColor);
        paint.setStrokeWidth(Math.max(0.65f, sx));
        paint.setStyle(Paint.Style.STROKE);
        float step = gridStep * zoom * sx;
        if (grid && step >= 4f) {
            if (!lines) {
                float first = board.left + ((panX*sx) % step + step) % step;
                for (float x = first; x <= board.right; x += step) canvas.drawLine(x, board.top, x, board.bottom, paint);
            }
            float yStep = gridStep * zoom * sy;
            float firstY = board.top + ((panY*sy) % yStep + yStep) % yStep;
            for (float y = firstY; y <= board.bottom; y += yStep) canvas.drawLine(board.left, y, board.right, y, paint);
        }
        canvas.restore();
    }

    private void drawStroke(Canvas canvas, Stroke stroke) {
        if (stroke.points.isEmpty()) return;
        Paint p = stroke.erase ? clearPaint : paint;
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(stroke.width);
        p.setStrokeJoin(Paint.Join.ROUND);
        p.setStrokeCap(Paint.Cap.ROUND);
        if (!stroke.erase) { p.setXfermode(null); p.setColor(stroke.color); }
        if (stroke.points.size() == 1) {
            float[] point = stroke.points.get(0);
            p.setStyle(Paint.Style.FILL);
            canvas.drawCircle(point[0], point[1], Math.max(0.5f, stroke.width/2f), p);
        } else canvas.drawPath(stroke.path, p);
    }
}
