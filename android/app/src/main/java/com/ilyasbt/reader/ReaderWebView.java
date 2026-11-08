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
        // Only ever pass on "visible". Leaving the app or turning the screen off reports GONE or INVISIBLE;
        // passing either on would make the page hidden, and players pause on a hidden page.
        if (visibility == View.VISIBLE) super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
