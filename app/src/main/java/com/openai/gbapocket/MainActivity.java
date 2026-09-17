package com.openai.gbapocket;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 5173;
    private static final String APP_HOST = "app.local";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enterImmersiveMode();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new LocalAssetClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                        "application/octet-stream", "application/zip",
                        "application/x-gba-rom", "application/x-gameboy-advance-rom"
                });
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception ex) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.loadUrl("https://" + APP_HOST + "/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri != null) result = new Uri[] { uri };
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        enterImmersiveMode();
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.__orientationChanged && window.__orientationChanged()", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("window.__appPause && window.__appPause()", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.__closeSettings ? String(window.__closeSettings()) : 'false'",
                    value -> {
                        if (!"\"true\"".equals(value) && !"true".equals(value)) {
                            MainActivity.super.onBackPressed();
                        }
                    });
        } else {
            super.onBackPressed();
        }
    }

    private void enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private final class LocalAssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"https".equals(uri.getScheme()) || !APP_HOST.equals(uri.getHost())) {
                return super.shouldInterceptRequest(view, request);
            }
            String path = uri.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            if (path.startsWith("/")) path = path.substring(1);
            if (path.contains("..")) return errorResponse(403, "Forbidden");

            try {
                InputStream stream = getAssets().open(path);
                String mime = mimeType(path);
                String encoding = mime.startsWith("text/") || mime.contains("javascript")
                        || mime.contains("json") ? "UTF-8" : null;
                Map<String, String> headers = new HashMap<>();
                headers.put("Access-Control-Allow-Origin", "https://" + APP_HOST);
                headers.put("Cross-Origin-Resource-Policy", "same-origin");
                headers.put("Cache-Control", "no-cache");
                return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
            } catch (FileNotFoundException ex) {
                return errorResponse(404, "Not Found");
            } catch (IOException ex) {
                return errorResponse(500, "Asset error");
            }
        }

        private WebResourceResponse errorResponse(int code, String message) {
            return new WebResourceResponse("text/plain", "UTF-8", code, message,
                    new HashMap<>(), new java.io.ByteArrayInputStream(message.getBytes()));
        }

        private String mimeType(String path) {
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".html")) return "text/html";
            if (lower.endsWith(".css")) return "text/css";
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
            if (lower.endsWith(".wasm")) return "application/wasm";
            if (lower.endsWith(".json")) return "application/json";
            if (lower.endsWith(".txt")) return "text/plain";
            return "application/octet-stream";
        }
    }
}
