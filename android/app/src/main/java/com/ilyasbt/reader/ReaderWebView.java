package com.ilyasbt.reader;

import android.content.Context;
import android.graphics.Canvas;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

/**
 * A WebView that keeps telling the page it's visible when the screen is off or another app is in front.
 * Players pause when their page is hidden (YouTube's embed does); with this, podcasts and videos keep playing
 * in the background, kept alive by PlaybackService.
 *
 * It also never keeps the screen on by itself. Android's WebView holds the screen awake for any video that plays
 * (it marks a view "keep screen on"), so a podcast playing through YouTube's player, even hidden in the player bar,
 * kept the phone's screen on for hours. BT Feeder's page decides instead: it asks MainActivity to keep the screen
 * on only while you're watching a video (window.ReaderApp.keepAwake).
 */
public class ReaderWebView extends WebView {

    private final Runnable sweep = new Runnable() {
        @Override
        public void run() {
            clearKeepScreenOn(getRootView());
            postDelayed(this, 3000);
        }
    };

    public ReaderWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // Only ever pass on "visible". Leaving the app or turning the screen off reports GONE or INVISIBLE;
        // passing either on would make the page hidden, and players pause on a hidden page.
        if (visibility == View.VISIBLE) super.onWindowVisibilityChanged(View.VISIBLE);
    }

    // The WebView's own "keep the screen on" requests: on itself, and on the views it adds for its players
    @Override
    public void setKeepScreenOn(boolean keepScreenOn) {
        super.setKeepScreenOn(false);
    }

    @Override
    public void recomputeViewAttributes(View child) {
        if (child != null && child.getKeepScreenOn()) child.setKeepScreenOn(false);
        super.recomputeViewAttributes(child);
    }

    @Override
    public void onViewAdded(View child) {
        super.onViewAdded(child);
        child.setKeepScreenOn(false);
    }

    @Override
    protected void dispatchDraw(Canvas canvas) {
        super.dispatchDraw(canvas);
        for (int i = 0; i < getChildCount(); i++) {
            View c = getChildAt(i);
            if (c.getKeepScreenOn()) c.setKeepScreenOn(false);
        }
    }

    // A last check every few seconds, for requests made while Android was already updating the window
    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        removeCallbacks(sweep);
        postDelayed(sweep, 3000);
    }

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(sweep);
        super.onDetachedFromWindow();
    }

    private static void clearKeepScreenOn(View v) {
        if (v.getKeepScreenOn()) v.setKeepScreenOn(false);
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) clearKeepScreenOn(g.getChildAt(i));
        }
    }
}
