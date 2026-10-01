package ru.matrixhost.smartboard;

import android.content.Context;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

public final class PinnedBridgeWebViewClient extends BridgeWebViewClient {
    private final Context context;

    public PinnedBridgeWebViewClient(Bridge bridge, Context context) {
        super(bridge);
        this.context = context.getApplicationContext();
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        try {
            Bundle state = SslCertificate.saveState(error.getCertificate());
            byte[] encoded = state == null ? null : state.getByteArray("x509-certificate");
            if (encoded == null) {
                handler.cancel();
                return;
            }
            X509Certificate certificate = (X509Certificate) CertificateFactory
                .getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(encoded));
            String pin = ServerTrustStore.publicKeyPin(certificate);
            String endpoint = ServerTrustStore.endpointKeyFromUrl(error.getUrl());
            String expected = ServerTrustStore.getEndpointPin(context, endpoint);
            if (expected != null && expected.equals(pin)) {
                handler.proceed();
                return;
            }
        } catch (Exception ignored) {
        }
        handler.cancel();
    }
}
