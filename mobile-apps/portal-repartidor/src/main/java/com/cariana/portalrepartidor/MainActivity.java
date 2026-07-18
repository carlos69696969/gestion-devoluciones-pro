package com.cariana.portalrepartidor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String SHOP_DOMAIN = "qc1u2w-ft.myshopify.com";
    private static final String PORTAL_HOST = "gestion-devoluciones-pro.onrender.com";
    private static final String BASE_URL = "https://" + PORTAL_HOST + "/repartidor?shop=" + SHOP_DOMAIN;
    private FrameLayout rootLayout;
    private WebView webView;
    private View offlineView;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean offlineVisible;
    private float pullRefreshStartY = -1f;
    private boolean pullRefreshReady;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        rootLayout = new FrameLayout(this);
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
        CookieManager.getInstance().flush();
        installPullToRefresh();
        offlineView = createOfflineView();
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        rootLayout.addView(offlineView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        offlineView.setVisibility(View.GONE);
        registerNetworkWatcher();

        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(rootLayout);
        if (!isNetworkAvailable()) {
            showOfflineView();
        } else if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(portalUrl());
        }
    }

    private void installPullToRefresh() {
        webView.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    pullRefreshStartY = event.getY();
                    pullRefreshReady = webView.getScrollY() <= 0;
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (pullRefreshReady && webView.getScrollY() <= 0 && event.getY() - pullRefreshStartY > 150f) {
                        pullRefreshReady = false;
                        CookieManager.getInstance().flush();
                        webView.reload();
                        Toast.makeText(this, "Actualizando...", Toast.LENGTH_SHORT).show();
                    }
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    pullRefreshStartY = -1f;
                    pullRefreshReady = false;
                    break;
                default:
                    break;
            }
            return false;
        });
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
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (isNetworkAvailable()) {
                hideOfflineView();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request != null && request.isForMainFrame()) {
                showOfflineView();
            }
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            super.onReceivedError(view, errorCode, description, failingUrl);
            showOfflineView();
        }
    }

    private View createOfflineView() {
        FrameLayout wrapper = new FrameLayout(this);
        ImageView image = new ImageView(this);
        image.setImageResource(getResources().getIdentifier("offline_screen", "drawable", getPackageName()));
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        wrapper.addView(image, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(30, 0, 30, 0);

        TextView title = new TextView(this);
        title.setText("Sin conexion");
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        panel.addView(title);

        TextView message = new TextView(this);
        message.setText("Comprueba que estas conectado a Wi-Fi o tengas datos moviles.");
        message.setTextColor(Color.WHITE);
        message.setTextSize(16);
        message.setGravity(Gravity.CENTER);
        message.setPadding(0, 10, 0, 18);
        panel.addView(message);

        Button retryButton = new Button(this);
        retryButton.setText("Reintentar");
        retryButton.setTextColor(Color.WHITE);
        retryButton.setTextSize(15);
        retryButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        retryButton.setBackgroundColor(Color.rgb(0, 91, 211));
        retryButton.setOnClickListener(view -> retryConnection());
        panel.addView(retryButton, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
        );
        panelParams.setMargins(34, 0, 34, 86);
        wrapper.addView(panel, panelParams);
        return wrapper;
    }

    private void registerNetworkWatcher() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> retryConnection());
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> showOfflineView());
            }
        };
        try {
            NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
            manager.registerNetworkCallback(request, networkCallback);
        } catch (Exception ignored) {}
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network network = manager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void showOfflineView() {
        offlineVisible = true;
        if (offlineView != null) offlineView.setVisibility(View.VISIBLE);
        if (webView != null) webView.setVisibility(View.GONE);
    }

    private void hideOfflineView() {
        offlineVisible = false;
        if (offlineView != null) offlineView.setVisibility(View.GONE);
        if (webView != null) webView.setVisibility(View.VISIBLE);
    }

    private void retryConnection() {
        if (!isNetworkAvailable()) {
            showOfflineView();
            return;
        }
        hideOfflineView();
        CookieManager.getInstance().flush();
        String currentUrl = webView == null ? "" : webView.getUrl();
        if (currentUrl == null || currentUrl.trim().isEmpty()) {
            webView.loadUrl(portalUrl());
        } else {
            webView.reload();
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
    protected void onResume() {
        super.onResume();
        if (offlineVisible && isNetworkAvailable()) {
            retryConnection();
        } else if (!isNetworkAvailable()) {
            showOfflineView();
        }
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

    @Override
    protected void onDestroy() {
        if (networkCallback != null) {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
                try {
                    manager.unregisterNetworkCallback(networkCallback);
                } catch (Exception ignored) {}
            }
        }
        super.onDestroy();
    }
}
