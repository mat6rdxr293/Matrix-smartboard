package ru.matrixhost.smartboard;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;

final class ServerTrustStore {
    private static final String PREFS = "matrix_server_trust";
    private static final String SERVER_PREFIX = "server.";
    private static final String ENDPOINT_PREFIX = "endpoint.";

    private ServerTrustStore() {}

    static String publicKeyPin(X509Certificate certificate) throws Exception {
        byte[] spki = certificate.getPublicKey().getEncoded();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(spki);
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return "sha256/" + hex;
    }

    static String endpointKey(String baseUrl) throws Exception {
        URI uri = URI.create(baseUrl);
        String host = uri.getHost();
        if (host == null || host.isBlank()) throw new IllegalArgumentException("Некорректный адрес сервера");
        int port = uri.getPort();
        if (port < 0) port = "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
        return host.toLowerCase() + ":" + port;
    }

    static String endpointKeyFromUrl(String rawUrl) throws Exception {
        return endpointKey(rawUrl);
    }

    static String getServerPin(Context context, String serverId) {
        if (serverId == null || serverId.isBlank()) return null;
        return prefs(context).getString(SERVER_PREFIX + serverId, null);
    }

    static String getEndpointPin(Context context, String endpoint) {
        return prefs(context).getString(ENDPOINT_PREFIX + endpoint, null);
    }

    static boolean isKnownServer(Context context, String serverId, String pin) {
        String stored = getServerPin(context, serverId);
        return stored != null && stored.equals(pin);
    }

    static void trust(Context context, String serverId, String baseUrl, String pin) throws Exception {
        if (serverId == null || serverId.isBlank() || pin == null || !pin.startsWith("sha256/")) {
            throw new IllegalArgumentException("Некорректная идентичность сервера");
        }
        String endpoint = endpointKey(baseUrl);
        prefs(context).edit()
            .putString(SERVER_PREFIX + serverId, pin)
            .putString(ENDPOINT_PREFIX + endpoint, pin)
            .apply();
    }

    static void bindKnownEndpoint(Context context, String serverId, String baseUrl, String pin) throws Exception {
        if (!isKnownServer(context, serverId, pin)) return;
        prefs(context).edit().putString(ENDPOINT_PREFIX + endpointKey(baseUrl), pin).apply();
    }

    static void forget(Context context, String serverId) {
        if (serverId == null || serverId.isBlank()) return;
        SharedPreferences preferences = prefs(context);
        String pin = preferences.getString(SERVER_PREFIX + serverId, null);
        SharedPreferences.Editor editor = preferences.edit().remove(SERVER_PREFIX + serverId);
        if (pin != null) {
            for (String key : preferences.getAll().keySet()) {
                if (key.startsWith(ENDPOINT_PREFIX) && pin.equals(preferences.getString(key, null))) editor.remove(key);
            }
        }
        editor.apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
