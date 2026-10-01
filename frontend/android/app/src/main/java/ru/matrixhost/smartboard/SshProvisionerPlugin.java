package ru.matrixhost.smartboard;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "SshProvisioner")
public class SshProvisionerPlugin extends Plugin {
    private static final String INSTALLER_URL = "https://raw.githubusercontent.com/mat6rdxr293/Matrix-smartboard/main/deploy/install-server.sh";
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void inspectHost(PluginCall call) {
        executor.execute(() -> {
            Session session = null;
            try {
                ConnectionOptions options = readConnection(call);
                session = connect(options);
                JSObject result = new JSObject();
                result.put("fingerprint", fingerprint(session.getHostKey()));
                call.resolve(result);
            } catch (Exception error) {
                call.reject(cleanMessage(error));
            } finally {
                if (session != null) session.disconnect();
            }
        });
    }

    @PluginMethod
    public void provisionServer(PluginCall call) {
        executor.execute(() -> {
            Session session = null;
            ChannelExec channel = null;
            try {
                ConnectionOptions options = readConnection(call);
                String expectedFingerprint = requireString(call, "expectedFingerprint");
                int backendPort = readPort(call, "backendPort", 8443);
                boolean installLocalAi = Boolean.TRUE.equals(call.getBoolean("installLocalAi", true));
                String sudoPassword = call.getString("sudoPassword", options.password);

                session = connect(options);
                String actualFingerprint = fingerprint(session.getHostKey());
                if (!actualFingerprint.equals(expectedFingerprint)) {
                    throw new IllegalStateException("SSH fingerprint изменился. Установка остановлена.");
                }

                String serverUrl = buildServerUrl(options.host, backendPort);
                String body = "set -e; "
                    + "export MATRIX_PORT=" + shellQuote(Integer.toString(backendPort)) + "; "
                    + "export MATRIX_PUBLIC_BASE_URL=" + shellQuote(serverUrl) + "; "
                    + "export MATRIX_INSTALL_OLLAMA=" + shellQuote(installLocalAi ? "1" : "0") + "; "
                    + "tmp=/tmp/matrix-smartboard-install.sh; "
                    + "if command -v curl >/dev/null 2>&1; then curl -fsSL " + shellQuote(INSTALLER_URL) + " -o \"$tmp\"; "
                    + "elif command -v wget >/dev/null 2>&1; then wget -qO \"$tmp\" " + shellQuote(INSTALLER_URL) + "; "
                    + "else apt-get update -y && apt-get install -y curl && curl -fsSL " + shellQuote(INSTALLER_URL) + " -o \"$tmp\"; fi; "
                    + "chmod 700 \"$tmp\"; bash \"$tmp\"; rc=$?; rm -f \"$tmp\"; exit $rc";

                String command = "root".equals(options.username)
                    ? "sh -c " + shellQuote(body)
                    : "sudo -S -p '' sh -c " + shellQuote(body);

                channel = (ChannelExec) session.openChannel("exec");
                channel.setCommand(command + " 2>&1");
                channel.setPty(false);
                BufferedReader reader = new BufferedReader(new InputStreamReader(channel.getInputStream(), StandardCharsets.UTF_8));
                OutputStream stdin = channel.getOutputStream();
                channel.connect(15_000);

                if (!"root".equals(options.username)) {
                    stdin.write(((sudoPassword == null ? "" : sudoPassword) + "\n").getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                }

                while (true) {
                    while (reader.ready()) {
                        String line = reader.readLine();
                        if (line == null) break;
                        emitProgress(line);
                    }
                    if (channel.isClosed()) break;
                    Thread.sleep(120);
                }
                while (reader.ready()) {
                    String line = reader.readLine();
                    if (line == null) break;
                    emitProgress(line);
                }

                int exitCode = channel.getExitStatus();
                if (exitCode != 0) {
                    throw new IllegalStateException("Установка завершилась с кодом " + exitCode);
                }

                JSObject result = new JSObject();
                result.put("serverUrl", serverUrl);
                result.put("exitCode", exitCode);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(cleanMessage(error));
            } finally {
                if (channel != null) channel.disconnect();
                if (session != null) session.disconnect();
            }
        });
    }

    private void emitProgress(String line) {
        JSObject event = new JSObject();
        event.put("line", line.length() > 2000 ? line.substring(0, 2000) : line);
        notifyListeners("provisionProgress", event);
    }

    private Session connect(ConnectionOptions options) throws Exception {
        JSch jsch = new JSch();
        Session session = jsch.getSession(options.username, options.host, options.port);
        session.setPassword(options.password);
        session.setConfig("StrictHostKeyChecking", "no");
        session.setConfig("PreferredAuthentications", "password,keyboard-interactive");
        session.setServerAliveInterval(10_000);
        session.connect(12_000);
        return session;
    }

    private ConnectionOptions readConnection(PluginCall call) {
        String host = requireString(call, "host");
        String username = requireString(call, "username");
        String password = requireString(call, "password");
        int port = readPort(call, "port", 22);
        if (!host.matches("^[A-Za-z0-9._:-]+$")) throw new IllegalArgumentException("Некорректный адрес SSH-сервера");
        if (!username.matches("^[A-Za-z0-9._-]+$")) throw new IllegalArgumentException("Некорректное имя пользователя");
        return new ConnectionOptions(host, port, username, password);
    }

    private static String requireString(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException("Не заполнено поле: " + key);
        return value.trim();
    }

    private static int readPort(PluginCall call, String key, int fallback) {
        Integer value = call.getInt(key, fallback);
        int port = value == null ? fallback : value;
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Некорректный порт");
        return port;
    }

    private static String fingerprint(HostKey hostKey) throws Exception {
        byte[] keyBytes = Base64.decode(hostKey.getKey(), Base64.DEFAULT);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyBytes);
        return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String buildServerUrl(String host, int port) {
        String value = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        return "https://" + value + ":" + port;
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static String cleanMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        if (message.contains("Auth fail")) return "SSH: неверный пользователь или пароль";
        if (message.contains("timeout") || message.contains("timed out")) return "SSH: сервер не отвечает";
        return message;
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private static final class ConnectionOptions {
        final String host;
        final int port;
        final String username;
        final String password;

        ConnectionOptions(String host, int port, String username, String password) {
            this.host = host;
            this.port = port;
            this.username = username;
            this.password = password;
        }
    }
}
