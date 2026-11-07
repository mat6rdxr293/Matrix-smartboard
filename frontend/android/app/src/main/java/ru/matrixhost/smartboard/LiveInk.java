package ru.matrixhost.smartboard;

/** The stroke under the pen, shown faster than the board view can redraw. */
interface LiveInk {
    /** Screen-pixel segment. {@code eventTime} is the input event's uptime, kept for latency stats. */
    final class Segment {
        final float x0, y0, x1, y1, width;
        final int color;
        final float clipLeft, clipTop, clipRight, clipBottom;
        /** Screen-pixel rects of UI over the board (left, top, right, bottom, ...), never drawn on. */
        final float[] cutouts;
        final long eventTime;

        Segment(float x0, float y0, float x1, float y1, float width, int color,
                float clipLeft, float clipTop, float clipRight, float clipBottom, float[] cutouts, long eventTime) {
            this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
            this.width = width; this.color = color;
            this.clipLeft = clipLeft; this.clipTop = clipTop; this.clipRight = clipRight; this.clipBottom = clipBottom;
            this.cutouts = cutouts;
            this.eventTime = eventTime;
        }
    }

    interface LatencySink { void record(long millis); }

    /** UI thread. */
    void draw(Segment segment);
    /** UI thread. Called once the board view shows the committed stroke, or the stroke is dropped. */
    void clear();
    void setShown(boolean shown);
    void setLatencySink(LatencySink sink);
    void release();
}
