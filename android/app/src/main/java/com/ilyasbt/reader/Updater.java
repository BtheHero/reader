package com.ilyasbt.reader;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Updates the app from inside it: the GitHub Actions build publishes BT-Feeder.apk and version.txt (its build
 * number) on the app-latest release. check() reads version.txt; install() downloads the APK and hands it to Android's
 * package installer, which installs it over this app (same signing key, so nothing is lost). Android asks once to
 * allow installs from BT Feeder, and shows its confirm screen (on Android 12 and later only while BT Feeder isn't yet
 * the app that installed itself).
 */
final class Updater {

    private Updater() {}

    static final String RELEASE = "https://github.com/BtheHero/reader/releases/download/app-latest/";
    static final String ACTION_STATUS = "com.ilyasbt.reader.UPDATE_STATUS";

    interface Progress { void percent(int p); }

    static long installedBuild(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        // GitHub answers with a redirect to its file server; followed by hand, so https -> https always works
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "BT-Feeder-Android");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (code != 200) { c.disconnect(); throw new IOException("GitHub answered " + code); }
            return c;
        }
        throw new IOException("Too many redirects");
    }

    /** The newest published build number (blocking: call off the main thread) */
    static long latestBuild() throws IOException {
        HttpURLConnection c = open(RELEASE + "version.txt?t=" + System.currentTimeMillis());
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[64];
            int n = in.read(buf);
            return Long.parseLong(new String(buf, 0, Math.max(0, n), StandardCharsets.UTF_8).trim());
        } finally {
            c.disconnect();
        }
    }

    /** Downloads the APK and starts installing it (blocking: call off the main thread) */
    static void install(Context ctx, Progress progress) throws IOException {
        File apk = new File(ctx.getCacheDir(), "update.apk");
        HttpURLConnection c = open(RELEASE + "BT-Feeder.apk?t=" + System.currentTimeMillis());
        long total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
            byte[] buf = new byte[65536];
            long done = 0;
            int n, last = -1;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                int p = total > 0 ? (int) (done * 100 / total) : -1;
                if (p != last) { last = p; progress.percent(p); }
            }
        } finally {
            c.disconnect();
        }

        PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("BT-Feeder.apk", 0, apk.length())) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                session.fsync(out);
            }
            Intent status = new Intent(ctx, StatusReceiver.class).setAction(ACTION_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            session.commit(PendingIntent.getBroadcast(ctx, id, status, flags).getIntentSender());
        }
    }

    /** What the installer says: show its confirm screen, or report a failure to the page */
    public static class StatusReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { context.startActivity(confirm); } catch (Exception e) { MainActivity.updateStatus("failed", "Android didn't show the install screen"); }
                }
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                MainActivity.updateStatus(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "cancelled" : "failed", msg != null ? msg : "");
            }
            // Success: Android closes the app to replace it; it opens on the new version next time
        }
    }
}
