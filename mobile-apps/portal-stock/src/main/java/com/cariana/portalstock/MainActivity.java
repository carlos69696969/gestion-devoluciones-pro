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
import android.graphics.Color;
import android.graphics.Rect;
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
        String cleanLocation = truncateForLabel(tsplText(locationCode), 24);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        appendCommand(output,
            "SIZE 40 mm,30 mm\r\n" +
            "GAP 2 mm,0 mm\r\n" +
            "DIRECTION 1\r\n" +
            "REFERENCE 0,0\r\n" +
            "OFFSET 0 mm\r\n" +
            "SPEED 4\r\n" +
            "DENSITY 10\r\n" +
            "CLS\r\n"
        );
        appendLogoBitmapCommand(output, 50, 8, 220, 78);
        appendCommand(output,
            "TEXT 56,92,\"4\",0,2,2,\"" + cleanSku + "\"\r\n" +
            "TEXT 18,204,\"2\",0,1,1,\"" + cleanLocation + "\"\r\n" +
            "PRINT " + quantity + ",1\r\n"
        );
        return output.toByteArray();
    }

    private void appendLogoBitmapCommand(ByteArrayOutputStream output, int x, int y, int maxWidth, int maxHeight) {
        try {
            Bitmap source = BitmapFactory.decodeResource(getResources(), R.drawable.stock_label_logo);
            if (source == null) return;
            Bitmap cropped = cropLogoWhitespace(source);
            int scaledWidth = Math.max(1, cropped.getWidth());
            int scaledHeight = Math.max(1, cropped.getHeight());
            float scale = Math.min(
                (float) maxWidth / (float) scaledWidth,
                (float) maxHeight / (float) scaledHeight
            );
            scaledWidth = Math.max(1, Math.round(scaledWidth * scale));
            scaledHeight = Math.max(1, Math.round(scaledHeight * scale));
            Bitmap scaled = Bitmap.createScaledBitmap(cropped, scaledWidth, scaledHeight, true);
            int widthBytes = (scaled.getWidth() + 7) / 8;
            byte[] imageBytes = new byte[widthBytes * scaled.getHeight()];

            for (int row = 0; row < scaled.getHeight(); row++) {
                for (int col = 0; col < scaled.getWidth(); col++) {
                    int pixel = scaled.getPixel(col, row);
                    int alpha = Color.alpha(pixel);
                    int red = Color.red(pixel);
                    int green = Color.green(pixel);
                    int blue = Color.blue(pixel);
                    boolean black = alpha > 64 && ((red + green + blue) / 3) < 180;
                    if (black) {
                        int byteIndex = row * widthBytes + (col / 8);
                        imageBytes[byteIndex] |= (byte) (0x80 >> (col % 8));
                    }
                }
            }

            int centeredX = x + Math.max(0, (maxWidth - scaled.getWidth()) / 2);
            appendCommand(output, "BITMAP " + centeredX + "," + y + "," + widthBytes + "," + scaled.getHeight() + ",0,");
            output.write(imageBytes);
            appendCommand(output, "\r\n");
        } catch (Exception ignored) {}
    }

    private Bitmap cropLogoWhitespace(Bitmap source) {
        int left = source.getWidth();
        int top = source.getHeight();
        int right = -1;
        int bottom = -1;

        for (int y = 0; y < source.getHeight(); y++) {
            for (int x = 0; x < source.getWidth(); x++) {
                int pixel = source.getPixel(x, y);
                int alpha = Color.alpha(pixel);
                int red = Color.red(pixel);
                int green = Color.green(pixel);
                int blue = Color.blue(pixel);
                boolean visible = alpha > 32 && ((red + green + blue) / 3) < 245;
                if (!visible) continue;
                if (x < left) left = x;
                if (y < top) top = y;
                if (x > right) right = x;
                if (y > bottom) bottom = y;
            }
        }

        if (right < left || bottom < top) return source;
        Rect bounds = new Rect(
            Math.max(0, left - 8),
            Math.max(0, top - 8),
            Math.min(source.getWidth(), right + 9),
            Math.min(source.getHeight(), bottom + 9)
        );
        return Bitmap.createBitmap(source, bounds.left, bounds.top, bounds.width(), bounds.height());
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
