package com.ilyasbt.reader;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reader for Android: the Reader website in a full-screen WebView, plus what a website can't do on its own:
 * blocking ads inside the embedded YouTube / X players, opening links in the right app, saving files,
 * fullscreen video, playing podcasts with the screen off, and the Music tab's folder (picked with Android's folder
 * picker, listed here, and each file served to the page at __music/?id=…, seeking included).
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

    // ---------- Music folder ----------

    private static final Pattern AUDIO = Pattern.compile(".*\\.(mp3|m4a|m4b|mp4|aac|adts|flac|ogg|oga|opus|wav|wave|weba|webm|mka|wma|aif|aiff|aifc|caf|alac|3gp|amr|ape|wv|dsf|mpc)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final ActivityResultLauncher<Uri> pickFolder = registerForActivityResult(
            new ActivityResultContracts.OpenDocumentTree(), uri -> {
                if (uri == null) { sendMusic("{\"cancelled\":true}"); return; }
                try {
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException e) { /* still readable until the app closes */ }
                Uri old = musicTree();
                if (old != null && !old.equals(uri)) {
                    try { getContentResolver().releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException e) { /* fine */ }
                }
                prefs().edit().putString("musicTree", uri.toString()).apply();
                scanMusic();
            });

    private SharedPreferences prefs() { return getSharedPreferences("reader", MODE_PRIVATE); }

    private Uri musicTree() {
        String t = prefs().getString("musicTree", null);
        return t == null ? null : Uri.parse(t);
    }

    private void sendMusic(String json) {
        runOnUiThread(() -> web.evaluateJavascript("window.ReaderMusic && window.ReaderMusic.onScan(" + JSONObject.quote(json) + ")", null));
    }

    /** Every music file in the folder and its subfolders: id (Android's document id), path in the folder, name, size, date */
    private void scanMusic() {
        Uri tree = musicTree();
        if (tree == null) { sendMusic("{\"error\":\"none\"}"); return; }
        io.execute(() -> {
            try {
                String rootId = DocumentsContract.getTreeDocumentId(tree);
                String folder = "Music";
                try (Cursor c = getContentResolver().query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId),
                        new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst() && c.getString(0) != null) folder = c.getString(0);
                }
                JSONArray files = new JSONArray();
                ArrayDeque<String[]> todo = new ArrayDeque<>();
                todo.add(new String[]{rootId, ""});
                String[] cols = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
                while (!todo.isEmpty() && files.length() < 50000) {
                    String[] dir = todo.poll();
                    try (Cursor c = getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir[0]), cols, null, null, null)) {
                        while (c != null && c.moveToNext()) {
                            String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                            if (id == null || name == null || name.startsWith(".")) continue;
                            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) { todo.add(new String[]{id, dir[1] + name + "/"}); continue; }
                            if (!AUDIO.matcher(name).matches()) continue;
                            JSONObject o = new JSONObject();
                            o.put("id", id);
                            o.put("path", dir[1] + name);
                            o.put("name", name);
                            o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                            o.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                            files.put(o);
                        }
                    }
                }
                JSONObject out = new JSONObject();
                out.put("folder", folder);
                out.put("files", files);
                sendMusic(out.toString());
            } catch (SecurityException e) {
                sendMusic("{\"error\":\"BT Feeder can't open that folder any more. Choose it again.\"}");
            } catch (Exception e) {
                sendMusic("{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        });
    }

    /** One music file for the page, from the chosen folder only; a Range request gets just that part (for seeking) */
    private WebResourceResponse musicFile(WebResourceRequest request) {
        Uri tree = musicTree();
        String id = request.getUrl().getQueryParameter("id");
        if (tree == null || id == null) return status(404, "Not Found");
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            AssetFileDescriptor afd = getContentResolver().openAssetFileDescriptor(doc, "r");
            if (afd == null) return status(404, "Not Found");
            FileInputStream in = afd.createInputStream();
            long length = afd.getLength();
            if (length < 0) length = in.getChannel().size();
            long start = 0, end = length - 1;
            boolean partial = false;
            String range = null;
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
            if (range != null) {
                Matcher m = RANGE.matcher(range.trim());
                if (m.matches() && (!m.group(1).isEmpty() || !m.group(2).isEmpty())) {
                    if (m.group(1).isEmpty()) start = Math.max(0, length - Long.parseLong(m.group(2)));
                    else { start = Long.parseLong(m.group(1)); if (!m.group(2).isEmpty()) end = Math.min(end, Long.parseLong(m.group(2))); }
                    partial = true;
                }
            }
            if (start >= length || start > end) { in.close(); afd.close(); return status(416, "Range Not Satisfiable"); }
            if (start > 0) in.getChannel().position(afd.getStartOffset() + start);
            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Content-Length", String.valueOf(end - start + 1));
            headers.put("Cache-Control", "no-store");
            if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
            String mime = getContentResolver().getType(doc);
            if (mime == null || !mime.startsWith("audio/")) {
                String ext = id.contains(".") ? id.substring(id.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                String guess = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                mime = guess != null ? guess : "application/octet-stream";
            }
            return new WebResourceResponse(mime, null, partial ? 206 : 200, partial ? "Partial Content" : "OK", headers, new Part(in, end - start + 1, afd));
        } catch (SecurityException | IllegalArgumentException e) {
            return status(403, "Forbidden");
        } catch (Exception e) {
            return status(404, "Not Found");
        }
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    /** At most n bytes of a file; closing it closes the file */
    private static final class Part extends FilterInputStream {
        private long left;
        private final AssetFileDescriptor afd;
        Part(InputStream in, long n, AssetFileDescriptor afd) { super(in); left = n; this.afd = afd; }
        @Override public int read() throws IOException { if (left <= 0) return -1; int b = super.read(); if (b >= 0) left--; return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public long skip(long n) throws IOException { long s = super.skip(Math.min(n, left)); left -= s; return s; }
        @Override public int available() throws IOException { return (int) Math.min(super.available(), left); }
        @Override public void close() throws IOException { super.close(); afd.close(); }
    }

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
        io.shutdown();
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
            Uri u = request.getUrl();
            if (HOME_HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().endsWith("/__music/")) return musicFile(request);
            if (!AdBlock.blocked(u)) return null;
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

        /** Like mediaState; kind "music" gives the notification previous / next buttons instead of back 15 s / forward 30 s */
        @JavascriptInterface
        public void mediaState2(boolean active, boolean playing, String title, String subtitle, String kind) {
            runOnUiThread(() -> {
                Intent intent = new Intent(MainActivity.this, PlaybackService.class);
                if (!active) { stopService(intent); return; }
                if (Build.VERSION.SDK_INT >= 33 && !askedForNotifications
                        && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    askedForNotifications = true;
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS);
                }
                intent.putExtra(PlaybackService.EXTRA_ACTIVE, true).putExtra(PlaybackService.EXTRA_PLAYING, playing)
                        .putExtra(PlaybackService.EXTRA_TITLE, title).putExtra(PlaybackService.EXTRA_SUBTITLE, subtitle)
                        .putExtra(PlaybackService.EXTRA_MUSIC, "music".equals(kind));
                ContextCompat.startForegroundService(MainActivity.this, intent);
            });
        }

        /** The screen stays on only while the page asks (a video you're watching), never for podcasts or music */
        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        /** Music tab: choose the music folder (Android's folder picker); the files come back through ReaderMusic.onScan */
        @JavascriptInterface
        public void musicPick() {
            runOnUiThread(() -> {
                try { pickFolder.launch(null); } catch (ActivityNotFoundException e) { Toast.makeText(MainActivity.this, "No folder picker on this device", Toast.LENGTH_SHORT).show(); }
            });
        }

        /** Music tab: list the chosen folder again (new and removed songs) */
        @JavascriptInterface
        public void musicScan() {
            scanMusic();
        }

        /** Music tab: forget the folder */
        @JavascriptInterface
        public void musicForget() {
            Uri old = musicTree();
            if (old != null) {
                try { getContentResolver().releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException e) { /* fine */ }
            }
            prefs().edit().remove("musicTree").apply();
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
