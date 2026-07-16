package com.cariana.portalpreparador;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.text.TextUtils;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Set;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String SHOP_DOMAIN = "qc1u2w-ft.myshopify.com";
    private static final String PORTAL_HOST = "gestion-devoluciones-pro.onrender.com";
    private static final String BASE_URL = "https://" + PORTAL_HOST + "/preparador?shop=" + SHOP_DOMAIN;
    private static final String LABEL_PRINTER_MAC = "10:23:81:BE:81:FC";
    private WebView webView;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(246, 246, 247));
        webView.setWebViewClient(new PortalWebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.addJavascriptInterface(new PortalBridge(), "Android");

        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(webView);
        webView.loadUrl(portalUrl());
    }

    private class PortalWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl().toString());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(url);
        }
    }

    private boolean handleUrl(String url) {
        if (url == null || url.trim().isEmpty()) return false;
        String normalizedUrl = url.trim();

        if (normalizedUrl.startsWith("http://") || normalizedUrl.startsWith("https://")) {
            Uri uri = Uri.parse(normalizedUrl);
            if (PORTAL_HOST.equalsIgnoreCase(uri.getHost())) {
                return false;
            }
            openExternalIntent(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        }

        if (normalizedUrl.startsWith("tel:")) {
            openExternalIntent(new Intent(Intent.ACTION_DIAL, Uri.parse(normalizedUrl)));
            return true;
        }

        if (normalizedUrl.startsWith("intent:")) {
            openIntentUrl(normalizedUrl);
            return true;
        }

        openExternalIntent(new Intent(Intent.ACTION_VIEW, Uri.parse(normalizedUrl)));
        return true;
    }

    private void openIntentUrl(String url) {
        try {
            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            openExternalIntent(intent);
        } catch (Exception error) {
            openExternalIntent(new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/maps")));
        }
    }

    private void openExternalIntent(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            // If the target app is not installed, keep the portal open instead of showing a WebView error.
        }
    }

    private String portalUrl() {
        return BASE_URL + "&sesion=" + getInstallSessionId();
    }

    private String getInstallSessionId() {
        SharedPreferences preferences = getSharedPreferences("portal", MODE_PRIVATE);
        String sessionId = preferences.getString("install_session_id", "");
        if (sessionId == null || sessionId.trim().isEmpty()) {
            sessionId = java.util.UUID.randomUUID().toString();
            preferences.edit().putString("install_session_id", sessionId).apply();
        }
        return sessionId;
    }

    private class PortalBridge {
        @JavascriptInterface
        public void printPrepLabel(String orderNumber, String routeNumber, String customerName, String address) {
            final String cleanOrderNumber = normalizeLabelText(orderNumber, "SIN ORDEN");
            final String cleanRouteNumber = normalizeLabelText(routeNumber, "-");
            final String cleanCustomerName = normalizeLabelText(customerName, "Cliente");
            final String cleanAddress = normalizeLabelText(address, "");

            new Thread(new Runnable() {
                @Override
                public void run() {
                    BluetoothSocket socket = null;
                    try {
                        if (!hasBluetoothConnectPermission()) {
                            requestBluetoothConnectPermission();
                            showToast("Permite Bluetooth y vuelve a presionar Listo.");
                            return;
                        }

                        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                        if (adapter == null) {
                            showToast("Este celular no tiene Bluetooth disponible.");
                            return;
                        }
                        if (!adapter.isEnabled()) {
                            showToast("Activa Bluetooth para imprimir la etiqueta.");
                            return;
                        }

                        BluetoothDevice printer = findBondedLabelPrinter(adapter);
                        if (printer == null) {
                            showToast("Empareja la impresora Hstem 420B BL por Bluetooth.");
                            return;
                        }

                        socket = connectToPrinter(printer);
                        OutputStream outputStream = socket.getOutputStream();
                        outputStream.write(buildPrepLabelTspl(cleanOrderNumber, cleanRouteNumber, cleanCustomerName, cleanAddress));
                        outputStream.flush();
                        showToast("Etiqueta enviada a la impresora.");
                    } catch (SecurityException error) {
                        requestBluetoothConnectPermission();
                        showToast("Permite Bluetooth para imprimir.");
                    } catch (Exception error) {
                        showToast("No se pudo conectar con 4B-2054L. Apaga y prende la impresora e intenta de nuevo.");
                    } finally {
                        if (socket != null) {
                            try {
                                socket.close();
                            } catch (IOException ignored) {}
                        }
                    }
                }
            }).start();
        }
    }

    private BluetoothSocket connectToPrinter(BluetoothDevice printer) throws Exception {
        BluetoothSocket socket = null;
        Exception lastError = null;

        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter != null && adapter.isDiscovering()) {
                adapter.cancelDiscovery();
            }
        } catch (SecurityException ignored) {}

        try {
            socket = printer.createRfcommSocketToServiceRecord(
                UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
            );
            socket.connect();
            return socket;
        } catch (Exception error) {
            lastError = error;
            closeSocket(socket);
        }

        try {
            socket = printer.createInsecureRfcommSocketToServiceRecord(
                UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
            );
            socket.connect();
            return socket;
        } catch (Exception error) {
            lastError = error;
            closeSocket(socket);
        }

        try {
            socket = (BluetoothSocket) printer.getClass()
                .getMethod("createRfcommSocket", int.class)
                .invoke(printer, 1);
            socket.connect();
            return socket;
        } catch (Exception error) {
            lastError = error;
            closeSocket(socket);
        }

        throw lastError == null ? new IOException("Bluetooth printer connection failed") : lastError;
    }

    private void closeSocket(BluetoothSocket socket) {
        if (socket == null) {
            return;
        }
        try {
            socket.close();
        } catch (IOException ignored) {}
    }

    private boolean hasBluetoothConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestBluetoothConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                requestPermissions(new String[] { Manifest.permission.BLUETOOTH_CONNECT }, 420);
            }
        });
    }

    private BluetoothDevice findBondedLabelPrinter(BluetoothAdapter adapter) {
        Set<BluetoothDevice> bondedDevices = adapter.getBondedDevices();
        if (bondedDevices == null || bondedDevices.isEmpty()) {
            return null;
        }
        BluetoothDevice fallback = null;
        for (BluetoothDevice device : bondedDevices) {
            if (device == null) continue;
            String name = "";
            String address = "";
            try {
                name = String.valueOf(device.getName()).toLowerCase();
                address = String.valueOf(device.getAddress()).toUpperCase();
            } catch (SecurityException ignored) {}
            if (LABEL_PRINTER_MAC.equals(address)) {
                return device;
            }
            if (
                name.contains("soundcore") ||
                name.contains("headphone") ||
                name.contains("earbud") ||
                name.contains("audio") ||
                name.contains("tv")
            ) {
                continue;
            }
            if (
                name.contains("hstem") ||
                name.contains("4b") ||
                name.contains("2054") ||
                name.contains("420") ||
                name.contains("xp") ||
                name.contains("xprinter") ||
                name.contains("printer") ||
                name.contains("label") ||
                name.contains("pos")
            ) {
                return device;
            }
            if (fallback == null) fallback = device;
        }
        return fallback;
    }

    private byte[] buildPrepLabelTspl(String orderNumber, String routeNumber, String customerName, String address) {
        String cleanOrderNumber = tsplText(orderNumber).replaceAll("[^0-9A-Za-z-]", "");
        String displayOrderNumber = cleanOrderNumber.length() > 0 ? cleanOrderNumber : tsplText(orderNumber);
        String displayRouteNumber = truncateForLabel(tsplText(routeNumber), 3);
        String displayCustomerName = truncateForLabel(tsplText(customerName).toUpperCase(), 20);
        StringBuilder command = new StringBuilder();
        command.append("SIZE 100 mm,100 mm\r\n");
        command.append("GAP 2 mm,0 mm\r\n");
        command.append("DIRECTION 1\r\n");
        command.append("REFERENCE 0,0\r\n");
        command.append("SPEED 4\r\n");
        command.append("DENSITY 10\r\n");
        command.append("CLS\r\n");
        command.append("BOX 16,16,784,784,4\r\n");
        command.append("TEXT 302,44,\"4\",0,2,2,\"CARIANA\"\r\n");
        command.append("TEXT 286,108,\"2\",0,1,1,\"GRACIAS POR ELEGIRNOS\"\r\n");
        command.append("BAR 166,126,94,3\r\n");
        command.append("BAR 540,126,94,3\r\n");
        command.append("CIRCLE 116,258,92,8\r\n");
        command.append("TEXT 90,220,\"5\",0,2,2,\"").append(displayRouteNumber).append("\"\r\n");
        command.append("BAR 232,168,3,160\r\n");
        command.append("TEXT 398,174,\"3\",0,2,2,\"PEDIDO\"\r\n");
        command.append("TEXT 286,220,\"5\",0,2,2,\"#").append(displayOrderNumber).append("\"\r\n");
        command.append("BAR 48,350,704,2\r\n");
        command.append("TEXT 70,380,\"3\",0,1,2,\"CLIENTE\"\r\n");
        command.append("TEXT 164,372,\"4\",0,2,2,\"").append(displayCustomerName).append("\"\r\n");
        command.append("TEXT 164,428,\"2\",0,1,1,\"GRACIAS POR TU COMPRA\"\r\n");
        command.append("BAR 48,468,704,2\r\n");
        command.append("TEXT 70,504,\"3\",0,1,2,\"DOMICILIO:\"\r\n");
        int y = 538;
        for (String line : wrapForTspl(address, 35, 3)) {
            command.append("TEXT 70,").append(y).append(",\"3\",0,1,1,\"").append(tsplText(line).toUpperCase()).append("\"\r\n");
            y += 30;
        }
        command.append("BAR 48,630,704,2\r\n");
        command.append("BARCODE 70,660,\"128\",86,1,0,2,4,\"").append(displayOrderNumber).append("\"\r\n");
        command.append("QRCODE 632,650,L,5,A,0,\"").append(displayOrderNumber).append("\"\r\n");
        command.append("PRINT 1,1\r\n");
        return command.toString().getBytes(StandardCharsets.ISO_8859_1);
    }

    private String normalizeLabelText(String value, String fallback) {
        String text = String.valueOf(value == null ? "" : value).trim();
        return TextUtils.isEmpty(text) ? fallback : text;
    }

    private String tsplText(String value) {
        String normalized = Normalizer.normalize(String.valueOf(value == null ? "" : value), Normalizer.Form.NFD)
            .replaceAll("\\p{InCombiningDiacriticalMarks}+", "");
        return normalized
            .replace("\\", "/")
            .replace("\"", "'")
            .replace("\r", " ")
            .replace("\n", " ")
            .trim();
    }

    private String truncateForLabel(String value, int maxChars) {
        String text = normalizeLabelText(value, "-").replaceAll("\\s+", " ");
        if (text.length() <= maxChars) {
            return text;
        }
        return text.substring(0, Math.max(0, maxChars)).trim();
    }

    private String[] wrapForTspl(String value, int maxChars, int maxLines) {
        String text = normalizeLabelText(value, "-").replaceAll("\\s+", " ");
        String[] words = text.split(" ");
        String[] lines = new String[maxLines];
        int lineIndex = 0;
        StringBuilder current = new StringBuilder();
        for (String word : words) {
            if (lineIndex >= maxLines) break;
            String next = current.length() == 0 ? word : current + " " + word;
            if (next.length() > maxChars && current.length() > 0) {
                lines[lineIndex] = current.toString();
                lineIndex += 1;
                current = new StringBuilder(word);
            } else {
                current = new StringBuilder(next);
            }
        }
        if (lineIndex < maxLines && current.length() > 0) {
            lines[lineIndex] = current.toString();
        }
        for (int i = 0; i < maxLines; i++) {
            if (lines[i] == null) lines[i] = "";
        }
        return lines;
    }

    private void showToast(final String message) {
        Handler handler = new Handler(getMainLooper());
        handler.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
