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

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

@CapacitorPlugin(name = "ServerDiscovery")
public class ServerDiscoveryPlugin extends Plugin {
    private static final String SERVICE_TYPE = "_matrixboard._tcp.";
    private static final int DEFAULT_SERVER_PORT = 8443;
    private static final int SCAN_CONNECT_TIMEOUT_MS = 140;
    private static final int STATUS_CONNECT_TIMEOUT_MS = 450;
    private static final int STATUS_READ_TIMEOUT_MS = 800;
    private static final int SCAN_THREADS = 28;
    private static final int MAX_SCAN_SUBNETS = 3;
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
        private volatile boolean finished = false;
        private boolean mdnsStarted = false;
        private boolean fastFinishScheduled = false;
        private WifiManager.MulticastLock multicastLock;
        private ExecutorService scanExecutor;

        DiscoverySession(PluginCall call, int timeoutMs) {
            this.call = call;
            this.timeoutMs = timeoutMs;
            this.manager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        }

        private final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {
                mdnsStarted = true;
            }

            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {}
            @Override public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                mdnsStarted = false;
                // Do not reject the whole search. Some hotspot/guest networks block
                // multicast while direct HTTPS to peers still works, so subnet
                // discovery remains a valid fallback.
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                // Results collected by either mDNS or subnet scan are still valid.
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (finished || !serviceInfo.getServiceType().equalsIgnoreCase(SERVICE_TYPE)) return;
                resolveQueue.offer(serviceInfo);
                resolveNext();
            }
        };

        void start() {
            acquireMulticast();

            if (manager != null) {
                try {
                    manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
                } catch (Exception ignored) {
                    mdnsStarted = false;
                }
            }

            long fallbackDelayMs = Math.min(900L, Math.max(200L, timeoutMs / 4L));
            mainHandler.postDelayed(() -> {
                if (!finished && seen.isEmpty()) startSubnetFallback();
            }, fallbackDelayMs);
            mainHandler.postDelayed(this::finish, timeoutMs);
        }

        private void acquireMulticast() {
            try {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi == null) return;
                multicastLock = wifi.createMulticastLock("matrix-smartboard-mdns");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            } catch (Exception ignored) {
                multicastLock = null;
            }
        }

        private void startSubnetFallback() {
            scanExecutor = Executors.newFixedThreadPool(SCAN_THREADS);
            scanExecutor.execute(() -> {
                Set<Integer> subnetBases = localSubnetBases();
                if (subnetBases.isEmpty() || finished) return;

                Set<Integer> localIps = localIpv4Ints();
                for (int base : subnetBases) {
                    if (finished) break;
                    for (int host = 1; host <= 254; host++) {
                        int candidate = base | host;
                        if (localIps.contains(candidate)) continue;
                        final String address = intToIpv4(candidate);
                        try {
                            scanExecutor.submit(() -> probeCandidate(address));
                        } catch (Exception ignored) {
                            return;
                        }
                    }
                }
            });
        }

        private void probeCandidate(String address) {
            if (finished) return;

            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(address, DEFAULT_SERVER_PORT), SCAN_CONNECT_TIMEOUT_MS);
            } catch (Exception ignored) {
                return;
            }

            if (finished) return;
            try {
                URL url = new URL("https://" + address + ":" + DEFAULT_SERVER_PORT + "/api/status");
                HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
                connection.setSSLSocketFactory(insecureSocketFactory());
                connection.setHostnameVerifier(INSECURE_HOSTNAME_VERIFIER);
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(STATUS_CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(STATUS_READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/json");

                int code = connection.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    connection.disconnect();
                    return;
                }

                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)
                )) {
                    String line;
                    while ((line = reader.readLine()) != null && body.length() < 65_536) {
                        body.append(line);
                    }
                } finally {
                    connection.disconnect();
                }

                JSONObject status = new JSONObject(body.toString());
                if (!"matrix-smartboard".equals(status.optString("product", ""))) return;
                String serverId = status.optString("serverId", "").trim();
                if (serverId.isEmpty()) return;

                mainHandler.post(() -> addScanned(address, status));
            } catch (Exception ignored) {
                // Closed/non-Matrix ports are expected during the local scan.
            }
        }

        private void addScanned(String hostValue, JSONObject status) {
            if (finished) return;

            String serverId = status.optString("serverId", "").trim();
            if (serverId.isEmpty()) return;
            String url = "https://" + hostValue + ":" + DEFAULT_SERVER_PORT;
            String dedupe = serverId + "|" + url;
            if (!seen.add(dedupe)) return;

            JSObject server = new JSObject();
            String friendlyName = status.optString("serverName", "").trim();
            server.put("name", friendlyName.isEmpty() ? "Matrix Smartboard" : friendlyName);
            server.put("serverId", serverId);
            server.put("serverUrl", url);
            server.put("host", hostValue);
            server.put("port", DEFAULT_SERVER_PORT);
            server.put("tls", true);
            server.put("apiVersion", status.optInt("apiVersion", 0));
            server.put("serverVersion", status.optString("serverVersion", ""));
            server.put("discovery", "subnet");
            servers.put(server);

            if (!fastFinishScheduled) {
                fastFinishScheduled = true;
                // Give parallel probes a short window to add other Matrix servers.
                mainHandler.postDelayed(this::finish, 450);
            }
        }

        private void resolveNext() {
            if (finished || resolving || manager == null) return;
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
            server.put("discovery", "mdns");
            servers.put(server);
        }

        private void finish() {
            if (finished) return;
            finished = true;

            if (manager != null && mdnsStarted) {
                try {
                    manager.stopServiceDiscovery(discoveryListener);
                } catch (Exception ignored) {}
            }

            if (scanExecutor != null) {
                scanExecutor.shutdownNow();
                scanExecutor = null;
            }

            releaseMulticast();
            JSObject result = new JSObject();
            result.put("servers", servers);
            call.resolve(result);
        }

        private void releaseMulticast() {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        }
    }

    private static Set<Integer> localSubnetBases() {
        Set<Integer> result = new HashSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return result;

            for (NetworkInterface network : Collections.list(interfaces)) {
                if (result.size() >= MAX_SCAN_SUBNETS) break;
                try {
                    if (!network.isUp() || network.isLoopback()) continue;
                } catch (Exception ignored) {
                    continue;
                }

                String name = network.getName() == null ? "" : network.getName().toLowerCase();
                if (isIgnoredInterface(name)) continue;

                Enumeration<InetAddress> addresses = network.getInetAddresses();
                for (InetAddress address : Collections.list(addresses)) {
                    if (!(address instanceof Inet4Address)) continue;
                    byte[] raw = address.getAddress();
                    if (!isPrivateIpv4(raw)) continue;
                    int value = ipv4ToInt(raw);
                    result.add(value & 0xFFFFFF00);
                    if (result.size() >= MAX_SCAN_SUBNETS) break;
                }
            }
        } catch (Exception ignored) {}
        return result;
    }

    private static Set<Integer> localIpv4Ints() {
        Set<Integer> result = new HashSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return result;
            for (NetworkInterface network : Collections.list(interfaces)) {
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                for (InetAddress address : Collections.list(addresses)) {
                    if (address instanceof Inet4Address) result.add(ipv4ToInt(address.getAddress()));
                }
            }
        } catch (Exception ignored) {}
        return result;
    }

    private static boolean isIgnoredInterface(String name) {
        return name.startsWith("lo")
            || name.startsWith("rmnet")
            || name.startsWith("rev_rmnet")
            || name.startsWith("r_rmnet")
            || name.startsWith("ccmni")
            || name.startsWith("pdp")
            || name.startsWith("wwan")
            || name.startsWith("cell")
            || name.startsWith("tun")
            || name.startsWith("ppp")
            || name.startsWith("dummy")
            || name.startsWith("sit")
            || name.startsWith("ip6tnl")
            || name.startsWith("clat")
            || name.startsWith("v4-");
    }

    private static boolean isPrivateIpv4(byte[] raw) {
        if (raw == null || raw.length != 4) return false;
        int a = raw[0] & 0xFF;
        int b = raw[1] & 0xFF;
        return a == 10
            || (a == 172 && b >= 16 && b <= 31)
            || (a == 192 && b == 168);
    }

    private static int ipv4ToInt(byte[] raw) {
        return ((raw[0] & 0xFF) << 24)
            | ((raw[1] & 0xFF) << 16)
            | ((raw[2] & 0xFF) << 8)
            | (raw[3] & 0xFF);
    }

    private static String intToIpv4(int value) {
        return ((value >>> 24) & 0xFF) + "."
            + ((value >>> 16) & 0xFF) + "."
            + ((value >>> 8) & 0xFF) + "."
            + (value & 0xFF);
    }

    private static final HostnameVerifier INSECURE_HOSTNAME_VERIFIER = (hostname, session) -> true;
    private static volatile SSLSocketFactory insecureSocketFactory;

    private static SSLSocketFactory insecureSocketFactory() throws Exception {
        SSLSocketFactory current = insecureSocketFactory;
        if (current != null) return current;

        synchronized (ServerDiscoveryPlugin.class) {
            current = insecureSocketFactory;
            if (current != null) return current;

            TrustManager[] trustManagers = new TrustManager[] {
                new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustManagers, new SecureRandom());
            insecureSocketFactory = context.getSocketFactory();
            return insecureSocketFactory;
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
}
