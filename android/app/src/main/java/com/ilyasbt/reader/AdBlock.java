package com.ilyasbt.reader;

import android.net.Uri;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Drops requests to known ad and tracking servers, from Reader's page and from the players embedded in it
 * (YouTube, X). The WebView asks MainActivity about every request, including ones made inside those players'
 * frames, which a website can't see or block on its own.
 *
 * YouTube mixes some ads into the video stream itself, so a few can still get through.
 */
final class AdBlock {

    private AdBlock() {}

    // Blocked together with all their subdomains
    private static final List<String> HOSTS = Arrays.asList(
            "doubleclick.net",
            "googlesyndication.com",
            "googleadservices.com",
            "google-analytics.com",
            "googletagmanager.com",
            "googletagservices.com",
            "adservice.google.com",
            "imasdk.googleapis.com",
            "2mdn.net",
            "ads.youtube.com",
            "ads-twitter.com",
            "ads-api.twitter.com",
            "ads-api.x.com",
            "analytics.twitter.com",
            "app-measurement.com",
            "scorecardresearch.com",
            "amazon-adsystem.com",
            "adnxs.com",
            "criteo.com",
            "criteo.net",
            "taboola.com",
            "outbrain.com",
            "moatads.com",
            "quantserve.com",
            "connect.facebook.net",
            "static.cloudflareinsights.com"
    );

    // Ad and tracking paths on hosts that also serve what Reader needs
    private static final Map<String, List<String>> PATHS = new HashMap<>();
    static {
        List<String> youtube = Arrays.asList("/pagead/", "/api/stats/ads", "/api/stats/atr", "/get_midroll_", "/ptracking", "/pcs/activeview");
        PATHS.put("youtube.com", youtube);
        PATHS.put("youtube-nocookie.com", youtube);
        PATHS.put("syndication.x.com", Arrays.asList("/i/jot"));
        PATHS.put("syndication.twitter.com", Arrays.asList("/i/jot"));
    }

    private static boolean matches(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    static boolean blocked(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        for (String h : HOSTS) if (matches(host, h)) return true;
        String path = url.getPath();
        if (path == null) return false;
        for (Map.Entry<String, List<String>> e : PATHS.entrySet()) {
            if (!matches(host, e.getKey())) continue;
            for (String prefix : e.getValue()) if (path.startsWith(prefix)) return true;
        }
        return false;
    }
}
