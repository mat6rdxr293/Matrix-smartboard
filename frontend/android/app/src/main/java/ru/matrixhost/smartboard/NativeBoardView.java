package ru.matrixhost.smartboard;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.view.Choreographer;
import android.view.MotionEvent;
import android.view.View;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Android ink renderer. Coordinates and stroke document stay in CSS pixels. */
public final class NativeBoardView extends View {
    public interface Listener {
        void onStrokeStarted();
        void onStrokeCommitted(JSObject stroke);
        void onViewportChanged(float zoom, float panX, float panY);
        void onResyncNeeded();
        void onStrokeHold(int seq, JSObject stroke);
    }

    static final class Stroke {
        // Flat x,y pairs: a large board holds hundreds of thousands of points on a small Java heap.
        float[] xy = new float[32];
        int size;
        final Path path = new Path();
        int color;
        float width;
        boolean erase;
        void replacePoints(JSONArray points) {
            path.reset();
            size = 0;
            for (int i = 0; i < points.length(); i++) {
                JSONObject p = points.optJSONObject(i);
                if (p != null) point((float) p.optDouble("x"), (float) p.optDouble("y"));
            }
        }
        void point(float x, float y) {
            if (size == 0) path.moveTo(x, y);
            else path.lineTo(x, y);
            if (size*2 == xy.length) xy = Arrays.copyOf(xy, xy.length*2);
            xy[size*2] = x;
            xy[size*2+1] = y;
            size++;
        }
        JSObject toJSON() {
            JSObject json = new JSObject();
            JSONArray array = new JSONArray();
            for (int i = 0; i < size; i++) {
                JSObject p = new JSObject();
                p.put("x", xy[i*2]);
                p.put("y", xy[i*2+1]);
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
    private final Paint bitmapPaint = new Paint(Paint.FILTER_BITMAP_FLAG);
    /** Mirror of geometry.ts: keep the constants and rules in step with it. */
    static final class Geometry {
        static final float CM = 40f, RULER_LENGTH = 15 * CM, RULER_WIDTH = 64f, PROTRACTOR_RADIUS = 220f;
        static final float HANDLE_RADIUS = 22f, SNAP = 24f;
        String kind;
        float x, y, angle, px, py;

        static Geometry parse(JSONObject o) {
            if (o == null) return null;
            Geometry g = new Geometry();
            g.kind = o.optString("kind", "");
            g.x = finite(o, "x", 0); g.y = finite(o, "y", 0); g.angle = finite(o, "angle", 0);
            g.px = finite(o, "px", 0); g.py = finite(o, "py", 0);
            return g.kind.isEmpty() ? null : g;
        }

        private float localX(float wx, float wy) { return (float) ((wx - x) * Math.cos(-angle) - (wy - y) * Math.sin(-angle)); }
        private float localY(float wx, float wy) { return (float) ((wx - x) * Math.sin(-angle) + (wy - y) * Math.cos(-angle)); }
        private float[] world(float lx, float ly) {
            return new float[]{(float) (x + lx * Math.cos(angle) - ly * Math.sin(angle)), (float) (y + lx * Math.sin(angle) + ly * Math.cos(angle))};
        }

        boolean hits(float wx, float wy) {
            if ("compass".equals(kind)) {
                float hx = (x + px) / 2, hy = (y + py) / 2;
                return Math.hypot(wx - x, wy - y) <= HANDLE_RADIUS || Math.hypot(wx - hx, wy - hy) <= HANDLE_RADIUS;
            }
            float[] h = "ruler".equals(kind) ? world(RULER_LENGTH / 2 + 34, 0) : world(0, -PROTRACTOR_RADIUS - 30);
            if (Math.hypot(wx - h[0], wy - h[1]) <= HANDLE_RADIUS) return true;
            float lx = localX(wx, wy), ly = localY(wx, wy);
            if ("ruler".equals(kind)) return Math.abs(lx) <= RULER_LENGTH / 2 && Math.abs(ly) <= RULER_WIDTH / 2;
            return ly <= 0 && Math.hypot(lx, ly) <= PROTRACTOR_RADIUS;
        }

        /** {0, ax, ay, bx, by} for a ruler edge, {1, cx, cy, r} for a compass arc, or null. */
        float[] constraint(float wx, float wy) {
            if ("compass".equals(kind)) {
                if (Math.hypot(wx - px, wy - py) > SNAP * 1.5) return null;
                return new float[]{1, x, y, (float) Math.hypot(px - x, py - y)};
            }
            if (!"ruler".equals(kind)) return null;
            float lx = localX(wx, wy), ly = localY(wx, wy);
            if (Math.abs(lx) > RULER_LENGTH / 2 + SNAP) return null;
            float edge = ly < 0 ? -RULER_WIDTH / 2 : RULER_WIDTH / 2;
            if (Math.abs(ly - edge) > SNAP || Math.abs(ly) < RULER_WIDTH / 2) return null;
            float[] a = world(-RULER_LENGTH / 2, edge), b = world(RULER_LENGTH / 2, edge);
            return new float[]{0, a[0], a[1], b[0], b[1]};
        }

        static float[] apply(float[] c, float wx, float wy) {
            if (c[0] == 1) {
                double dx = wx - c[1], dy = wy - c[2], length = Math.max(1e-6, Math.hypot(dx, dy));
                return new float[]{(float) (c[1] + dx / length * c[3]), (float) (c[2] + dy / length * c[3])};
            }
            float dx = c[3] - c[1], dy = c[4] - c[2];
            float t = ((wx - c[1]) * dx + (wy - c[2]) * dy) / (dx * dx + dy * dy);
            return new float[]{c[1] + t * dx, c[2] + t * dy};
        }
    }

    private Geometry geometry;
    private float[] liveConstraint;

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

    // Finished ink lives in one bitmap, so a frame costs the live stroke rather than the whole document.
    private Bitmap inkBitmap;
    private Canvas inkCanvas;
    private boolean inkDirty = true;
    private long lastLiveEventTime;
    private boolean inkCacheFailed;
    private float cachedZoom, cachedPanX, cachedPanY, cachedScaleX, cachedScaleY;
    private int documentRevision = -1;

    private WetInkLayer wetInk;
    private boolean liveIsWet;
    private float wetLastX, wetLastY;
    private final InkLatency latency = new InkLatency();

    // Hold-to-snap: the stroke is sent to JS for shape recognition once the pen rests (see shapeRecognition.ts).
    private static final long SHAPE_HOLD_MS = 500;
    private static final float SHAPE_HOLD_TOLERANCE = 6f;
    private int strokeSeq;
    private boolean liveSnapped;
    private float holdX, holdY;
    private final Runnable shapeHold = () -> {
        if (liveStroke != null && !pinching && !liveSnapped && listener != null) {
            listener.onStrokeHold(strokeSeq, liveStroke.toJSON());
        }
    };

    public NativeBoardView(Context context) {
        super(context);
        setWillNotDraw(false);
        clearPaint.setStyle(Paint.Style.STROKE);
        clearPaint.setStrokeCap(Paint.Cap.ROUND);
        clearPaint.setStrokeJoin(Paint.Join.ROUND);
        clearPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
    }

    public void setListener(Listener value) { listener = value; }

    /** Null keeps the live stroke in this view, which is the path for API < 29 or a renderer failure. */
    public void setWetInk(WetInkLayer layer) {
        wetInk = layer;
        if (layer != null) layer.setLatencySink(latency::record);
    }

    /** Pen-to-render delay inside the app, logged per stroke for on-device comparisons. */
    static final class InkLatency {
        private final long[] samples = new long[512];
        private int count;

        synchronized void record(long millis) {
            if (count < samples.length) samples[count++] = millis;
        }

        synchronized void flush(String path) {
            if (count == 0) return;
            long[] sorted = Arrays.copyOf(samples, count);
            Arrays.sort(sorted);
            long sum = 0;
            for (long value : sorted) sum += value;
            Log.i("MatrixInk", String.format(java.util.Locale.US, "path=%s n=%d avg=%.1f p50=%d p95=%d",
                path, count, sum / (double) count, sorted[count / 2], sorted[Math.min(count - 1, (int) (count * 0.95))]));
            count = 0;
        }
    }
    public void setActive(boolean value) {
        active = value;
        dropLiveStroke();
        dropExtraPens();
        pinching = false;
        setVisibility(value ? VISIBLE : GONE);
        if (wetInk != null) wetInk.view().setVisibility(value ? VISIBLE : GONE);
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
    public void present(JSONObject state, List<Stroke> appended) {
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
        if (appended != null) {
            for (Stroke stroke : appended) commitToDocument(stroke);
        }
        previewStroke = parseStroke(state.optJSONObject("preview"));
        geometry = Geometry.parse(state.optJSONObject("geometry"));
        // JS sends only tails, so falling behind means a commit crossed a full document update.
        if (state.optInt("documentRevision", -1) == documentRevision
            && state.optInt("strokeCount", 0) > strokes.size() && listener != null) {
            listener.onResyncNeeded();
        }
        invalidate();
    }

    public void replaceDocument(List<Stroke> document, int revision) {
        strokes.clear();
        strokes.addAll(document);
        documentRevision = revision;
        inkDirty = true;
        invalidate();
    }

    /** Runs off the UI thread; see encodeNativeStrokes in nativeBoard.ts for the format. */
    static List<Stroke> decodeStrokes(JSONArray incoming) {
        if (incoming == null) return null;
        ArrayList<Stroke> decoded = new ArrayList<>(incoming.length());
        for (int i = 0; i < incoming.length(); i++) {
            JSONObject item = incoming.optJSONObject(i);
            if (item == null) continue;
            FloatBuffer xy = ByteBuffer.wrap(Base64.decode(item.optString("p"), Base64.NO_WRAP))
                .order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
            if (xy.remaining() < 2) continue;
            Stroke stroke = new Stroke();
            stroke.color = color(item.optString("c", "#FFFFFF"), Color.WHITE);
            stroke.width = Math.max(0.5f, finite(item, "w", 4f));
            stroke.erase = item.optBoolean("e", false);
            while (xy.remaining() >= 2) stroke.point(xy.get(), xy.get());
            decoded.add(stroke);
        }
        return decoded;
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
        return stroke.size == 0 ? null : stroke;
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
        return canCaptureAt(event, 0);
    }

    private boolean canCaptureAt(MotionEvent event, int index) {
        if (!active || boardWidth < 2 || boardHeight < 2 || (!"draw".equals(mode) && !"erase".equals(mode))) return false;
        int tool = event.getToolType(index);
        if ("mouse".equals(inputMode) && tool != MotionEvent.TOOL_TYPE_MOUSE) return false;
        if ("touch".equals(inputMode) && tool == MotionEvent.TOOL_TYPE_MOUSE) return false;
        float x = event.getX(index) / scaleX(), y = event.getY(index) / scaleY();
        if (x < boardLeft || y < boardTop || x >= boardLeft + boardWidth || y >= boardTop + boardHeight) return false;
        for (RectF r : blockers) if (r.contains(x, y)) return false;
        // Geometry tools are rotated shapes, so they are hit-tested here rather than as blocker rects.
        if (geometry != null && geometry.hits(worldX(event.getX(index)), worldY(event.getY(index)))) return false;
        return true;
    }

    private float worldX(float x) { return ((x / scaleX()) - boardLeft - panX) / zoom; }
    private float worldY(float y) { return ((y / scaleY()) - boardTop - panY) / zoom; }
    private void point(float x, float y) {
        pointTo(liveStroke, liveConstraint, x, y);
    }

    private void pointTo(Stroke stroke, float[] constraint, float x, float y) {
        if (stroke == null) return;
        float wx = worldX(x), wy = worldY(y);
        if (constraint != null) {
            float[] snapped = Geometry.apply(constraint, wx, wy);
            wx = snapped[0];
            wy = snapped[1];
        }
        if (stroke.size > 0) {
            float dx = stroke.xy[stroke.size*2-2]-wx, dy = stroke.xy[stroke.size*2-1]-wy;
            if (dx*dx+dy*dy < 0.35f) return;
        }
        if (stroke.size < 4000) stroke.point(wx, wy);
    }

    /** A second writer at the board: drawn by this view, without the wet layer or shape snapping. */
    private static final class ExtraPen {
        final Stroke stroke = new Stroke();
        float[] constraint;
    }

    private final android.util.SparseArray<ExtraPen> extraPens = new android.util.SparseArray<>();
    private int primaryPointerId = -1;
    private long primaryDownTime;
    private float primaryDownX, primaryDownY;

    /** Two fingers landing together mean zoom; a second touch while the first is already writing is another pen. */
    private boolean isSecondPen(MotionEvent e, int index) {
        if (zoomPanLocked || e.getToolType(index) == MotionEvent.TOOL_TYPE_STYLUS) return true;
        if (liveStroke == null) return false;
        int primary = e.findPointerIndex(primaryPointerId);
        if (primary < 0) return true;
        float moved = (float) Math.hypot(e.getX(primary) - primaryDownX, e.getY(primary) - primaryDownY);
        return e.getEventTime() - primaryDownTime > SECOND_PEN_AFTER_MS || moved > SECOND_PEN_AFTER_MOVE * scaleX();
    }

    private static final long SECOND_PEN_AFTER_MS = 250;
    private static final float SECOND_PEN_AFTER_MOVE = 24f;

    private Stroke newStroke() {
        Stroke stroke = new Stroke();
        stroke.erase = "erase".equals(mode);
        stroke.width = stroke.erase ? eraseWidth : inkWidth;
        stroke.color = inkColor;
        return stroke;
    }

    private void commitStroke(Stroke stroke) {
        commitToDocument(stroke);
        if (listener != null) listener.onStrokeCommitted(stroke.toJSON());
    }

    private void commitPrimary(MotionEvent e, int index) {
        removeCallbacks(shapeHold);
        if (liveStroke == null) return;
        if (!liveSnapped && index >= 0) point(e.getX(index), e.getY(index));
        commitStroke(liveStroke);
        if (liveIsWet) clearWetInkAfterCommit();
        latency.flush(liveIsWet ? "front-buffer" : "view");
        liveStroke = null;
        liveIsWet = false;
        primaryPointerId = -1;
    }

    private void commitExtra(MotionEvent e, int index, int pointerId) {
        ExtraPen pen = extraPens.get(pointerId);
        if (pen == null) return;
        pointTo(pen.stroke, pen.constraint, e.getX(index), e.getY(index));
        commitStroke(pen.stroke);
        extraPens.remove(pointerId);
    }

    private void dropExtraPens() {
        for (int i = 0; i < extraPens.size(); i++) if (extraPens.valueAt(i).stroke.erase) inkDirty = true;
        extraPens.clear();
    }
    private float distance(MotionEvent e) {
        return (float)Math.hypot(e.getX(0)-e.getX(1), e.getY(0)-e.getY(1));
    }
    private float centerX(MotionEvent e) { return (e.getX(0)+e.getX(1))/2f / scaleX() - boardLeft; }
    private float centerY(MotionEvent e) { return (e.getY(0)+e.getY(1))/2f / scaleY() - boardTop; }

    private void wetSegment(float x0, float y0, float x1, float y1, long eventTime) {
        float sx = scaleX(), sy = scaleY();
        wetInk.draw(new WetInkLayer.Segment(x0, y0, x1, y1, liveStroke.width * sx * zoom, liveStroke.color,
            boardLeft*sx, boardTop*sy, (boardLeft+boardWidth)*sx, (boardTop+boardHeight)*sy, eventTime));
        wetLastX = x1;
        wetLastY = y1;
    }

    private void armShapeHold(float x, float y) {
        holdX = x;
        holdY = y;
        removeCallbacks(shapeHold);
        postDelayed(shapeHold, SHAPE_HOLD_MS);
    }

    /** JS recognized a shape for the stroke still under the pen. */
    public void replaceLiveStroke(int seq, JSONArray points) {
        if (liveStroke == null || seq != strokeSeq || points == null || points.length() == 0) return;
        liveStroke.replacePoints(points);
        liveSnapped = true;
        if (liveIsWet) {
            // The wet layer holds the raw scribble; the view draws the clean shape from here on.
            wetInk.clear();
            liveIsWet = false;
        }
        invalidate();
    }

    /** The board view shows a committed stroke one frame later; clear the wet copy only after that. */
    private void clearWetInkAfterCommit() {
        final WetInkLayer layer = wetInk;
        Choreographer.getInstance().postFrameCallback(first ->
            Choreographer.getInstance().postFrameCallback(second -> layer.clear()));
    }

    /** Called from Activity.dispatchTouchEvent so ink doesn't take a JS round-trip. */
    public void handle(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                pinching = false;
                extraPens.clear();
                primaryPointerId = e.getPointerId(0);
                primaryDownTime = e.getEventTime();
                primaryDownX = e.getX();
                primaryDownY = e.getY();
                liveStroke = newStroke();
                strokeSeq++;
                liveSnapped = false;
                liveConstraint = liveStroke.erase || geometry == null ? null
                    : geometry.constraint(worldX(e.getX()), worldY(e.getY()));
                point(e.getX(), e.getY());
                if (!liveStroke.erase && liveConstraint == null) armShapeHold(e.getX(), e.getY());
                // Translucent ink would darken where segments overlap, and erasing needs the cache.
                // A constrained stroke is drawn where the tool puts it, not under the pen, so it skips the wet layer.
                liveIsWet = wetInk != null && !liveStroke.erase && Color.alpha(inkColor) == 255 && liveConstraint == null;
                if (liveIsWet) wetSegment(e.getX(), e.getY(), e.getX(), e.getY(), e.getEventTime());
                else latency.record(0);
                if (listener != null) listener.onStrokeStarted();
                break;
            case MotionEvent.ACTION_POINTER_DOWN: {
                int index = e.getActionIndex();
                if (pinching) break;
                if (isSecondPen(e, index)) {
                    if (!canCaptureAt(e, index)) break; // a hand resting on the toolbar is not a pen
                    ExtraPen pen = new ExtraPen();
                    Stroke s = newStroke();
                    pen.stroke.erase = s.erase;
                    pen.stroke.width = s.width;
                    pen.stroke.color = s.color;
                    pen.constraint = pen.stroke.erase || geometry == null ? null
                        : geometry.constraint(worldX(e.getX(index)), worldY(e.getY(index)));
                    pointTo(pen.stroke, pen.constraint, e.getX(index), e.getY(index));
                    extraPens.put(e.getPointerId(index), pen);
                    // The wet layer is cleared whole on pen-up, which would wipe the other writer's
                    // live ink, so while two people write both strokes come from this view.
                    removeCallbacks(shapeHold);
                    if (liveIsWet) {
                        wetInk.clear();
                        liveIsWet = false;
                    }
                    break;
                }
                if (extraPens.size() > 0) break;
                removeCallbacks(shapeHold);
                if (liveIsWet) wetInk.clear();
                liveIsWet = false;
                dropLiveStroke(); // cancel the unfinished mark when starting pinch
                pinching = true;
                if (zoomPanLocked) break;
                pinchDistance = Math.max(1f, distance(e));
                pinchStartZoom = zoom;
                pinchWorldX = (centerX(e)-panX)/zoom;
                pinchWorldY = (centerY(e)-panY)/zoom;
                break;
            }
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
                    break;
                }
                if (pinching) break;
                for (int i = 0; i < e.getPointerCount(); i++) {
                    ExtraPen pen = extraPens.get(e.getPointerId(i));
                    if (pen == null) continue;
                    for (int h = 0; h < e.getHistorySize(); h++) pointTo(pen.stroke, pen.constraint, e.getHistoricalX(i, h), e.getHistoricalY(i, h));
                    pointTo(pen.stroke, pen.constraint, e.getX(i), e.getY(i));
                }
                int pi = e.findPointerIndex(primaryPointerId);
                if (liveStroke != null && pi >= 0 && !liveSnapped) {
                    float tolerance = SHAPE_HOLD_TOLERANCE * scaleX() * zoom;
                    if (extraPens.size() == 0 && !liveStroke.erase && liveConstraint == null
                        && Math.hypot(e.getX(pi) - holdX, e.getY(pi) - holdY) > tolerance) {
                        armShapeHold(e.getX(pi), e.getY(pi));
                    }
                    for (int h = 0; h < e.getHistorySize(); h++) {
                        point(e.getHistoricalX(pi, h), e.getHistoricalY(pi, h));
                        if (liveIsWet) wetSegment(wetLastX, wetLastY, e.getHistoricalX(pi, h), e.getHistoricalY(pi, h), e.getHistoricalEventTime(h));
                    }
                    point(e.getX(pi), e.getY(pi));
                    if (liveIsWet) {
                        wetSegment(wetLastX, wetLastY, e.getX(pi), e.getY(pi), e.getEventTime());
                        return; // the board view has nothing new to draw until the stroke ends
                    }
                    lastLiveEventTime = e.getEventTime();
                }
                break;
            case MotionEvent.ACTION_POINTER_UP: {
                if (pinching) break;
                int index = e.getActionIndex();
                int id = e.getPointerId(index);
                if (id == primaryPointerId) commitPrimary(e, index);
                else commitExtra(e, index, id);
                break;
            }
            case MotionEvent.ACTION_UP:
                removeCallbacks(shapeHold);
                if (pinching) {
                    if (listener != null) listener.onViewportChanged(zoom, panX, panY);
                } else {
                    int id = e.getPointerId(0);
                    if (id == primaryPointerId) commitPrimary(e, 0);
                    else commitExtra(e, 0, id);
                }
                liveStroke = null;
                liveIsWet = false;
                extraPens.clear();
                primaryPointerId = -1;
                pinching = false;
                break;
            case MotionEvent.ACTION_CANCEL:
                removeCallbacks(shapeHold);
                if (liveIsWet) wetInk.clear();
                liveIsWet = false;
                dropLiveStroke();
                dropExtraPens();
                primaryPointerId = -1;
                pinching = false;
                break;
            default:
                break;
        }
        postInvalidateOnAnimation();
    }

    /** A live eraser has already cut into the cache, so abandoning it needs a rebuild. */
    private void dropLiveStroke() {
        if (liveStroke != null && liveStroke.erase) inkDirty = true;
        liveStroke = null;
    }

    private void commitToDocument(Stroke stroke) {
        strokes.add(stroke);
        if (inkCanvas != null && !inkDirty && cacheMatchesView(scaleX(), scaleY())) drawIntoCache(stroke);
    }

    private boolean cacheMatchesView(float sx, float sy) {
        return cachedZoom == zoom && cachedPanX == panX && cachedPanY == panY
            && cachedScaleX == sx && cachedScaleY == sy;
    }

    private void applyInkTransform(Canvas canvas, float sx, float sy) {
        canvas.translate(panX*sx, panY*sy);
        canvas.scale(sx*zoom, sy*zoom);
    }

    private void drawIntoCache(Stroke stroke) {
        int save = inkCanvas.save();
        applyInkTransform(inkCanvas, cachedScaleX, cachedScaleY);
        drawStroke(inkCanvas, stroke);
        inkCanvas.restoreToCount(save);
    }

    private boolean ensureInkBitmap(int width, int height) {
        if (inkCacheFailed || width <= 0 || height <= 0) return false;
        if (inkBitmap != null && inkBitmap.getWidth() == width && inkBitmap.getHeight() == height) return true;
        if (inkBitmap != null) inkBitmap.recycle();
        inkBitmap = null;
        inkCanvas = null;
        try {
            inkBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            inkCanvas = new Canvas(inkBitmap);
            inkDirty = true;
            return true;
        } catch (OutOfMemoryError error) {
            inkCacheFailed = true; // Keep drawing straight to the screen rather than losing ink.
            return false;
        }
    }

    private void rebuildInkCache(float sx, float sy) {
        inkBitmap.eraseColor(Color.TRANSPARENT);
        cachedZoom = zoom;
        cachedPanX = panX;
        cachedPanY = panY;
        cachedScaleX = sx;
        cachedScaleY = sy;
        inkDirty = false;
        for (Stroke stroke : strokes) drawIntoCache(stroke);
    }

    private void drawInk(Canvas canvas, float sx, float sy) {
        boolean cached = ensureInkBitmap(Math.round(board.width()), Math.round(board.height()));
        if (!cached) {
            // Clear-mode strokes erase ink on this off-screen layer, not the board background.
            int layer = canvas.saveLayer(board, null);
            canvas.translate(board.left, board.top);
            applyInkTransform(canvas, sx, sy);
            for (Stroke stroke : strokes) drawStroke(canvas, stroke);
            if (liveStroke != null) drawStroke(canvas, liveStroke);
            for (int i = 0; i < extraPens.size(); i++) drawStroke(canvas, extraPens.valueAt(i).stroke);
            if (previewStroke != null) drawStroke(canvas, previewStroke);
            canvas.restoreToCount(layer);
            return;
        }
        boolean matches = cacheMatchesView(sx, sy);
        if (inkDirty || (!matches && !pinching)) {
            rebuildInkCache(sx, sy);
            matches = true;
        }
        if (liveStroke != null && liveStroke.erase && matches) drawIntoCache(liveStroke);
        for (int i = 0; i < extraPens.size() && matches; i++) {
            if (extraPens.valueAt(i).stroke.erase) drawIntoCache(extraPens.valueAt(i).stroke);
        }
        if (matches) {
            canvas.drawBitmap(inkBitmap, board.left, board.top, bitmapPaint);
        } else {
            // Stretch the cache during a pinch; the sharp rebuild happens when the fingers lift.
            float ratio = zoom / cachedZoom;
            int save = canvas.save();
            canvas.translate(board.left + (panX - cachedPanX*ratio)*sx, board.top + (panY - cachedPanY*ratio)*sy);
            canvas.scale(ratio, ratio);
            canvas.drawBitmap(inkBitmap, 0f, 0f, bitmapPaint);
            canvas.restoreToCount(save);
        }
        int save = canvas.save();
        canvas.translate(board.left, board.top);
        applyInkTransform(canvas, sx, sy);
        if (liveStroke != null && !liveStroke.erase && !liveIsWet) drawStroke(canvas, liveStroke);
        for (int i = 0; i < extraPens.size(); i++) {
            if (!extraPens.valueAt(i).stroke.erase) drawStroke(canvas, extraPens.valueAt(i).stroke);
        }
        if (previewStroke != null) drawStroke(canvas, previewStroke);
        canvas.restoreToCount(save);
        if (liveStroke != null && !liveIsWet && lastLiveEventTime > 0) {
            latency.record(android.os.SystemClock.uptimeMillis() - lastLiveEventTime);
            lastLiveEventTime = 0;
        }
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

        drawInk(canvas, sx, sy);

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
        if (stroke.size == 0) return;
        Paint p = stroke.erase ? clearPaint : paint;
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(stroke.width);
        p.setStrokeJoin(Paint.Join.ROUND);
        p.setStrokeCap(Paint.Cap.ROUND);
        if (!stroke.erase) { p.setXfermode(null); p.setColor(stroke.color); }
        if (stroke.size == 1) {
            p.setStyle(Paint.Style.FILL);
            canvas.drawCircle(stroke.xy[0], stroke.xy[1], Math.max(0.5f, stroke.width/2f), p);
        } else canvas.drawPath(stroke.path, p);
    }
}
