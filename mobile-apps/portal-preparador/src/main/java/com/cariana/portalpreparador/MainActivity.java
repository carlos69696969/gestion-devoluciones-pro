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
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
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
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;

public class MainActivity extends Activity {
    private static final String SHOP_DOMAIN = "qc1u2w-ft.myshopify.com";
    private static final String PORTAL_HOST = "gestion-devoluciones-pro.onrender.com";
    private static final String BASE_URL = "https://" + PORTAL_HOST + "/preparador?shop=" + SHOP_DOMAIN;
    private static final String LABEL_PRINTER_MAC = "10:23:81:BE:81:FC";
    private static final int LABEL_DOTS = 816;
    private static final int SAFE_MIN = 24;
    private static final int SAFE_MAX = 792;
    private final Object printerSocketLock = new Object();
    private BluetoothSocket cachedPrinterSocket;
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
        requestBluetoothPermissionOnLaunch();
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

                        BluetoothSocket socket = getPrinterSocket(printer);
                        OutputStream outputStream = socket.getOutputStream();
                        outputStream.write(buildPrepLabelTspl(cleanOrderNumber, cleanRouteNumber, cleanCustomerName, cleanAddress));
                        outputStream.flush();
                        showToast("Etiqueta enviada a la impresora.");
                    } catch (SecurityException error) {
                        requestBluetoothConnectPermission();
                        showToast("Permite Bluetooth para imprimir.");
                    } catch (Exception error) {
                        closeCachedPrinterSocket();
                        showToast("No se pudo conectar con 4B-2054L. Apaga y prende la impresora e intenta de nuevo.");
                    }
                }
            }).start();
        }
    }

    private BluetoothSocket getPrinterSocket(BluetoothDevice printer) throws Exception {
        synchronized (printerSocketLock) {
            if (cachedPrinterSocket != null && cachedPrinterSocket.isConnected()) {
                return cachedPrinterSocket;
            }
            closeCachedPrinterSocketLocked();
            cachedPrinterSocket = connectToPrinter(printer);
            return cachedPrinterSocket;
        }
    }

    private void warmUpPrinterConnection() {
        if (!hasBluetoothConnectPermission()) {
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                    if (adapter == null || !adapter.isEnabled()) {
                        return;
                    }
                    BluetoothDevice printer = findBondedLabelPrinter(adapter);
                    if (printer == null) {
                        return;
                    }
                    getPrinterSocket(printer);
                } catch (Exception ignored) {}
            }
        }).start();
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

    private void closeCachedPrinterSocket() {
        synchronized (printerSocketLock) {
            closeCachedPrinterSocketLocked();
        }
    }

    private void closeCachedPrinterSocketLocked() {
        if (cachedPrinterSocket == null) {
            return;
        }
        closeSocket(cachedPrinterSocket);
        cachedPrinterSocket = null;
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

    private void requestBluetoothPermissionOnLaunch() {
        if (hasBluetoothConnectPermission()) {
            warmUpPrinterConnection();
            return;
        }
        requestBluetoothConnectPermission();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 420 && hasBluetoothConnectPermission()) {
            warmUpPrinterConnection();
        }
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
        Bitmap labelBitmap = renderPrepLabelBitmap(
            displayOrderNumber,
            displayRouteNumber,
            tsplText(customerName).toUpperCase(),
            tsplText(address).toUpperCase()
        );
        saveLabelPreview(labelBitmap, displayOrderNumber);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        appendCommand(output,
            "SIZE 102 mm,102 mm\r\n" +
            "GAP 2 mm,0 mm\r\n" +
            "DIRECTION 1\r\n" +
            "REFERENCE 0,0\r\n" +
            "OFFSET 0 mm\r\n" +
            "SPEED 4\r\n" +
            "DENSITY 10\r\n" +
            "CLS\r\n" +
            "BITMAP 0,0,102,816,0,"
        );
        try {
            output.write(bitmapToTsplBytes(labelBitmap, 175));
        } catch (IOException ignored) {}
        appendCommand(output, "\r\nPRINT 1,1\r\n");
        return output.toByteArray();
    }

    private void appendCommand(ByteArrayOutputStream output, String command) {
        try {
            output.write(command.getBytes(StandardCharsets.ISO_8859_1));
        } catch (IOException ignored) {}
    }

    private Bitmap renderPrepLabelBitmap(String orderNumber, String routeNumber, String customerName, String address) {
        Bitmap bitmap = Bitmap.createBitmap(LABEL_DOTS, LABEL_DOTS, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(4);
        canvas.drawRoundRect(new RectF(SAFE_MIN, SAFE_MIN, SAFE_MAX, SAFE_MAX), 28, 28, paint);

        drawLogo(canvas, 328, 24, 160, 92);
        drawCenteredText(canvas, "CARIANA", 408, 162, 62, true);
        drawCenteredText(canvas, "GRACIAS POR ELEGIRNOS", 408, 200, 25, false);
        drawLine(canvas, 162, 196, 260, 196, 3);
        drawLine(canvas, 556, 196, 654, 196, 3);

        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(124, 304, 76, paint);
        drawCenteredText(canvas, routeNumber, 124, 334, routeTextSize(routeNumber), true, Color.WHITE);
        drawLine(canvas, 232, 228, 232, 373, 3);

        drawCenteredText(canvas, "PEDIDO", 512, 262, 32, true);
        drawCenteredText(canvas, "#" + orderNumber, 512, 350, orderTextSize(orderNumber), true);
        drawLine(canvas, 54, 402, 762, 402, 2);

        drawPersonIcon(canvas, 68, 428);
        Paint customerMeasurePaint = textPaint(23, true);
        List<String> customerLines = wrapTextByWidth(customerName, 620, 2, customerMeasurePaint);
        int customerY = customerLines.size() > 1 ? 438 : 452;
        Paint customerPaint = textPaint(customerLines.size() > 1 ? 21 : customerTextSize(customerName), true);
        for (String line : customerLines) {
            drawText(canvas, line, 128, customerY, customerPaint);
            customerY += 30;
        }
        drawCenteredText(canvas, "GRACIAS POR TU COMPRA", 408, 502, 23, false);
        drawLine(canvas, 54, 528, 762, 528, 2);

        drawLocationIcon(canvas, 66, 556);
        drawText(canvas, "DOMICILIO:", 128, 577, textPaint(30, true));
        List<String> addressLines = wrapTextByWidth(address, 620, 3, textPaint(27, true));
        int[] addressY = {610, 644, 678};
        Paint addressPaint = textPaint(addressTextSize(addressLines), true);
        for (int i = 0; i < addressLines.size() && i < 3; i++) {
            drawText(canvas, addressLines.get(i), 128, addressY[i], addressPaint);
        }
        drawLine(canvas, 54, 688, 762, 688, 2);

        drawMatrix(canvas, createBarcodeMatrix(orderNumber, 510, 70), 62, 712, 510, 70);
        drawMatrix(canvas, createQrMatrix("PEDIDO:" + orderNumber, 88, 88), 646, 704, 88, 88);
        return thresholdBitmap(bitmap, 178);
    }

    private Paint textPaint(float size, boolean bold) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.FILL);
        paint.setTypeface(Typeface.create(Typeface.SANS_SERIF, bold ? Typeface.BOLD : Typeface.NORMAL));
        paint.setTextSize(size);
        return paint;
    }

    private void drawText(Canvas canvas, String text, float x, float baseline, Paint paint) {
        canvas.drawText(String.valueOf(text == null ? "" : text), x, baseline, paint);
    }

    private void drawCenteredText(Canvas canvas, String text, float centerX, float baseline, float size, boolean bold) {
        drawCenteredText(canvas, text, centerX, baseline, size, bold, Color.BLACK);
    }

    private void drawCenteredText(Canvas canvas, String text, float centerX, float baseline, float size, boolean bold, int color) {
        Paint paint = textPaint(size, bold);
        paint.setColor(color);
        String value = String.valueOf(text == null ? "" : text);
        canvas.drawText(value, centerX - (paint.measureText(value) / 2f), baseline, paint);
    }

    private void drawLine(Canvas canvas, float startX, float startY, float stopX, float stopY, float width) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setStrokeWidth(width);
        paint.setStyle(Paint.Style.STROKE);
        canvas.drawLine(startX, startY, stopX, stopY, paint);
    }

    private void drawLogo(Canvas canvas, int x, int y, int width, int height) {
        Bitmap logo = BitmapFactory.decodeResource(getResources(), getResources().getIdentifier("cariana_hummingbird", "drawable", getPackageName()));
        if (logo == null) return;
        Paint white = new Paint();
        white.setColor(Color.WHITE);
        white.setStyle(Paint.Style.FILL);
        canvas.drawRect(x, y, x + width, y + height, white);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        Rect src = new Rect(0, 0, logo.getWidth(), logo.getHeight());
        RectF dst = fitCenter(src.width(), src.height(), x, y, width, height);
        canvas.drawBitmap(logo, src, dst, paint);
    }

    private RectF fitCenter(int sourceWidth, int sourceHeight, int x, int y, int width, int height) {
        float scale = Math.min(width / (float) sourceWidth, height / (float) sourceHeight);
        float drawWidth = sourceWidth * scale;
        float drawHeight = sourceHeight * scale;
        float left = x + ((width - drawWidth) / 2f);
        float top = y + ((height - drawHeight) / 2f);
        return new RectF(left, top, left + drawWidth, top + drawHeight);
    }

    private void drawPersonIcon(Canvas canvas, int x, int y) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(x + 24, y + 14, 14, paint);
        canvas.drawRoundRect(new RectF(x + 3, y + 34, x + 45, y + 68), 8, 8, paint);
    }

    private void drawLocationIcon(Canvas canvas, int x, int y) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.FILL);
        android.graphics.Path path = new android.graphics.Path();
        path.moveTo(x + 26, y + 70);
        path.cubicTo(x - 8, y + 26, x + 2, y, x + 26, y);
        path.cubicTo(x + 52, y, x + 62, y + 26, x + 26, y + 70);
        canvas.drawPath(path, paint);
        paint.setColor(Color.WHITE);
        canvas.drawCircle(x + 26, y + 24, 11, paint);
    }

    private List<String> wrapTextByWidth(String text, float maxWidth, int maxLines, Paint paint) {
        String normalized = normalizeLabelText(text, "-").replaceAll("\\s+", " ").trim();
        String[] words = normalized.split(" ");
        List<String> lines = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (String word : words) {
            String candidate = current.length() == 0 ? word : current + " " + word;
            if (paint.measureText(candidate) <= maxWidth || current.length() == 0) {
                current = new StringBuilder(candidate);
                continue;
            }
            lines.add(current.toString());
            current = new StringBuilder(word);
            if (lines.size() >= maxLines - 1) break;
        }
        if (current.length() > 0 && lines.size() < maxLines) {
            String remaining = current.toString();
            while (paint.measureText(remaining) > maxWidth && remaining.length() > 1) {
                remaining = remaining.substring(0, remaining.length() - 1).trim();
            }
            lines.add(remaining);
        }
        if (lines.isEmpty()) lines.add("-");
        return lines;
    }

    private int customerTextSize(String customerName) {
        int length = String.valueOf(customerName == null ? "" : customerName).length();
        if (length > 34) return 20;
        if (length > 28) return 21;
        return 23;
    }

    private int addressTextSize(List<String> lines) {
        for (String line : lines) {
            if (line.length() > 34) return 23;
            if (line.length() > 28) return 25;
        }
        return 27;
    }

    private int routeTextSize(String routeNumber) {
        int length = String.valueOf(routeNumber == null ? "" : routeNumber).length();
        if (length <= 1) return 92;
        if (length == 2) return 70;
        return 56;
    }

    private int orderTextSize(String orderNumber) {
        int length = String.valueOf(orderNumber == null ? "" : orderNumber).length();
        if (length > 5) return 70;
        return 84;
    }

    private BitMatrix createBarcodeMatrix(String value, int width, int height) {
        try {
            return new MultiFormatWriter().encode(value, BarcodeFormat.CODE_128, width, height);
        } catch (Exception error) {
            return null;
        }
    }

    private BitMatrix createQrMatrix(String value, int width, int height) {
        try {
            java.util.Map<EncodeHintType, Object> hints = new java.util.EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 0);
            return new MultiFormatWriter().encode(value, BarcodeFormat.QR_CODE, width, height, hints);
        } catch (Exception error) {
            return null;
        }
    }

    private void drawMatrix(Canvas canvas, BitMatrix matrix, int x, int y, int width, int height) {
        if (matrix == null) return;
        Paint paint = new Paint();
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.FILL);
        float cellWidth = width / (float) matrix.getWidth();
        float cellHeight = height / (float) matrix.getHeight();
        for (int matrixY = 0; matrixY < matrix.getHeight(); matrixY++) {
            for (int matrixX = 0; matrixX < matrix.getWidth(); matrixX++) {
                if (!matrix.get(matrixX, matrixY)) continue;
                canvas.drawRect(
                    x + matrixX * cellWidth,
                    y + matrixY * cellHeight,
                    x + (matrixX + 1) * cellWidth,
                    y + (matrixY + 1) * cellHeight,
                    paint
                );
            }
        }
    }

    private Bitmap thresholdBitmap(Bitmap source, int threshold) {
        Bitmap target = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.ARGB_8888);
        for (int y = 0; y < source.getHeight(); y++) {
            for (int x = 0; x < source.getWidth(); x++) {
                int color = source.getPixel(x, y);
                int alpha = Color.alpha(color);
                int red = Color.red(color);
                int green = Color.green(color);
                int blue = Color.blue(color);
                int luminance = (int) ((0.299f * red) + (0.587f * green) + (0.114f * blue));
                target.setPixel(x, y, alpha > 0 && luminance < threshold ? Color.BLACK : Color.WHITE);
            }
        }
        return target;
    }

    private byte[] bitmapToTsplBytes(Bitmap bitmap, int threshold) {
        int widthBytes = bitmap.getWidth() / 8;
        byte[] bytes = new byte[widthBytes * bitmap.getHeight()];
        java.util.Arrays.fill(bytes, (byte) 0xFF);
        for (int y = 0; y < bitmap.getHeight(); y++) {
            for (int byteX = 0; byteX < widthBytes; byteX++) {
                for (int bit = 0; bit < 8; bit++) {
                    int pixelX = byteX * 8 + bit;
                    int color = bitmap.getPixel(pixelX, y);
                    int alpha = Color.alpha(color);
                    int luminance = (int) ((0.299f * Color.red(color)) + (0.587f * Color.green(color)) + (0.114f * Color.blue(color)));
                    if (alpha > 0 && luminance < threshold) {
                        int byteIndex = y * widthBytes + byteX;
                        int bitMask = 0x80 >> bit;
                        bytes[byteIndex] = (byte) (bytes[byteIndex] & ~bitMask);
                    }
                }
            }
        }
        return bytes;
    }

    private void saveLabelPreview(Bitmap bitmap, String orderNumber) {
        try {
            File directory = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if (directory == null) return;
            if (!directory.exists()) directory.mkdirs();
            File file = new File(directory, "cariana-etiqueta-" + tsplText(orderNumber).replaceAll("[^0-9A-Za-z-]", "") + ".png");
            FileOutputStream stream = new FileOutputStream(file);
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            stream.flush();
            stream.close();
        } catch (Exception ignored) {}
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

    @Override
    protected void onDestroy() {
        closeCachedPrinterSocket();
        super.onDestroy();
    }
}
