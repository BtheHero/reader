# Reader

A simple, private RSS / Atom / JSON Feed reader with a social-style timeline, hosted on Cloudflare Pages.
It has no build step: plain HTML, CSS and JavaScript, plus one Pages Function (`functions/fetch.js`).

## Deploying

Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → this repository.
Production branch `main`, framework preset **None**, build command and output directory **empty**.
Every push to `main` deploys. The feed fetcher is served at `/fetch` next to the app.

## Layout

A social-style timeline: posts as cards (picture, name, time, text, big image or video, and star / share / open
actions), a row of the feeds you follow at the top (ringed when they have unread posts), and a profile page per feed.
Tapping a post opens it over the timeline; back returns to the same place. Videos and podcast episodes play right in
the timeline. On phones there's a bottom tab bar (Home, Videos, follow +, Starred, Following).

### Reading flow

- **Read on scroll:** a post you've seen and scrolled past counts as read (switch: "Read on scroll" at the bottom of
  the sidebar). Opening a post also marks it read.
- **Read posts leave at the next refresh:** read posts stay where they are while you scroll, and disappear when you
  refresh or reopen Reader, so the timeline only holds what's new. The ◎ button in the top bar (or "Show read posts"
  when you're caught up) shows them again; Starred always shows everything you starred.
- **Pull to refresh:** pull down at the top of the timeline (touch), or keep scrolling up at the top (mouse /
  trackpad). The refresh button does the same.
- A background refresh (opening the app after 30 minutes) doesn't move the timeline while you're scrolled down; it
  shows a "↑ N new posts" pill instead.

### Links, filters and groups

