package com.ilyasbt.reader;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView that keeps telling the page it's visible when the screen is off or another app is in front.
 * Players pause when their page is hidden (YouTube's embed does); with this, podcasts and videos keep playing
 * in the background, kept alive by PlaybackService.
 */
public class ReaderWebView extends WebView {

    public ReaderWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // GONE still goes through (the window is really being torn down); hidden counts as visible
        super.onWindowVisibilityChanged(visibility == View.GONE ? View.GONE : View.VISIBLE);
    }
}
