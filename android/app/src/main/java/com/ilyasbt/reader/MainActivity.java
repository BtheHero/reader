package com.ilyasbt.reader;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * Reader for Android: the Reader website in a full-screen WebView, plus what a website can't do on its own:
 * blocking ads inside the embedded YouTube / X players, opening links in the right app, saving files,
 * fullscreen video, and playing podcasts with the screen off.
 */
public class MainActivity extends ComponentActivity {

    static final String HOME = "https://reader-359.pages.dev/";
    private static final String HOME_HOST = Uri.parse(HOME).getHost();

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean askedForNotifications = false;

    // The running screen, so the notification's buttons can reach the page's player
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    /** A notification / headphone button: tell Reader's podcast player (window.ReaderPod in app.js) */
    static void podcast(String command) {
        MainActivity a = current.get();
        if (a == null) return;
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.ReaderPod && window.ReaderPod." + command + "()", null));
    }

    private final ActivityResultLauncher<String[]> pickFile = registerForActivityResult(
            new ActivityResultContracts.OpenDocument(), uri -> {
                if (fileCallback != null) fileCallback.onReceiveValue(uri != null ? new Uri[]{uri} : null);
                fileCallback = null;
            });

    private final ActivityResultLauncher<String> askNotifications = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> { });

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Draw behind the system bars and pad the page by their size, so nothing hides under them
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.bg));
        current = new WeakReference<>(this);
        // Keeps telling the page it's visible, so players don't pause with the screen off
        web = new ReaderWebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString() + " ReaderApp/1");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new Bridge(), "ReaderApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        // Back: leave fullscreen, then let Reader close what's open (its overlays use browser history), then exit
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (fullscreenView != null) {
                    if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                } else if (web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(HOME);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    // Deliberately no web.onPause() in onPause: that would stop audio when the screen turns off
    @Override
    protected void onDestroy() {
        stopService(new Intent(this, PlaybackService.class));
        web.destroy();
        super.onDestroy();
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private class Client extends WebViewClient {
        private final byte[] empty = new byte[0];

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!AdBlock.blocked(request.getUrl())) return null;
            return new WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                    Collections.<String, String>emptyMap(), new ByteArrayInputStream(empty));
        }

        // Reader's own pages stay in the app; any other page opens in its app (YouTube, X…) or the browser
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            if (HOME_HOST.equals(request.getUrl().getHost())) return false;
            openExternally(request.getUrl());
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        // Links that open a new window (target="_blank") go to their app or the browser
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView catcher = new WebView(MainActivity.this);
            catcher.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    openExternally(r.getUrl());
                    v.destroy();
                    return true;
                }
            });
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(catcher);
            resultMsg.sendToTarget();
            return true;
        }

        // OPML import
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            pickFile.launch(new String[]{"*/*"});
            return true;
        }

        // Fullscreen video
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
            fullscreenView = view;
            fullscreenCallback = callback;
            view.setBackgroundColor(Color.BLACK);
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            WindowInsetsControllerCompat c = new WindowInsetsControllerCompat(getWindow(), root);
            c.hide(WindowInsetsCompat.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }

        @Override
        public void onHideCustomView() {
            if (fullscreenView != null) root.removeView(fullscreenView);
            fullscreenView = null;
            fullscreenCallback = null;
            web.setVisibility(View.VISIBLE);
            new WindowInsetsControllerCompat(getWindow(), root).show(WindowInsetsCompat.Type.systemBars());
        }
    }

    /** What Reader's page can ask the app to do (window.ReaderApp in app.js) */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String text) {
            runOnUiThread(() -> {
                try {
                    saveToDownloads(name, mime, text);
                    Toast.makeText(MainActivity.this, "Saved " + name + " to Downloads", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Couldn't save the file", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /**
         * The podcast player changed: open (with the episode, playing or paused) shows the media notification and
         * keeps Reader running in the background; closed removes it.
         */
        @JavascriptInterface
        public void mediaState(boolean active, boolean playing, String title, String subtitle) {
            runOnUiThread(() -> {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                if (!active) { stopService(intent); return; }
                if (Build.VERSION.SDK_INT >= 33 && !askedForNotifications
                        && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    askedForNotifications = true;
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS);
                }
                intent.putExtra(PlaybackService.EXTRA_ACTIVE, true).putExtra(PlaybackService.EXTRA_PLAYING, playing)
                        .putExtra(PlaybackService.EXTRA_TITLE, title).putExtra(PlaybackService.EXTRA_SUBTITLE, subtitle);
                ContextCompat.startForegroundService(MainActivity.this, intent);
            });
        }

        /** Older pages: playing = shown, stopped = removed */
        @JavascriptInterface
        public void setPlaying(boolean playing, String title, String subtitle) {
            mediaState(playing, playing, title, subtitle);
        }
    }

    private void saveToDownloads(String name, String mime, String text) throws Exception {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("no uri");
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("no stream");
                out.write(bytes);
            }
        } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getFilesDir();
            try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                out.write(bytes);
            }
        }
    }
}
