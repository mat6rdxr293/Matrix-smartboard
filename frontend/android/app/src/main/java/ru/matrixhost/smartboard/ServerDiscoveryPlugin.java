package ru.matrixhost.smartboard;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(name = "ServerDiscovery")
public class ServerDiscoveryPlugin extends Plugin {
    private static final String SERVICE_TYPE = "_matrixboard._tcp.";
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void discover(PluginCall call) {
        Integer requested = call.getInt("timeoutMs", 2500);
        int timeoutMs = Math.max(800, Math.min(requested == null ? 2500 : requested, 8000));
        mainHandler.post(() -> new DiscoverySession(call, timeoutMs).start());
    }

    private final class DiscoverySession {
        private final PluginCall call;
        private final int timeoutMs;
        private final NsdManager manager;
        private final JSArray servers = new JSArray();
        private final Set<String> seen = new HashSet<>();
        private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
        private boolean resolving = false;
        private boolean finished = false;
        private WifiManager.MulticastLock multicastLock;

        DiscoverySession(PluginCall call, int timeoutMs) {
            this.call = call;
            this.timeoutMs = timeoutMs;
            this.manager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        }

        private final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {}
            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {}
            @Override public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                fail("mDNS discovery не запустился: " + errorCode);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                finish();
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (finished || !serviceInfo.getServiceType().equalsIgnoreCase(SERVICE_TYPE)) return;
                resolveQueue.offer(serviceInfo);
                resolveNext();
            }
        };

        void start() {
            if (manager == null) {
                call.reject("mDNS недоступен на этом устройстве");
                return;
            }
            try {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    multicastLock = wifi.createMulticastLock("matrix-smartboard-mdns");
                    multicastLock.setReferenceCounted(false);
                    multicastLock.acquire();
                }
                manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
                mainHandler.postDelayed(this::finish, timeoutMs);
            } catch (Exception error) {
                fail(clean(error));
            }
        }

        private void resolveNext() {
            if (finished || resolving) return;
            NsdServiceInfo next = resolveQueue.poll();
            if (next == null) return;
            resolving = true;
            try {
                manager.resolveService(next, new NsdManager.ResolveListener() {
                    @Override
                    public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                        resolving = false;
                        mainHandler.postDelayed(DiscoverySession.this::resolveNext, 40);
                    }

                    @Override
                    public void onServiceResolved(NsdServiceInfo serviceInfo) {
                        try {
                            addResolved(serviceInfo);
                        } finally {
                            resolving = false;
                            mainHandler.postDelayed(DiscoverySession.this::resolveNext, 40);
                        }
                    }
                });
            } catch (Exception ignored) {
                resolving = false;
                mainHandler.postDelayed(this::resolveNext, 80);
            }
        }

        private void addResolved(NsdServiceInfo info) {
            InetAddress host = info.getHost();
            if (host == null || info.getPort() <= 0) return;
            Map<String, byte[]> attrs = info.getAttributes();
            String product = attr(attrs, "product");
            if (!"matrix-smartboard".equals(product)) return;
            String serverId = attr(attrs, "serverId");
            if (serverId.isEmpty()) return;
            boolean tls = "1".equals(attr(attrs, "tls"));
            String hostValue = host.getHostAddress();
            if (hostValue == null || hostValue.isBlank()) return;
            String hostForUrl = hostValue.contains(":") ? "[" + hostValue + "]" : hostValue;
            String url = (tls ? "https://" : "http://") + hostForUrl + ":" + info.getPort();
            String dedupe = serverId + "|" + url;
            if (!seen.add(dedupe)) return;

            JSObject server = new JSObject();
            String friendlyName = attr(attrs, "friendlyName");
            server.put("name", friendlyName.isBlank() ? info.getServiceName() : friendlyName);
            server.put("serverId", serverId);
            server.put("serverUrl", url);
            server.put("host", hostValue);
            server.put("port", info.getPort());
            server.put("tls", tls);
            server.put("apiVersion", parseInt(attr(attrs, "apiVersion")));
            server.put("serverVersion", attr(attrs, "serverVersion"));
            servers.put(server);
        }

        private void finish() {
            if (finished) return;
            finished = true;
            try {
                manager.stopServiceDiscovery(discoveryListener);
            } catch (Exception ignored) {}
            releaseMulticast();
            JSObject result = new JSObject();
            result.put("servers", servers);
            call.resolve(result);
        }

        private void fail(String message) {
            if (finished) return;
            finished = true;
            try {
                manager.stopServiceDiscovery(discoveryListener);
            } catch (Exception ignored) {}
            releaseMulticast();
            call.reject(message);
        }

        private void releaseMulticast() {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        }
    }

    private static String attr(Map<String, byte[]> attrs, String key) {
        if (attrs == null) return "";
        byte[] value = attrs.get(key);
        return value == null ? "" : new String(value, StandardCharsets.UTF_8);
    }

    private static int parseInt(String value) {
        try { return Integer.parseInt(value); } catch (Exception ignored) { return 0; }
    }

    private static String clean(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
