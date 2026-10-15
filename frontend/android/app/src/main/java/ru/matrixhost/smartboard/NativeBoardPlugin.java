package ru.matrixhost.smartboard;

import android.graphics.Color;
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

/**
 * Android-only renderer behind the transparent Capacitor WebView.
 * React remains responsible for controls, dialogs, board history and export.
 */
@CapacitorPlugin(name = "NativeBoard")
public class NativeBoardPlugin extends Plugin {
    private NativeBoardView view;
    private int originalWebViewBackground = Color.WHITE;

    @PluginMethod
    public void enable(PluginCall call) {
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
                    });
                    parent.addView(view, parent.indexOfChild(web),
                        new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
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

    @PluginMethod
    public void present(PluginCall call) {
        if (view == null) { call.reject("NativeBoard not enabled"); return; }
        final JSONObject data = call.getData();
        getActivity().runOnUiThread(() -> {
            view.present(data);
            call.resolve();
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
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (view != null) view.setActive(false);
            if (bridge != null) bridge.getWebView().setBackgroundColor(originalWebViewBackground);
            call.resolve();
        });
    }
}
