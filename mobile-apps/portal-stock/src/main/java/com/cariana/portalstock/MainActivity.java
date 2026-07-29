package com.cariana.portalstock;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
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
import android.os.Handler;
import android.provider.MediaStore;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final String SHOP_DOMAIN = "qc1u2w-ft.myshopify.com";
    private static final String PORTAL_HOST = "gestion-devoluciones-pro.onrender.com";
    private static final String BASE_URL = "https://" + PORTAL_HOST + "/stock?shop=" + SHOP_DOMAIN;
    private static final String LABEL_PRINTER_MAC = "10:23:81:BE:81:FC";
    private static final int FILE_CHOOSER_REQUEST = 9421;
    private static final int PULL_REFRESH_DISTANCE_DP = 96;
    private static final int STOCK_LABEL_WIDTH_DOTS = 320;
    private static final int STOCK_LABEL_HEIGHT_DOTS = 240;

    private final Object printerSocketLock = new Object();
    private WebView webView;
    private BluetoothSocket cachedPrinterSocket;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private float pullStartY = 0f;
    private boolean trackingPullRefresh = false;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout rootLayout = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(246, 247, 249));
        webView.setWebViewClient(new PortalWebViewClient());
        webView.setWebChromeClient(new PortalChromeClient());

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setOnTouchListener(new PullRefreshTouchListener());
        webView.addJavascriptInterface(new PortalBridge(), "Android");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        CookieManager.getInstance().flush();

        rootLayout.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(rootLayout);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(portalUrl());
        }
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

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request != null && request.isForMainFrame()) {
                Toast.makeText(MainActivity.this, "No se pudo cargar portal stock.", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private class PortalChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
            WebView view,
            ValueCallback<Uri[]> callback,
            FileChooserParams params
        ) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            deletePendingCameraFile();
            filePathCallback = callback;
            try {
                Intent chooserIntent = buildImageChooserIntent(params);
                startActivityForResult(chooserIntent, FILE_CHOOSER_REQUEST);
            } catch (ActivityNotFoundException error) {
                filePathCallback = null;
                Toast.makeText(MainActivity.this, "No se encontro una app para seleccionar fotos.", Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }
    }

    private Intent buildImageChooserIntent(WebChromeClient.FileChooserParams params) {
        Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
        galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
        galleryIntent.setType("image/*");

        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        pendingCameraUri = createPrivateCameraImageUri();

        Intent chooserIntent = Intent.createChooser(galleryIntent, "Agregar fotos");
        if (cameraIntent.resolveActivity(getPackageManager()) != null && pendingCameraUri != null) {
            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            cameraIntent.setClipData(ClipData.newUri(getContentResolver(), "Foto stock", pendingCameraUri));
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            grantCameraUriPermissions(cameraIntent, pendingCameraUri);
            chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { cameraIntent });
        }
        return chooserIntent;
    }

    private Uri createPrivateCameraImageUri() {
        try {
            File cameraDir = new File(getCacheDir(), "stock-camera");
            if (!cameraDir.exists() && !cameraDir.mkdirs()) return null;
            pendingCameraFile = File.createTempFile("stock_", ".jpg", cameraDir);
            return FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                pendingCameraFile
            );
        } catch (Exception error) {
            pendingCameraFile = null;
            return null;
        }
    }

    private void grantCameraUriPermissions(Intent cameraIntent, Uri cameraUri) {
        List<ResolveInfo> cameraActivities = getPackageManager().queryIntentActivities(cameraIntent, 0);
        for (ResolveInfo activity : cameraActivities) {
            grantUriPermission(
                activity.activityInfo.packageName,
                cameraUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        }
    }

    private class PullRefreshTouchListener implements View.OnTouchListener {
        @Override
        public boolean onTouch(View view, MotionEvent event) {
            if (webView == null) return false;
            if (event.getPointerCount() > 1) {
                trackingPullRefresh = false;
                return false;
            }

            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_POINTER_DOWN:
                    trackingPullRefresh = false;
                    return false;
                case MotionEvent.ACTION_DOWN:
                    trackingPullRefresh = webView.getScrollY() == 0;
                    pullStartY = event.getY();
                    return false;
                case MotionEvent.ACTION_MOVE:
                    if (
                        trackingPullRefresh &&
                        webView.getScrollY() == 0 &&
                        event.getY() - pullStartY > dpToPx(PULL_REFRESH_DISTANCE_DP)
                    ) {
                        trackingPullRefresh = false;
                        webView.reload();
                        Toast.makeText(MainActivity.this, "Actualizando...", Toast.LENGTH_SHORT).show();
                        return true;
                    }
                    return false;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    trackingPullRefresh = false;
                    return false;
                default:
                    return false;
            }
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

        openExternalIntent(new Intent(Intent.ACTION_VIEW, Uri.parse(normalizedUrl)));
        return true;
    }

    private void openExternalIntent(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No se pudo abrir el enlace.", Toast.LENGTH_SHORT).show();
        }
    }

    private int dpToPx(int dp) {
        return Math.round(dp * getResources().getDisplayMetrics().density);
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
        public void printStockLabels(String sku, String locationCode, String quantity) {
            final String cleanSku = normalizeLabelText(sku, "SKU");
            final String cleanLocation = normalizeLabelText(locationCode, "UBICACION");
            final int labelCount = Math.max(1, Math.min(9999, parsePositiveInt(quantity, 1)));

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
                            showToast("Activa Bluetooth para imprimir etiquetas.");
                            return;
                        }

                        BluetoothDevice printer = findBondedLabelPrinter(adapter);
                        if (printer == null) {
                            showToast("Empareja la impresora Hstem 420B BL por Bluetooth.");
                            return;
                        }

                        BluetoothSocket socket = getPrinterSocket(printer);
                        OutputStream outputStream = socket.getOutputStream();
                        outputStream.write(buildStockLabelTspl(cleanSku, cleanLocation, labelCount));
                        outputStream.flush();
                        showToast(labelCount + " etiqueta(s) enviadas a la impresora.");
                    } catch (SecurityException error) {
                        requestBluetoothConnectPermission();
                        showToast("Permite Bluetooth para imprimir.");
                    } catch (Exception error) {
                        closeCachedPrinterSocket();
                        showToast("No se pudo conectar con la impresora. Apaga y prende la impresora e intenta de nuevo.");
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

    private byte[] buildStockLabelTspl(String sku, String locationCode, int quantity) {
        String cleanSku = tsplText(sku).replaceAll("[^0-9A-Za-z-]", "");
        if (cleanSku.length() == 0) cleanSku = tsplText(sku);
        Bitmap labelBitmap = renderStockLabelBitmap(cleanSku, tsplText(locationCode));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        appendCommand(output,
            "SIZE 40 mm,30 mm\r\n" +
            "GAP 2 mm,0 mm\r\n" +
            "DIRECTION 1\r\n" +
            "REFERENCE 0,0\r\n" +
            "OFFSET 0 mm\r\n" +
            "SPEED 4\r\n" +
            "DENSITY 10\r\n" +
            "CLS\r\n" +
            "BITMAP 0,0,40,240,0,"
        );
        try {
            output.write(bitmapToTsplBytes(labelBitmap, 178));
        } catch (IOException ignored) {}
        appendCommand(output, "\r\n");
        appendCommand(output, "PRINT " + quantity + ",1\r\n");
        return output.toByteArray();
    }

    private Bitmap renderStockLabelBitmap(String sku, String locationCode) {
        Bitmap bitmap = Bitmap.createBitmap(STOCK_LABEL_WIDTH_DOTS, STOCK_LABEL_HEIGHT_DOTS, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);

        drawStockBrand(canvas);
        drawCenteredText(canvas, sku, STOCK_LABEL_WIDTH_DOTS / 2f, 124, stockSkuTextSize(sku), true);

        List<String> locationLines = wrapTextByWidth(locationCode, 292, 2, textPaint(21, true));
        Paint locationPaint = textPaint(locationLines.size() > 1 ? 18 : 21, true);
        int locationY = locationLines.size() > 1 ? 188 : 202;
        for (String line : locationLines) {
            drawText(canvas, line, 16, locationY, locationPaint);
            locationY += 25;
        }

        return thresholdBitmap(bitmap, 178);
    }

    private void drawStockBrand(Canvas canvas) {
        Paint brandPaint = textPaint(34, true);
        brandPaint.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));
        drawText(canvas, "CARIANA", 35, 44, brandPaint);
        drawLogo(canvas, 210, 6, 76, 44);
    }

    private void drawLogo(Canvas canvas, int x, int y, int width, int height) {
        try {
            Bitmap source = BitmapFactory.decodeResource(getResources(), R.drawable.cariana_hummingbird);
            if (source == null) return;
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            Rect src = new Rect(0, 0, source.getWidth(), source.getHeight());
            RectF dst = fitCenter(src.width(), src.height(), x, y, width, height);
            canvas.drawBitmap(source, src, dst, paint);
        } catch (Exception ignored) {}
    }

    private RectF fitCenter(int sourceWidth, int sourceHeight, int x, int y, int width, int height) {
        float scale = Math.min(width / (float) sourceWidth, height / (float) sourceHeight);
        float drawWidth = sourceWidth * scale;
        float drawHeight = sourceHeight * scale;
        float left = x + ((width - drawWidth) / 2f);
        float top = y + ((height - drawHeight) / 2f);
        return new RectF(left, top, left + drawWidth, top + drawHeight);
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
        Paint paint = textPaint(size, bold);
        String value = String.valueOf(text == null ? "" : text);
        canvas.drawText(value, centerX - (paint.measureText(value) / 2f), baseline, paint);
    }

    private int stockSkuTextSize(String sku) {
        int length = String.valueOf(sku == null ? "" : sku).length();
        if (length > 10) return 42;
        if (length > 8) return 48;
        return 54;
    }

    private List<String> wrapTextByWidth(String text, float maxWidth, int maxLines, Paint paint) {
        String normalized = normalizeLabelText(text, "-").replaceAll("\\s+", " ").trim();
        String[] words = normalized.split(" ");
        java.util.ArrayList<String> lines = new java.util.ArrayList<>();
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
        Arrays.fill(bytes, (byte) 0xFF);
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

    private void appendCommand(ByteArrayOutputStream output, String command) {
        try {
            output.write(command.getBytes(StandardCharsets.ISO_8859_1));
        } catch (IOException ignored) {}
    }

    private String normalizeLabelText(String value, String fallback) {
        String text = String.valueOf(value == null ? "" : value).trim();
        return text.isEmpty() ? fallback : text;
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

    private String[] splitLocationForLabel(String value, int maxCharsPerLine) {
        String text = normalizeLabelText(value, "-").replaceAll("\\s+", " ");
        if (text.length() <= maxCharsPerLine) {
            return new String[] { text };
        }

        int splitAt = -1;
        for (int i = Math.min(maxCharsPerLine, text.length() - 1); i > 0; i--) {
            char character = text.charAt(i);
            if (character == '-' || character == ' ') {
                splitAt = i;
                break;
            }
        }
        if (splitAt <= 0) splitAt = Math.min(maxCharsPerLine, text.length());

        String firstLine = text.substring(0, splitAt).trim();
        String secondLine = text.substring(Math.min(text.length(), splitAt + 1)).trim();
        if (secondLine.length() > maxCharsPerLine) {
            secondLine = truncateForLabel(secondLine, maxCharsPerLine);
        }
        return new String[] { firstLine, secondLine };
    }

    private int parsePositiveInt(String value, int fallback) {
        try {
            int parsed = Integer.parseInt(String.valueOf(value == null ? "" : value).trim());
            return parsed > 0 ? parsed : fallback;
        } catch (Exception error) {
            return fallback;
        }
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;
        Uri[] results = null;
        boolean usedCameraPhoto = false;
        if (resultCode == RESULT_OK && pendingCameraUri != null && pendingCameraFile != null && pendingCameraFile.length() > 0) {
            results = new Uri[] { pendingCameraUri };
            usedCameraPhoto = true;
        }
        if (results == null) {
            results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        }
        if (results == null) {
            filePathCallback.onReceiveValue(null);
        } else {
            filePathCallback.onReceiveValue(results);
        }
        if (!usedCameraPhoto) {
            deletePendingCameraFile();
        }
        filePathCallback = null;
        pendingCameraUri = null;
        pendingCameraFile = null;
    }

    private void deletePendingCameraFile() {
        if (pendingCameraFile != null && pendingCameraFile.exists()) {
            pendingCameraFile.delete();
        }
        pendingCameraFile = null;
        pendingCameraUri = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onStop() {
        CookieManager.getInstance().flush();
        super.onStop();
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
