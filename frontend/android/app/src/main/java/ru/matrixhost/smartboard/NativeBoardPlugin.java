package ru.matrixhost.smartboard;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android-only renderer behind the transparent Capacitor WebView.
 * React remains responsible for controls, dialogs, board history and export.
 */
@CapacitorPlugin(name = "NativeBoard")
public class NativeBoardPlugin extends Plugin {
    private static final String HEALTH_PREFS = "native_board_health";
    private static final String UNHEALTHY_STARTS = "unhealthyStarts";
    private static final int MAX_UNHEALTHY_STARTS = 2;

    private NativeBoardView view;
    // One worker keeps frames in order while stroke parsing stays off the UI thread.
    private final ExecutorService frames = Executors.newSingleThreadExecutor();
    private ArrayList<NativeBoardView.Stroke> incomingDocument = new ArrayList<>();
    private int originalWebViewBackground = Color.WHITE;

    private SharedPreferences health() {
        return getContext().getSharedPreferences(HEALTH_PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void enable(PluginCall call) {
        // A native crash kills the WebView before localStorage reaches disk, so the start is
        // counted here with a synchronous commit; markHealthy clears it once the board settles.
        int unhealthy = health().getInt(UNHEALTHY_STARTS, 0);
        if (unhealthy >= MAX_UNHEALTHY_STARTS) {
            call.reject("Native board disabled after repeated failed starts", "AUTO_DISABLED");
            return;
        }
        health().edit().putInt(UNHEALTHY_STARTS, unhealthy + 1).commit();
        getActivity().runOnUiThread(() -> {
            try {
                if (view == null) {
                    WebView web = bridge.getWebView();
                    ViewGroup parent = (ViewGroup) web.getParent();
                    if (parent == null) { call.reject("WebView parent unavailable"); return; }
                    originalWebViewBackground = web.getSolidColor();
                    view = new NativeBoardView(getContext());
                    view.setListener(new NativeBoardView.Listener() {
                        @Override public void onStrokeStarted() {
                            notifyListeners("strokeStarted", new JSObject());
                        }
                        @Override public void onStrokeCommitted(JSObject stroke) {
                            JSObject data = new JSObject();
                            data.put("stroke", stroke);
                            notifyListeners("strokeCommitted", data);
                        }
                        @Override public void onViewportChanged(float zoom, float panX, float panY) {
                            JSObject data = new JSObject();
                            data.put("zoom", zoom);
                            data.put("panX", panX);
                            data.put("panY", panY);
                            notifyListeners("viewportChanged", data);
                        }
                        @Override public void onResyncNeeded() {
                            notifyListeners("resyncNeeded", new JSObject());
                        }
                    });
                    parent.addView(view, parent.indexOfChild(web),
                        new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    WetInkLayer wetInk = createWetInk();
                    if (wetInk != null) {
                        // Below the WebView in view order so touches still reach it; its surface
                        // is composited above everything regardless.
                        parent.addView(wetInk.view(), parent.indexOfChild(web),
                            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                        view.setWetInk(wetInk);
                    }
                    ((MainActivity)getActivity()).setNativeBoardView(view);
                    web.setBackgroundColor(Color.TRANSPARENT);
                }
                view.setActive(true);
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to enable NativeBoard", e);
            }
        });
    }

    /** `am start ... --ez wetInk false` turns the front buffer off to compare latency on a device. */
    private WetInkLayer createWetInk() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null;
        if (!getActivity().getIntent().getBooleanExtra("wetInk", true)) return null;
        try {
            return new WetInkLayer(getContext());
        } catch (RuntimeException | LinkageError error) {
            Log.w("MatrixInk", "Front-buffered ink unavailable", error);
            return null;
        }
    }

    @PluginMethod
    public void present(PluginCall call) {
        if (view == null) { call.reject("NativeBoard not enabled"); return; }
        final JSONObject data = call.getData();
        frames.execute(() -> {
            final List<NativeBoardView.Stroke> appended = NativeBoardView.decodeStrokes(data.optJSONArray("appendStrokes"));
            getActivity().runOnUiThread(() -> {
                view.present(data, appended);
                call.resolve();
            });
        });
    }

    /** Full documents arrive in chunks so that no single bridge message can exhaust the Java heap. */
    @PluginMethod
    public void loadStrokes(PluginCall call) {
        if (view == null) { call.reject("NativeBoard not enabled"); return; }
        final JSONObject data = call.getData();
        frames.execute(() -> {
            if (data.optBoolean("first")) incomingDocument = new ArrayList<>();
            List<NativeBoardView.Stroke> chunk = NativeBoardView.decodeStrokes(data.optJSONArray("strokes"));
            if (chunk != null) incomingDocument.addAll(chunk);
            if (!data.optBoolean("last")) { call.resolve(); return; }
            final List<NativeBoardView.Stroke> document = incomingDocument;
            final int revision = data.optInt("revision");
            incomingDocument = new ArrayList<>();
            getActivity().runOnUiThread(() -> {
                view.replaceDocument(document, revision);
                call.resolve();
            });
        });
    }

    @PluginMethod
    public void setBlockers(PluginCall call) {
        if (view == null) { call.resolve(); return; }
        final JSONArray rects = call.getArray("rects");
        getActivity().runOnUiThread(() -> {
            view.setBlockers(rects);
            call.resolve();
        });
    }

    @PluginMethod
    public void markHealthy(PluginCall call) {
        health().edit().remove(UNHEALTHY_STARTS).commit();
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (view != null) view.setActive(false);
            if (bridge != null) bridge.getWebView().setBackgroundColor(originalWebViewBackground);
            call.resolve();
        });
    }
}
