package com.ilyasbt.reader

import android.net.Uri

/**
 * Drops requests to known ad and tracking servers, from Reader's page and from the players embedded in it
 * (YouTube, X). The WebView asks [MainActivity] about every request, including ones made inside those players'
 * frames, which a website can't see or block on its own.
 *
 * YouTube mixes some ads into the video stream itself, so a few can still get through.
 */
object AdBlock {

    // Blocked together with all their subdomains
    private val hosts = setOf(
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
    )

    // Ad and tracking paths on hosts that also serve what Reader needs
    private val paths = mapOf(
        "youtube.com" to listOf("/pagead/", "/api/stats/ads", "/api/stats/atr", "/get_midroll_", "/ptracking", "/pcs/activeview"),
        "youtube-nocookie.com" to listOf("/pagead/", "/api/stats/ads", "/api/stats/atr", "/get_midroll_", "/ptracking", "/pcs/activeview"),
        "syndication.x.com" to listOf("/i/jot"),
        "syndication.twitter.com" to listOf("/i/jot")
    )

    fun blocked(url: Uri): Boolean {
        val host = url.host?.lowercase() ?: return false
        if (hosts.any { host == it || host.endsWith(".$it") }) return true
        val path = url.path ?: return false
        for ((h, prefixes) in paths) {
            if ((host == h || host.endsWith(".$h")) && prefixes.any { path.startsWith(it) }) return true
        }
        return false
    }
}
