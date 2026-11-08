package com.ilyasbt.reader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.ServiceCompat;

/**
 * Runs while the podcast player is open: a media notification (back 15 s / play-pause / forward 30 s), lock-screen
 * and headphone controls (a MediaSession), and it keeps Android from stopping Reader while audio plays with the
 * screen off. The playing itself happens in Reader's page; buttons are passed on to it (ReaderPod in app.js).
 */
public class PlaybackService extends Service {

    static final String EXTRA_ACTIVE = "active", EXTRA_PLAYING = "playing", EXTRA_TITLE = "title", EXTRA_SUBTITLE = "subtitle";
    private static final String ACTION_TOGGLE = "com.ilyasbt.reader.TOGGLE";
    private static final String ACTION_BACK = "com.ilyasbt.reader.BACK";
    private static final String ACTION_FORWARD = "com.ilyasbt.reader.FORWARD";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;
    private MediaSession session;
    private boolean playing;
    private String title = "Playing", subtitle = "";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSession(this, "BT Feeder");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.podcast("toggle"); }
            @Override public void onPause() { MainActivity.podcast("toggle"); }
            @Override public void onRewind() { MainActivity.podcast("back"); }
            @Override public void onFastForward() { MainActivity.podcast("fwd"); }
            @Override public void onSkipToPrevious() { MainActivity.podcast("back"); }
            @Override public void onSkipToNext() { MainActivity.podcast("fwd"); }
            @Override public void onStop() { MainActivity.podcast("toggle"); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_TOGGLE.equals(action)) { MainActivity.podcast("toggle"); return START_NOT_STICKY; }
        if (ACTION_BACK.equals(action)) { MainActivity.podcast("back"); return START_NOT_STICKY; }
        if (ACTION_FORWARD.equals(action)) { MainActivity.podcast("fwd"); return START_NOT_STICKY; }

        if (intent != null) {
            playing = intent.getBooleanExtra(EXTRA_PLAYING, true);
            String t = intent.getStringExtra(EXTRA_TITLE), s = intent.getStringExtra(EXTRA_SUBTITLE);
            if (t != null && !t.trim().isEmpty()) title = t;
            if (s != null) subtitle = s;
        }

        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_FAST_FORWARD
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SKIP_TO_NEXT)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());

        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(),
                Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0);

        // Keep the processor awake only while something actually plays
        if (playing) {
            if (wakeLock == null) {
                PowerManager power = getSystemService(PowerManager.class);
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Reader:playback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
        } else if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Podcast controls while the player is open");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(open)
                .setOngoing(playing)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .addAction(action(android.R.drawable.ic_media_rew, "Back 15 seconds", ACTION_BACK, 1))
                .addAction(action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pause" : "Play", ACTION_TOGGLE, 2))
                .addAction(action(android.R.drawable.ic_media_ff, "Forward 30 seconds", ACTION_FORWARD, 3))
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
                .build();
    }

    private Notification.Action action(int icon, String label, String actionName, int requestCode) {
        PendingIntent pi = PendingIntent.getService(this, requestCode,
                new Intent(this, PlaybackService.class).setAction(actionName),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (session != null) { session.setActive(false); session.release(); }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