- Links in posts are clickable in the timeline (the post's own links and bare web addresses; for X accounts also
  @mentions and #hashtags). X reposts are labelled "↻ @account reposted".
- **Filters** (per feed, in its Edit dialog): hide posts containing words, only show posts containing words, only
  posts with pictures or video, and for X accounts hide reposts / replies. Hidden posts don't count as unread; the
  feed's profile shows how many are hidden.
- **Groups**: give a feed a group in the Follow or Edit dialog. Groups appear in the sidebar (fold open/closed, unread
  count, ⋯ to rename or remove) and each has its own timeline. OPML export / import keeps groups as folders.

## Accounts and sync (optional)

Signed out, Reader keeps everything on the device, as always. With a Firebase project set in `js/config.js`,
an account button appears: sign in with email and password and your feeds, groups, filters, settings, starred
posts and read posts stay the same on every device (live, through Cloud Firestore). Signing in on a device that
already has feeds merges them into the account (same address = same feed). Sign out keeps the device's copy;
"Delete account" removes the account and its synced data.

Firestore layout: `users/{uid}` holds `feedMap` and `settings` (each feed and setting is its own field, so
changes from two devices at once don't undo each other), `users/{uid}/stars/*` the starred posts, and
`users/{uid}/reads/{feedId}` each feed's read marks (newest change wins). Security rules (Firestore → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

The Firebase SDK (11.10.0) loads from www.gstatic.com only once someone signs in.

## How it works

- **Subscriptions, articles, read/starred state and settings** are stored in the browser (IndexedDB).
  There is no account and no database. Use **Export OPML** / **Import OPML** to move feeds between devices.
- **Feeds are fetched by `functions/fetch.js`**, because browsers can't read most feeds directly (CORS).
  - It only runs when the reader asks: when you press refresh, or when you open the app and feeds are more than 30 minutes old. No timers, nothing runs in the background.
  - A whole refresh is **one** request (up to 45 feeds per call), so it barely touches the free plan's
    100,000 Functions requests a day.
  - It uses no KV or other storage on Cloudflare.
  - It only answers the reader's own pages (Origin check), so other sites can't use it as a proxy.
  - Cloudflare keeps each feed for 10 minutes so repeated refreshes don't hammer the feed's site.
- **Article HTML is cleaned** (`js/parse.js` → `sanitize`) before display, and the page's Content-Security-Policy
  blocks any script that isn't the app's own.
- **Works as an installable app (PWA)**: `manifest.webmanifest` + `sw.js` (keeps the app's files for offline use).
  When you change any app file, bump `VERSION` in `sw.js`.

## Videos and podcasts

- **YouTube:** paste a channel (`youtube.com/@name`, `/channel/UC…`), a playlist link, or even one of the channel's
  video links into Add feed. Reader subscribes to the channel's official RSS feed (YouTube only lists the latest 15 videos there).
- **YouTube refuses its feeds to Cloudflare's servers** (`feeds/videos.xml` answers 404 to the fetcher, though
  channel pages still load). Add a free **YouTube Data API key** (bottom of the menu): Reader then reads channels
  and playlists from this browser through the official API (`playlistItems` + `channels`, 2 quota units per
  channel refresh out of 10,000 a day) and builds the same Atom feed from it. Create the key at
  console.cloud.google.com → enable "YouTube Data API v3" → Credentials → Create API key, and restrict it to
  this site's address (HTTP referrers) and to the YouTube Data API.
- Videos play in YouTube's privacy-enhanced embed (`youtube-nocookie.com`). Reader talks to the player with
  `postMessage` (no YouTube script is loaded into the page) to remember where you stopped, resume there, mark videos
  watched, and make timestamps in descriptions (`1:30`) jump the video.
- If YouTube's privacy-enhanced player refuses a video, Reader retries in YouTube's standard player.
- Videos whose uploader allows playback only on YouTube get a "Plays only on YouTube" card (badged in the timeline)
  with a Watch on YouTube button, unless you set **YouTube fallback** (bottom of the sidebar) to your own
  [Invidious](https://invidious.io) server: Reader then plays them from its `/api/v1/videos/<id>?local=true`
  streams. Public Invidious / Piped servers refuse Cloudflare or are down, so it has to be your own (personal use;
  this goes against YouTube's terms, so leave it off in any Play Store version).
- **Videos** view lists every video; **Shorts: Hidden** (bottom of the sidebar) hides YouTube Shorts everywhere.
- **Wide view** (`w`, or the corners button) gives the article or video the whole window.
- Video and audio files attached to ordinary feeds (podcasts, video blogs) play in the built-in player, with the same
  resume and timestamp features.

## Reddit

- Paste any Reddit address (a subreddit, a sorted listing like `/top/?t=week`, a user, a post) or just `r/name` /
  `u/name`; Reader follows its feed at `www.reddit.com/…/.rss` (Reddit's pages don't link to it, and
  `old.reddit.com` refuses Cloudflare).
- Posts are tidied: the "submitted by … [link] [comments]" table is removed, image posts get their full-size picture,
  link posts show the site they link to, and YouTube links play inline. Opening a post's original goes to its comments.
- Reddit sometimes rate-limits; a failed refresh just tries again next time.

## Podcasts

- Follow a YouTube channel with **Podcast** ticked (offered in the Follow dialog for YouTube addresses, and set or
  changed later in the channel's Edit dialog, with its minimum length; 60 minutes by default). Its videos over that
  length are episodes in the **Podcasts** tab; its other videos stay out of Home and Videos.
- Lengths come from the YouTube Data API (`videos.list`, 1 quota unit per 50 videos), so Podcasts needs the
  **YouTube API key** setting. Live streams and premieres are skipped.
- Episodes play in the **player bar**, which keeps playing while you browse: play/pause, back 15 s, forward 30 s,
  speed 1–2×, seek bar, resume where you stopped, "Played" when finished. Timestamps in show notes jump the bar.
- **Audio only** needs your own Invidious server (**YouTube fallback** setting): the bar then plays its audio-only
  stream (`adaptiveFormats`, AAC first), which keeps going with the screen off and has lock-screen / headphone
  controls. Without it, YouTube's player plays the episode in a small window in the bar (YouTube may pause it when
  the screen locks).

## X (Twitter)

- X has no RSS, so Reader reads accounts through **Nitter** servers (alternative X front ends that serve any public
  account as RSS). Paste any `x.com` / `twitter.com` profile or post link; Reader subscribes to that account.
- Servers come from the live list at [d420.net](https://d420.net/) (`/api/v1/instances`, readable straight from the
  browser), best uptime and speed first, checked at most once an hour. Only the servers whose operators allow
  automated use are used (`NITTER_ALLOWED` in `js/app.js`, also the fallback when d420.net is unreachable).
- If an account's server stops working, the next refresh moves it to another one. Posts are stored by their X post id
  and link to x.com, so switching servers never duplicates them.
- **Videos and GIFs:** Nitter's feed has no video file, only a thumbnail labelled "Video". When you press play,
  Reader loads the post's Nitter page (one Function request, three servers tried) and plays the `.mp4` it links on
  X's video server in Reader's own player: just the video, resumable, GIFs looping silently. The address is saved,
  so playing again costs nothing. If no server has it, X's official embedded post is used instead. Links inside
  posts point at t.co / x.com rather than the Nitter server.
- Nitter servers come and go; if X accounts stop loading, check d420.net and update `NITTER_ALLOWED`.

Keyboard: `w` wide view, `j`/`k` next/previous, `s` star, `m` read/unread, `o` open original, `r` refresh, `a` add feed, `/` search.

## Local testing

The `/fetch` function only exists on Cloudflare. To run everything locally, use Wrangler from the repo root:

```bash
npx wrangler pages dev .
```

Then open http://localhost:8788/

## Publishing to the Play Store (later)

The usual route for a PWA is a **Trusted Web Activity**: a small Android wrapper that opens the site full-screen.
Same code, and updates to the site reach the app without a new Play Store release.

1. Optionally give Reader its own domain (e.g. `reader.example.com`) instead of the `pages.dev` address, before
   publishing: the app is tied to the address it's installed from.
   Then change `start_url`/`scope`/`id` in the manifest and `API_URL` in `js/app.js` if the paths change.
2. Generate the Android project with [PWABuilder](https://www.pwabuilder.com/) or `npx @bubblewrap/cli init --manifest https://<domain>/manifest.webmanifest`.
3. Publish the generated `/.well-known/assetlinks.json` on the domain (proves you own the site, hides the browser bar).
4. Upload the signed `.aab` in the Play Console (one-time $25 developer fee; needs a privacy policy URL —
   "everything stays on your device" makes that short).

## Android app (android/)

A small native app (Java) that shows the live site in a full-screen WebView, so site updates reach it without
a new build, and adds what a website can't do:

- **Ad blocking**: every request from the page and from the embedded YouTube / X players is checked against a list
  of ad and tracking servers (`AdBlock.kt`) and dropped. YouTube mixes some ads into the video stream itself, so a
  few can still get through. (Google Play forbids blocking other services' ads: this build is for installing
  yourself.)
- Links to other sites open in their app (YouTube, X…) or the browser; Back closes what's open in Reader.
- OPML import (file picker) and export (saved to Downloads), fullscreen video.
- Podcasts keep playing with the screen off: while something plays, a notification keeps the app running.

Built by GitHub Actions (`.github/workflows/android.yml`) on every change under `android/`, and published at
**https://github.com/ilyasbt/reader/releases/tag/app-latest** → `Reader.apk`. Signing uses the repository secrets
`ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`, so each build installs over the previous one.
