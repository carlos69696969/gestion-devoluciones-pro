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
        StringBuilder command = new StringBuilder();
        command.append("SIZE 100 mm,60 mm\r\n");
        command.append("GAP 2 mm,0 mm\r\n");
        command.append("DIRECTION 1\r\n");
        command.append("REFERENCE 0,0\r\n");
        command.append("SPEED 4\r\n");
        command.append("DENSITY 10\r\n");
        command.append("CLS\r\n");
        command.append("BOX 16,16,784,464,3\r\n");
        command.append("TEXT 36,36,\"0\",0,2,2,\"CARIANA\"\r\n");
        command.append("TEXT 36,104,\"0\",0,2,2,\"ORDEN #").append(tsplText(orderNumber)).append("\"\r\n");
        command.append("CIRCLE 682,112,46,4\r\n");
        command.append("TEXT 666,96,\"0\",0,2,2,\"").append(tsplText(routeNumber)).append("\"\r\n");
        command.append("TEXT 36,180,\"0\",0,1,2,\"CLIENTE\"\r\n");
        command.append("TEXT 36,216,\"0\",0,2,2,\"").append(tsplText(customerName)).append("\"\r\n");
        command.append("TEXT 36,292,\"0\",0,1,2,\"DIRECCION\"\r\n");
        int y = 326;
        for (String line : wrapForTspl(address, 33, 3)) {
            command.append("TEXT 36,").append(y).append(",\"0\",0,1,2,\"").append(tsplText(line)).append("\"\r\n");
            y += 36;
        }
        command.append("PRINT 1,1\r\n");
        return command.toString().getBytes(StandardCharsets.ISO_8859_1);
    }

    private String normalizeLabelText(String value, String fallback) {
        String text = String.valueOf(value == null ? "" : value).trim();
        return TextUtils.isEmpty(text) ? fallback : text;
    }

    private String tsplText(String value) {
        return String.valueOf(value == null ? "" : value)
            .replace("\\", "/")
            .replace("\"", "'")
            .replace("\r", " ")
            .replace("\n", " ")
            .trim();
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
