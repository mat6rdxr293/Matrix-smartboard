package ru.matrixhost.smartboard;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

@CapacitorPlugin(name = "ServerSecurity")
public class ServerSecurityPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void probeServer(PluginCall call) {
        executor.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                String baseUrl = requireUrl(call);
                URL url = new URL(baseUrl + (baseUrl.endsWith("/") ? "api/status" : "/api/status"));
                if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IllegalArgumentException("TLS probe требует https://");

                TrustManager[] trustAll = new TrustManager[]{new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                }};
                SSLContext ssl = SSLContext.getInstance("TLS");
                ssl.init(null, trustAll, new SecureRandom());
                HostnameVerifier allowProbeHost = (hostname, session) -> true;

                connection = (HttpsURLConnection) url.openConnection();
                connection.setSSLSocketFactory(ssl.getSocketFactory());
                connection.setHostnameVerifier(allowProbeHost);
                connection.setConnectTimeout(3500);
                connection.setReadTimeout(3500);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("X-Matrix-Pairing-Probe", "1");

                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) throw new IllegalStateException("Сервер ответил кодом " + code);
                X509Certificate certificate = (X509Certificate) connection.getServerCertificates()[0];
                String pin = ServerTrustStore.publicKeyPin(certificate);

                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
                JSONObject status = new JSONObject(body.toString());
                if (!"matrix-smartboard".equals(status.optString("product"))) {
                    throw new IllegalStateException("Это не Matrix Smartboard server");
                }
                String advertisedPin = status.optString("publicKeyPin");
                if (!pin.equals(advertisedPin)) throw new IllegalStateException("TLS identity сервера не совпадает с API");
                String serverId = status.optString("serverId");
                boolean known = ServerTrustStore.isKnownServer(getContext(), serverId, pin);
                if (known) ServerTrustStore.bindKnownEndpoint(getContext(), serverId, baseUrl, pin);

                JSObject result = new JSObject();
                result.put("serverUrl", baseUrl);
                result.put("pin", pin);
                result.put("serverId", serverId);
                result.put("alreadyTrusted", known);
                result.put("status", status);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(clean(error));
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void trustServer(PluginCall call) {
        try {
            String baseUrl = requireUrl(call);
            String serverId = requireString(call, "serverId");
            String pin = requireString(call, "pin");
            ServerTrustStore.trust(getContext(), serverId, baseUrl, pin);
            call.resolve();
        } catch (Exception error) {
            call.reject(clean(error));
        }
    }

    @PluginMethod
    public void forgetServer(PluginCall call) {
        ServerTrustStore.forget(getContext(), call.getString("serverId", ""));
        call.resolve();
    }

    private static String requireUrl(PluginCall call) {
        String value = requireString(call, "serverUrl").replaceAll("/+$", "");
        if (!value.startsWith("https://")) throw new IllegalArgumentException("Ожидается https:// адрес сервера");
        return value;
    }

    private static String requireString(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException("Не заполнено поле: " + key);
        return value.trim();
    }

    private static String clean(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
