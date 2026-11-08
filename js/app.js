// BT Feeder: the app. State lives in memory and is saved to IndexedDB (store.js) as it changes.

(() => {
  // Where feeds are fetched from: "fetch" next to this page (reader/functions/fetch.js), so the same files
  // work at the root of BT Feeder's own site and at /reader/ on another one. A packaged app served from
  // another origin would set the full https:// address here.
  const API_URL = new URL("fetch", document.baseURI).href;
  const BATCH = 45;                 // feeds per call; matches MAX_URLS in the function
  const STALE_MIN = 30;             // opening the reader refreshes feeds older than this
  const KEEP_PER_FEED = 300;        // older articles beyond this are dropped (starred ones are kept)
  const PAGE = 60;                  // articles rendered at a time in the list
  // X / Twitter accounts are read through Nitter servers. d420.net keeps a live list of them (it allows
  // browsers to read it directly). Only servers whose operators allow automated use are used, best first;
  // this list is also the fallback when d420.net can't be reached.
  const NITTER_STATUS = "https://d420.net/api/v1/instances";
  const NITTER_ALLOWED = ["xitter.cf", "nitter.gq", "xitter.gq", "teapawt.net", "teapaw.org", "teapawt.org", "nitter.cf"];

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const S = {
    feeds: [],               // [{ id, url, title, siteUrl, added, lastFetch, error }]
    items: new Map(),        // key -> { key, feedId, id, title, link, date, author, html, image, video, read, star, seen, pos, dur, watched }
    settings: { theme: "system", unreadOnly: true, hideShorts: false, markOnScroll: true },
    keep: new Set(),         // posts read since the last refresh / launch: they stay in view until then
    view: "all",             // "all" | "videos" | "starred" | "feed:<id>"
    query: "",
    current: null,           // key of the open article
    shown: [],               // keys in the list, in order
    rendered: 0,
    refreshing: false
  };

  const narrow = () => matchMedia("(max-width: 759px)").matches;
  const medium = () => matchMedia("(max-width: 1099px)").matches;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const feedById = (id) => S.feeds.find(f => f.id === id);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

  // ---------- Saving ----------

  // Saved on this device, and mirrored to the account when signed in (account.js)
  const saveFeeds = () => { Account.changed("feeds"); return Store.set("feeds", S.feeds); };
  const saveSettings = () => { Account.changed("settings"); return Store.set("settings", S.settings); };
  const saveItems = (list) => Store.putItems(list.filter(it => !it.virtual).map(it => ({ ...it })));

  // ---------- Fetching ----------

  // YouTube refuses its feeds to Cloudflare's servers. With a YouTube Data API key (Settings), BT Feeder reads
  // channels and playlists through the official API from this browser instead, and turns the answer into
  // the same Atom feed YouTube would have sent, so everything else works unchanged.
  const YT_FEED = /^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?(channel_id|playlist_id)=([\w-]+)/;

  async function fetchBatch(urls) {
    if (S.settings.ytKey && urls.some(u => YT_FEED.test(u))) {
      const yt = urls.filter(u => YT_FEED.test(u)), rest = urls.filter(u => !YT_FEED.test(u));
      const [a, b] = await Promise.all([Promise.all(yt.map(youtubeApiFeed)), rest.length ? fetchBatch(rest) : []]);
      const got = new Map([...a, ...b].map(r => [r.url, r]));
      return urls.map(u => got.get(u));
    }
    const out = [];
    for (let i = 0; i < urls.length; i += BATCH) {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urls.slice(i, i + BATCH) })
      });
      if (!res.ok) throw new Error(res.status === 404 ? "The feed fetcher isn't available here (it runs on Cloudflare Pages)." : "The feed fetcher answered " + res.status);
      out.push(...(await res.json()).results);
    }
    return out;
  }

  async function youtubeApiFeed(url) {
    const [, kind, id] = YT_FEED.exec(url);
    const playlist = kind === "channel_id" ? "UU" + id.slice(2) : id;
    const api = (path, params) => fetch("https://www.googleapis.com/youtube/v3/" + path + "?" + new URLSearchParams(params), { headers: { "X-Goog-Api-Key": S.settings.ytKey } })
      .then(r => r.json());
    try {
      const [list, about] = await Promise.all([
        api("playlistItems", { part: "snippet,contentDetails", playlistId: playlist, maxResults: "25" }),
        kind === "channel_id" ? api("channels", { part: "snippet", id }) : api("playlists", { part: "snippet", id })
      ]);
      const err = list.error || about.error;
      if (err) return { url, ok: false, status: err.code, error: "YouTube API: " + (err.message || err.status || "error").replace(/<[^>]*>/g, "") };
      const info = (about.items && about.items[0] && about.items[0].snippet) || {};
      const x = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const thumb = (t) => t && (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || "";
      const home = kind === "channel_id" ? "https://www.youtube.com/channel/" + id : "https://www.youtube.com/playlist?list=" + id;
      const entries = (list.items || []).filter(i => i.snippet && !/^(Private|Deleted) video$/.test(i.snippet.title)).map(i => {
        const s = i.snippet, vid = (i.contentDetails && i.contentDetails.videoId) || (s.resourceId && s.resourceId.videoId);
        return "<entry><id>yt:video:" + x(vid) + "</id><yt:videoId>" + x(vid) + "</yt:videoId><title>" + x(s.title) + "</title>" +
          '<link rel="alternate" href="https://www.youtube.com/watch?v=' + x(vid) + '"/><author><name>' + x(s.videoOwnerChannelTitle || info.title) + "</name></author>" +
          "<published>" + x((i.contentDetails && i.contentDetails.videoPublishedAt) || s.publishedAt) + "</published>" +
          '<media:group><media:thumbnail url="' + x(thumb(s.thumbnails)) + '"/><media:description>' + x(s.description) + "</media:description></media:group></entry>";
      });
      const body = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">' +
        "<title>" + x(info.title || "YouTube") + '</title><link rel="alternate" href="' + home + '"/><icon>' + x(thumb(info.thumbnails)) + "</icon>" + entries.join("") + "</feed>";
      return { url, ok: true, status: 200, finalUrl: url, type: "application/atom+xml", body };
    } catch (e) {
      return { url, ok: false, error: "Couldn't reach the YouTube API" };
    }
  }

  const YT_HELP = "YouTube isn't giving its feeds to BT Feeder's server. Add a free YouTube API key (“YouTube API key” at the bottom of the menu) and try again.";

  function applyYtKey() { $("ytkey-btn").textContent = "YouTube API key: " + (S.settings.ytKey ? "On" : "Off"); }
  $("ytkey-btn").onclick = async () => {
    const r = await ask({ title: "YouTube API key",
      text: "Used to read YouTube channels and video lengths (YouTube refuses its feeds to BT Feeder's server).\nGet one free at console.cloud.google.com: enable “YouTube Data API v3”, then Credentials → Create API key.",
      input: S.settings.ytKey || "", placeholder: "AIza…", ok: "Save", extra: S.settings.ytKey ? "Remove key" : "" });
    if (r.action === "cancel") return;
    const v = r.action === "extra" ? "" : r.value;
    if (v === (S.settings.ytKey || "")) return;
    S.settings.ytKey = v;
    saveSettings();
    applyYtKey();
    toast(S.settings.ytKey ? "YouTube API key saved. Refreshing YouTube channels…" : "YouTube API key removed");
    const yt = S.feeds.filter(f => YT_FEED.test(f.url));
    if (S.settings.ytKey && yt.length) refresh(yt);
  };

  // Merge freshly parsed articles into a feed. Returns how many are new.
  function merge(feed, parsed) {
    const now = Date.now(), changed = [];
    let added = 0;
    parsed.items.forEach((p, i) => {
      if (!p.id && !p.link) return;
      const key = feed.id + "|" + (p.id || p.link);
      const old = S.items.get(key);
      // No date in the feed: keep the first time we saw it, ordered as the feed lists them
      const date = p.date || (old && old.date) || now - i * 1000;
      // Keep an X video's file address found earlier (the feed doesn't carry it)
      if (old && old.video && p.video && old.video.id === p.video.id && old.video.src) p.video = { ...p.video, src: old.video.src, gif: old.video.gif };
      if (old && old.video && p.video && old.video.id === p.video.id && old.video.ytOnly) p.video = { ...p.video, ytOnly: true };
      const it = { key, feedId: feed.id, id: p.id, title: p.title, link: p.link, date, author: p.author, html: p.html, image: p.image, video: p.video || null,
        read: old ? old.read : false, readAt: old ? old.readAt || 0 : 0, star: old ? old.star : false, seen: old ? old.seen : now,
        pos: old ? old.pos || 0 : 0, dur: old ? old.dur || 0 : 0, watched: old ? !!old.watched : false, quote: p.quote || null };
      if (old && old.ytDur != null) { it.ytDur = old.ytDur; it.ytLive = old.ytLive; }
      if (!old) { added++; if (S.newKeys) S.newKeys.add(key); }
      if (!old || old.title !== it.title || old.html !== it.html || old.date !== it.date || old.image !== it.image || JSON.stringify(old.video || null) !== JSON.stringify(it.video) || JSON.stringify(old.quote || null) !== JSON.stringify(it.quote)) {
        S.items.set(key, it); changed.push(it);
      }
    });
    saveItems(changed);
    prune(feed.id);
    // Posts read on another device show as read here too
    if (added) Account.itemsAdded(feed.id);
    return added;
  }

  function prune(feedId) {
    const list = [...S.items.values()].filter(i => i.feedId === feedId).sort((a, b) => b.date - a.date);
    const drop = list.slice(KEEP_PER_FEED).filter(i => !i.star).map(i => i.key);
    drop.forEach(k => S.items.delete(k));
    Store.deleteItems(drop);
  }

  async function refresh(feeds, { quiet } = {}) {
    if (S.refreshing || !feeds.length) return;
    S.refreshing = true;
    S.newKeys = new Set();
    if (!quiet) status("Refreshing " + feeds.length + (feeds.length === 1 ? " feed…" : " feeds…"));
    let added = 0, failed = 0;
    try {
      const results = await fetchBatch(feeds.map(f => f.url));
      results.forEach((r, i) => {
        const f = feeds[i];
        f.lastFetch = Date.now();
        const parsed = r.ok ? Parse.parseFeed(r.body, r.finalUrl || f.url) : null;
        if (!parsed) { f.error = r.ok ? "This address no longer returns a feed" : YT_FEED.test(f.url) && !S.settings.ytKey ? YT_HELP : r.error; failed++; return; }
        added += apply(f, parsed);
      });
      // X accounts whose Nitter server failed: move them to another working server
      const xFailed = feeds.filter(f => f.x && f.error);
      if (xFailed.length) {
        const hosts = await nitterHosts();
        const tries = [];
        for (const f of xFailed) {
          const current = host(f.url);
          for (const h of hosts.filter(h => h !== current).slice(0, 3)) tries.push({ f, url: "https://" + h + "/" + f.x + "/rss" });
        }
        const res = await fetchBatch(tries.map(t => t.url));
        res.forEach((r, i) => {
          const { f, url } = tries[i];
          if (!f.error) return;   // an earlier server already worked
          const parsed = r.ok && Parse.parseFeed(r.body, url);
          if (!parsed) return;
          f.url = url;
          added += apply(f, parsed);
          failed--;
        });
      }
      saveFeeds();
      status("");
      // Only posts that will actually show here count as new: not ones hidden by filters, blocks, hidden
      // Shorts, other views, or feeds kept to their group
      if (added) { const shown = new Set(viewItems().map(i => i.key)); added = [...S.newKeys].filter(k => shown.has(k)).length; }
      const failNote = failed ? " · " + failed + " feed" + (failed === 1 ? "" : "s") + " failed" : "";
      if (S.view === "podcasts" && !quiet) {
        // Count new episodes only (videos over the channel's minimum length), once their lengths are known
        await podDurations();
        const pods = podFeeds();
        const n = [...S.newKeys].map(k => S.items.get(k)).filter(i => i && pods.has(i.feedId) && isEpisode(i, pods.get(i.feedId))).length;
        toast(n ? n + " new podcast" + (n === 1 ? "" : "s") : "No new podcasts" + failNote);
      } else if (!quiet || added) toast(added ? added + " new post" + (added === 1 ? "" : "s") : "No new posts" + failNote);
    } catch (e) {
      status(navigator.onLine === false ? "You're offline. Showing saved articles." : e.message, true);
    } finally {
      S.refreshing = false;
      endPull();
      podDurations();
      renderFeeds();
      if (!quiet) { S.keep.clear(); hideNewPill(); renderList(); }
      else if ($("timeline").scrollTop > 80 && !document.body.classList.contains("reading")) { if (added) showNewPill(added); }
      else renderList(true);
    }
  }

  // "N new posts" after a background refresh while you're scrolled down: tap to go to the top and see them
  let pending = 0;
  function showNewPill(n) {
    pending += n;
    $("newpill").textContent = "↑ " + pending + " new post" + (pending === 1 ? "" : "s");
    $("newpill").hidden = false;
  }
  function hideNewPill() { pending = 0; $("newpill").hidden = true; }
  $("newpill").onclick = () => { hideNewPill(); S.keep.clear(); renderList(); $("timeline").scrollTop = 0; };

  // Site-specific clean-up of a freshly parsed feed
  function tidy(parsed, url) {
    if (parsed && Parse.isReddit(url)) Parse.redditify(parsed);
    return parsed;
  }

  function apply(f, parsed) {
    if (f.x) Parse.xify(parsed, f.x);
    tidy(parsed, f.url);
    f.error = "";
    if (!f.customTitle && parsed.title) f.title = parsed.title;
    if (parsed.siteUrl) f.siteUrl = parsed.siteUrl;
    if (parsed.icon) f.icon = parsed.icon;
    return merge(f, parsed);
  }

  // Working Nitter servers, best first (checked at most once an hour)
  let nitterCache = null;
  // Healthy ones come first; the others follow, since the status page can lag behind a server coming back.
  async function nitterHosts() {
    if (nitterCache && Date.now() - nitterCache.at < 3600000) return nitterCache.hosts;
    let live = [], known = [];
    try {
      const d = await (await fetch(NITTER_STATUS)).json();
      known = d.hosts.map(h => h.domain);
      live = d.hosts.filter(h => h.healthy && h.rss && !h.is_bad_host && !h.unreliable && NITTER_ALLOWED.includes(h.domain))
        .sort((a, b) => (b.community_funded - a.community_funded) || (b.healthy_percentage_overall - a.healthy_percentage_overall) || (a.ping_avg - b.ping_avg))
        .map(h => h.domain);
    } catch (e) { /* use the built-in list */ }
    const hosts = [...new Set([...live, ...NITTER_ALLOWED])];
    // Retry the status page sooner when it couldn't be read
    nitterCache = { at: live.length ? Date.now() : Date.now() - 3300000, hosts, known: [...new Set([...known, ...NITTER_ALLOWED])] };
    return hosts;
  }

  // A link to an account on a Nitter server (xitter.gq/xbox): treat it as that X account, so it can move servers
  async function nitterUser(url) {
    let u;
    try { u = new URL(url); } catch (e) { return ""; }
    if (!NITTER_ALLOWED.includes(u.hostname)) {
      await nitterHosts();
      if (!nitterCache.known.includes(u.hostname)) return "";
    }
    return Parse.xUser("https://x.com" + u.pathname);
  }

  const refreshStale = () => refresh(S.feeds.filter(f => !f.lastFetch || Date.now() - f.lastFetch > STALE_MIN * 60000), { quiet: true });

  // Turn whatever the person typed into working feeds: the address itself, the feeds the page links to,
  // or feeds at the usual places (/feed, /rss, /atom.xml…). At most two calls to the fetcher.
  // Results are remembered, so typing, then pressing Add, doesn't look the same address up twice.
  const lookups = new Map();

  function normalize(input) {
    let url = input.trim();
    if (!url) return "";
    const reddit = Parse.redditFeed(url);
    if (reddit) return reddit;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url.replace(/^\/+/, "");
    try { url = new URL(url).href; } catch (e) { return ""; }
    return Parse.youtubeFeed(url) || url;
  }

  // Worth looking up while typing: something.tld with no spaces
  const looksLikeAddress = (input) => /^\/?(r|u|user)\/[\w-]{2,}\/?$/i.test(input.trim()) || /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(input.trim()) || /^https?:\/\/\S+$/i.test(input.trim());

  function findFeeds(input) {
    const url = normalize(input);
    if (!url) return Promise.reject(new Error("That doesn't look like a web address."));
    if (!lookups.has(url)) {
      const p = lookup(url);
      lookups.set(url, p);
      p.catch(() => lookups.delete(url));   // let a failed lookup (offline…) be retried
    }
    return lookups.get(url);
  }

  async function lookup(url) {
    const user = Parse.xUser(url) || await nitterUser(url);
    if (user) return lookupX(user);
    const [r] = await fetchBatch([url]);
    const base = (r && r.finalUrl) || url;
    const direct = r && r.ok && tidy(Parse.parseFeed(r.body, base), url);
    if (direct) return [{ url, parsed: direct }];

    // The page's own feed links first; otherwise (or if the page wouldn't load) the usual places
    let candidates = r && r.ok ? Parse.discover(r.body, base) : [];
    if (!candidates.length) candidates = Parse.guesses(base);
    candidates = candidates.slice(0, 16);
    const results = await fetchBatch(candidates);
    const found = [], same = new Set();
    results.forEach((c, i) => {
      const parsed = c.ok && tidy(Parse.parseFeed(c.body, c.finalUrl || candidates[i]), candidates[i]);
      if (!parsed) return;
      // /feed and /rss are often the same feed: keep the first
      const sig = parsed.title + "|" + (parsed.items[0] ? parsed.items[0].id : "");
      if (same.has(sig)) return;
      same.add(sig);
      found.push({ url: candidates[i], parsed });
    });
    if (!found.length) {
      if (r && !r.ok && !results.some(c => c.ok)) throw new Error("Couldn't load that address" + (r.error ? " (" + r.error.replace(/^The site/, "the site") + ")" : "") + ". Check it's typed correctly.");
      if (/youtu\.?be/.test(url) && candidates.some(c => YT_FEED.test(c)) && !S.settings.ytKey) throw new Error(YT_HELP);
      throw new Error(/youtu\.?be/.test(url) ? "Couldn't find that YouTube channel. Try the channel's page address (youtube.com/@name)." : "Couldn't find a feed at that address.");
    }
    return found;
  }

  // An X account: ask the best few Nitter servers at once and keep the first that answers with a feed
  // If they all fail (they sometimes go down together), try the rest before giving up.
  async function lookupX(user) {
    const hosts = await nitterHosts();
    for (const group of [hosts.slice(0, 4), hosts.slice(4)]) {
      if (!group.length) continue;
      const urls = group.map(h => "https://" + h + "/" + user + "/rss");
      const results = await fetchBatch(urls);
      for (let i = 0; i < results.length; i++) {
        const parsed = results[i].ok && Parse.parseFeed(results[i].body, urls[i]);
        if (parsed) return [{ url: urls[i], parsed: Parse.xify(parsed, user), x: user }];
      }
    }
    throw new Error("Couldn't load @" + user + " right now. The account may not exist or be private, or the Nitter servers are busy. Try again in a few minutes.");
  }

  // The subscription this feed already is, even when reached through another address (/feed vs /rss)
  function subscribedTo(url, parsed) {
    const first = parsed.items[0];
    const xu = Parse.xUser(parsed.siteUrl || "");
    return S.feeds.find(f => f.url === url || (xu && f.x && f.x.toLowerCase() === xu.toLowerCase()) ||
      (first && f.title === (parsed.title || f.title) && S.items.has(f.id + "|" + (first.id || first.link))));
  }

  async function addFeed(url, parsed, x) {
    const existing = subscribedTo(url, parsed);
    if (existing) { selectView("feed:" + existing.id); throw new Error("You're already subscribed to " + existing.title + "."); }
    const feed = { id: uid(), url, title: parsed.title || host(parsed.siteUrl || url), siteUrl: parsed.siteUrl, added: Date.now(), lastFetch: Date.now(), error: "" };
    if (x) feed.x = x;
    if ($("add-podcast").checked && (YT_FEED.test(url) || parsed.items.some(i => i.video && i.video.kind === "youtube"))) { feed.podcast = true; feed.podMin = 60; }
    const group = $("add-group").value.trim().replace(/\s+/g, " ");
    if (group) feed.group = group;
    if (parsed.icon) feed.icon = parsed.icon;
    S.feeds.push(feed);
    S.feeds.sort((a, b) => a.title.localeCompare(b.title));
    merge(feed, parsed);
    await saveFeeds();
    renderFeeds();
    if (feed.podcast) { selectView("podcasts"); podDurations(); }
    else selectView("feed:" + feed.id);
    toast("Subscribed to " + feed.title);
  }

  async function removeFeed(id) {
    const keys = [...S.items.values()].filter(i => i.feedId === id).map(i => i.key);
    keys.forEach(k => S.items.delete(k));
    S.feeds = S.feeds.filter(f => f.id !== id);
    await Promise.all([Store.deleteItems(keys), saveFeeds()]);
    if (S.view === "feed:" + id) selectView("all"); else { renderFeeds(); renderList(true); }
  }

  // ---------- Article state ----------

  function setRead(it, read) {
    if (!it || it.read === read) return;
    it.read = read;
    it.readAt = Date.now();
    if (read) S.keep.add(it.key);
    saveItems([it]);
    Account.itemChanged(it, "read");
    const row = document.querySelector('.post[data-key="' + CSS.escape(it.key) + '"]');
    if (row) {
      row.classList.toggle("unread", !read);
      const b = row.querySelector(".pact.read");
      if (b) { b.title = read ? "Mark unread" : "Mark read"; b.setAttribute("aria-label", b.title); }
    }
    renderCounts();
    if (S.current === it.key) syncReaderButtons(it);
  }

  function setStar(it, star) {
    if (!it) return;
    it.star = star;
    saveItems([it]);
    Account.itemChanged(it, "star");
    const row = document.querySelector('.post[data-key="' + CSS.escape(it.key) + '"]');
    if (row) {
      row.classList.toggle("starred", star);
      const b = row.querySelector(".pact.star");
      if (b) { b.setAttribute("aria-pressed", star); b.title = star ? "Unstar" : "Star"; }
    }
    renderCounts();
    if (S.current === it.key) syncReaderButtons(it);
  }

  // Everything in this view (not only what's been scrolled to) becomes read and leaves the timeline, the posts
  // already read included; in Podcasts, episodes become played. If read posts were being shown, they're hidden
  // again. Undo puts it all back.
  function markAllRead() {
    const pods = S.view === "podcasts";
    const shown = S.shown.map(k => S.items.get(k)).filter(Boolean);
    if (!shown.length) return toast(pods ? "No episodes to clear" : "Nothing to clear here");
    const before = shown.map(i => ({ read: i.read, watched: i.watched, kept: S.keep.has(i.key) }));
    const wasShowingRead = !S.settings.unreadOnly;
    const changed = [];
    shown.forEach(i => {
      if (pods && !i.watched) { i.watched = true; changed.push(i); }
      if (!i.read) { i.read = true; i.readAt = Date.now(); Account.itemChanged(i, "read"); if (!changed.includes(i)) changed.push(i); }
      S.keep.delete(i.key);
    });
    if (wasShowingRead) { S.settings.unreadOnly = true; saveSettings(); }
    saveItems(changed);
    renderFeeds();
    renderList(true);
    toast("Cleared " + shown.length + (pods ? " episode" : " post") + (shown.length === 1 ? "" : "s"), "Undo", () => {
      shown.forEach((i, n) => {
        i.watched = before[n].watched;
        if (i.read !== before[n].read) { i.read = before[n].read; i.readAt = Date.now(); Account.itemChanged(i, "read"); }
        if (before[n].kept || before[n].read) S.keep.add(i.key);
      });
      if (wasShowingRead) { S.settings.unreadOnly = false; saveSettings(); }
      saveItems(changed);
      renderFeeds();
      renderList(true);
    });
  }

  // ---------- Rendering ----------

  function counts() {
    const c = { all: 0, videos: 0, podcasts: 0, starred: 0, feeds: {}, groups: {}, hidden: {} };
    const hide = hider();
    const groupOf = new Map(S.feeds.map(f => [f.id, f.group || ""]));
    const pods = podFeeds();
    const homeHidden = groupOnlyFeeds();
    for (const it of S.items.values()) {
      if (hide(it)) { c.hidden[it.feedId] = (c.hidden[it.feedId] || 0) + 1; continue; }
      if (it.star) c.starred++;
      const pf = pods.get(it.feedId);
      if (pf) {
        if (isEpisode(it, pf) && !it.read && !it.watched) { c.podcasts++; c.feeds[it.feedId] = (c.feeds[it.feedId] || 0) + 1; }
        continue;
      }
      if (!it.read && isVideo(it)) c.videos++;
      if (!it.read) {
        if (!homeHidden.has(it.feedId)) c.all++;
        c.feeds[it.feedId] = (c.feeds[it.feedId] || 0) + 1;
        const g = groupOf.get(it.feedId);
        if (g) c.groups[g] = (c.groups[g] || 0) + 1;
      }
    }
    return c;
  }

  // ---------- Filters ----------

  // Lower-case text of a post, remembered per post object (a refreshed post is a new object)
  const textCache = new WeakMap();
  function lowerText(it) {
    let t = textCache.get(it);
    if (t == null) { t = (it.title + " " + Parse.plain(it.html) + " " + (it.author || "")).toLowerCase(); textCache.set(it, t); }
    return t;
  }
  const words = (s) => (s || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
  const isRepost = (it) => /^RT @\w+/.test(it.title);
  const isReply = (it) => /^R to @\w+/.test(it.title);

  // A function telling whether a post is hidden: Shorts (when hidden) or the post's feed filters
  function hider() {
    const rules = new Map();
    for (const f of S.feeds) {
      const r = f.filters;
      if (!r) continue;
      const mute = words(r.mute), only = words(r.only);
      if (mute.length || only.length || r.noReposts || r.noReplies || r.mediaOnly) rules.set(f.id, { ...r, mute, only });
    }
    const blocked = new Set((S.settings.xBlocked || []).map(h => h.toLowerCase()));
    const xFeeds = new Set(S.feeds.filter(f => f.x).map(f => f.id));
    return (it) => {
      if (hiddenShort(it)) return true;
      // Blocked X accounts: their reposts and the posts quoting them are hidden
      if (blocked.size && xFeeds.has(it.feedId) && ((isRepost(it) && blocked.has(repostOf(it).toLowerCase())) || (it.quote && blocked.has((it.quote.handle || "").toLowerCase())))) return true;
      const r = rules.get(it.feedId);
      if (!r) return false;
      if (r.noReposts && isRepost(it)) return true;
      if (r.noReplies && isReply(it)) return true;
      if (r.mediaOnly && !it.video && !it.image && !/<img\b/i.test(it.html || "")) return true;
      if (r.mute.length || r.only.length) {
        const t = lowerText(it);
        if (r.mute.some(w => t.includes(w))) return true;
        if (r.only.length && !r.only.some(w => t.includes(w))) return true;
      }
      return false;
    };
  }

  function renderCounts() {
    const c = counts();
    $("count-all").textContent = c.all || "";
    $("count-starred").textContent = c.starred || "";
    $("count-groups").textContent = tabGroups().reduce((n, g) => n + (c.groups[g] || 0), 0) || "";
    $("count-podcasts").textContent = c.podcasts || "";
    for (const li of document.querySelectorAll(".feed")) li.querySelector(".count").textContent = c.feeds[li.dataset.id] || "";
    for (const b of document.querySelectorAll('.ghead .nav')) b.querySelector(".count").textContent = c.groups[b.dataset.view.slice(6)] || "";
    for (const b of document.querySelectorAll(".story[data-view]")) b.classList.toggle("new", !!c.feeds[b.dataset.view.slice(5)]);
    document.title = c.all ? "(" + c.all + ") BT Feeder" : "BT Feeder";
  }

  // A feed's picture: its own logo / profile picture, else the site's icon, else a coloured initial.
  // YouTube and X feeds without a picture get the initial (the site icon would be the same for all of them).
  function avatar(feed, cls) {
    const h = host(feed.siteUrl || feed.url);
    const src = feed.icon || (/^(youtube\.com|x\.com|twitter\.com)$/.test(h) || !h ? "" : "https://icons.duckduckgo.com/ip3/" + h + ".ico");
    if (!src) return letterIcon(feed, cls);
    const img = el("img", "av " + (cls || ""));
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.onerror = () => { img.replaceWith(letterIcon(feed, cls)); };
    return img;
  }
  const favicon = (feed) => avatar(feed, "fav");

  function letterIcon(feed, cls) {
    const name = (feed.title || "?").replace(/^[^\p{L}\p{N}]+/u, "") || "?";
    const s = el("span", "av letter " + (cls || ""), name.charAt(0).toUpperCase());
    let hash = 0;
    for (const c of feed.title || "") hash = (hash * 31 + c.charCodeAt(0)) | 0;
    s.style.setProperty("--hue", Math.abs(hash) % 360);
    return s;
  }

  const groupNames = () => [...new Set(S.feeds.map(f => f.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const groupFeeds = (g) => S.feeds.filter(f => f.group === g);
  const FOLDER = '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg>';

  function feedLi(f) {
    const li = el("li", "feed");
    li.dataset.id = f.id;
    const b = el("button", "nav");
    b.dataset.view = "feed:" + f.id;
    b.append(favicon(f), el("span", "name", f.title));
    if (f.error) { const w = el("i", "warn", "!"); w.title = f.error; b.append(w); }
    if (hasFilters(f)) { const fl = el("i", "flt"); fl.title = "Filtered"; fl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 6h16l-6 7v5l-4 2v-7z"/></svg>'; b.append(fl); }
    b.append(el("b", "count"));
    const edit = el("button", "icon edit");
    edit.title = "Edit or filter " + f.title;
    edit.setAttribute("aria-label", edit.title);
    edit.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/></svg>';
    edit.onclick = (e) => { e.stopPropagation(); openFeedDialog(f); };
    li.append(b, edit);
    return li;
  }

  function renderFeeds() {
    const ul = $("feeds");
    ul.textContent = "";
    if (!S.feeds.length) ul.append(el("li", "hint", "You don’t follow anything yet."));
    const collapsed = S.settings.collapsed || {};
    for (const g of groupNames()) {
      const li = el("li", "group" + (collapsed[g] ? " closed" : ""));
      const head = el("div", "ghead");
      const b = el("button", "nav");
      b.dataset.view = "group:" + g;
      b.innerHTML = FOLDER;
      b.append(el("span", "name", g), el("b", "count"));
      const tog = el("button", "icon gtoggle");
      tog.innerHTML = CHEVRON;
      tog.setAttribute("aria-expanded", !collapsed[g]);
      tog.setAttribute("aria-label", (collapsed[g] ? "Show " : "Hide ") + g + " feeds");
      tog.onclick = (e) => {
        e.stopPropagation();
        const c = S.settings.collapsed = { ...(S.settings.collapsed || {}) };
        if (c[g]) delete c[g]; else c[g] = true;
        saveSettings();
        renderFeeds();
      };
      const menu = el("button", "icon edit");
      menu.title = "Rename or remove group " + g;
      menu.setAttribute("aria-label", menu.title);
      menu.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/></svg>';
      menu.onclick = (e) => { e.stopPropagation(); renameGroup(g); };
      head.append(tog, b, menu);
      const inner = el("ul", "gfeeds");
      for (const f of groupFeeds(g)) inner.append(feedLi(f));
      li.append(head, inner);
      ul.append(li);
    }
    for (const f of S.feeds.filter(f => !f.group)) ul.append(feedLi(f));
    // Group names offered in the Add and Edit dialogs
    const dl = $("group-names");
    dl.textContent = "";
    for (const g of groupNames()) { const o = el("option"); o.value = g; dl.append(o); }
    markActiveNav();
    renderCounts();
  }

  // The Groups tab: the groups you chose (all of them until you choose), and the one showing
  function tabGroups() {
    const all = groupNames();
    const chosen = S.settings.tabGroups;
    return Array.isArray(chosen) ? all.filter(g => chosen.includes(g)) : all;
  }
  function currentGroup() {
    const list = tabGroups();
    return list.includes(S.settings.groupSel) ? S.settings.groupSel : list[0] || "";
  }

  function openGroupsDialog() {
    const box = $("groups-choices");
    box.textContent = "";
    const shown = new Set(tabGroups());
    for (const g of groupNames()) {
      const l = el("label", "check");
      const c = el("input");
      c.type = "checkbox"; c.value = g; c.checked = shown.has(g);
      l.append(c, " " + g);
      box.append(l);
    }
    $("groups-dialog").showModal();
  }
  $("groups-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const picked = [...$("groups-choices").querySelectorAll("input:checked")].map(c => c.value);
    // All of them: keep following new groups automatically
    if (picked.length === groupNames().length) delete S.settings.tabGroups; else S.settings.tabGroups = picked;
    saveSettings();
    $("groups-dialog").close();
    renderCounts();
    renderList();
  });
  $("groups-cancel").onclick = () => $("groups-dialog").close();

  async function renameGroup(g) {
    const r = await ask({ title: "Rename group", input: g, placeholder: "Group name", ok: "Save", extra: "Remove group" });
    if (r.action === "cancel") return;
    let to = r.action === "ok" ? r.value.replace(/\s+/g, " ") : "";
    if (to === g) return;
    if (!to) {
      const sure = await ask({ title: "Remove the group “" + g + "”?", text: "Its feeds stay, just without a group.", ok: "Remove", danger: true });
      if (sure.action !== "ok") return;
    }
    // (Renaming onto an existing group's name merges the two)
    for (const f of groupFeeds(g)) f.group = to;
    if (Array.isArray(S.settings.tabGroups)) S.settings.tabGroups = S.settings.tabGroups.map(x => x === g ? to : x).filter(Boolean);
    if (S.settings.groupSel === g) S.settings.groupSel = to;
    saveSettings();
    if (S.settings.collapsed && S.settings.collapsed[g]) { delete S.settings.collapsed[g]; if (to) S.settings.collapsed[to] = true; saveSettings(); }
    saveFeeds();
    if (S.view === "group:" + g) S.view = to ? "group:" + to : "all";
    renderFeeds();
    renderList(true);
  }

  const hasFilters = (f) => !!f.filters && !!(f.filters.mute || f.filters.only || f.filters.noReposts || f.filters.noReplies || f.filters.mediaOnly);

  function markActiveNav() {
    for (const b of document.querySelectorAll(".side .nav, .tabs [data-view]")) b.classList.toggle("active", b.dataset.view === S.view);
  }

  function viewItems() {
    const hide = hider();
    let list = [...S.items.values()].filter(i => !hide(i));
    const pods = podFeeds();
    if (S.view === "podcasts") list = list.filter(i => pods.has(i.feedId) && isEpisode(i, pods.get(i.feedId)) && (!S.settings.unreadOnly || !i.watched || S.keep.has(i.key) || (Pod.item && Pod.item.key === i.key)));
    // Podcast channels' videos live in Podcasts (and on the channel's own page), not in the timelines
    else if (S.view !== "starred" && !S.view.startsWith("feed:")) list = list.filter(i => !pods.has(i.feedId));
    // Feeds set to "only in its group" stay off Home
    if (S.view === "all") { const only = groupOnlyFeeds(); list = list.filter(i => !only.has(i.feedId)); }
    if (S.view === "starred") list = list.filter(i => i.star);
    else if (S.view === "videos") list = list.filter(isVideo);
    else if (S.view.startsWith("feed:")) { const id = S.view.slice(5); list = list.filter(i => i.feedId === id); }
    else if (S.view.startsWith("group:") || S.view === "groups") { const ids = new Set(groupFeeds(S.view === "groups" ? currentGroup() : S.view.slice(6)).map(f => f.id)); list = list.filter(i => ids.has(i.feedId)); }
    // Read posts leave the timeline at the next refresh or launch (until then they stay where they are)
    if (S.settings.unreadOnly && S.view !== "starred" && S.view !== "podcasts") list = list.filter(i => !i.read || S.keep.has(i.key) || i.key === S.current);
    if (S.query) {
      const q = S.query.toLowerCase();
      list = list.filter(i => i.title.toLowerCase().includes(q) || Parse.plain(i.html).toLowerCase().includes(q) || (i.author || "").toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.date - a.date);
  }

  const isVideo = (it) => !!it.video && !it.video.audio;
  // Short social posts (X, Mastodon…): no real title, the text is the post (its title just repeats its start)
  function isMicro(it, f, text) {
    if (f && f.x) return true;
    text = text != null ? text : Parse.plain(it.html, 600);
    const lead = (it.title || "").replace(/…$/, "");
    return !!text && lead.length > 20 && text.startsWith(lead.slice(0, 40));
  }
  const groupOnlyFeeds = () => new Set(S.feeds.filter(f => f.groupOnly && f.group).map(f => f.id));
  const podFeeds = () => new Map(S.feeds.filter(f => f.podcast).map(f => [f.id, f]));
  // A podcast channel's video long enough to be an episode (lengths come from the YouTube API)
  const isEpisode = (it, f) => !!it.video && it.video.kind === "youtube" && !it.ytLive && it.ytDur >= (f.podMin || 60) * 60;
  const hiddenShort = (it) => S.settings.hideShorts && it.video && it.video.short;

  function renderList(keepScroll) {
    const ul = $("items");
    const top = keepScroll ? $("timeline").scrollTop : 0;
    S.shown = viewItems().map(i => i.key);
    S.rendered = 0;
    readObserver.disconnect();
    ul.textContent = "";
    renderTop();
    $("view-title").textContent = S.view === "all" ? "Home" : S.view === "starred" ? "Starred" : S.view === "groups" ? "Groups" : S.view === "podcasts" ? "Podcasts" : S.view.startsWith("group:") ? S.view.slice(6) : (feedById(S.view.slice(5)) || {}).title || "Feed";
    $("unread-btn").setAttribute("aria-pressed", S.settings.unreadOnly);
    $("unread-btn").title = S.settings.unreadOnly ? "Read posts hidden after a refresh: show them" : "Showing read posts: hide them";
    renderMore();
    const empty = $("empty");
    empty.hidden = S.shown.length > 0;
    if (!S.shown.length) {
      empty.textContent = !S.feeds.length ? "" : S.query ? "No posts match “" + S.query + "”." : S.view === "groups" && !groupNames().length ? "Put feeds into groups and they show up here: open a feed's Edit & filter and give it a Group." : S.view === "groups" && !tabGroups().length ? "No groups chosen for this tab. Tap ⚙ above to pick some." : S.view.startsWith("group:") && !groupFeeds(S.view.slice(6)).length ? "This group is empty." : S.view === "podcasts" ? podEmpty() : S.view === "starred" ? "Star posts to keep them here." : S.view === "videos" ? "Videos from YouTube channels and video feeds show up here. Follow a YouTube channel with the + button (paste its youtube.com/@name address)." : S.settings.unreadOnly ? "You're all caught up." : "No posts yet.";
      if (S.view === "podcasts" && !podFeeds().size) {
        const b = el("button", "btn primary", "Follow a channel as a podcast");
        b.onclick = openAddDialog;
        const row = el("div", "actions center");
        row.append(b);
        empty.append(row);
      } else if (S.feeds.length && S.settings.unreadOnly && !S.query && S.view !== "starred") {
        empty.append(el("p", "hint", "Pull down to check for new posts."));
      }
      if (!S.feeds.length) {
        empty.append(el("h3", null, "Welcome to BT Feeder"), el("p", null, "Follow your favourite sites in one place. Everything stays on this device."));
        const add = el("button", "btn primary", "Follow your first feed");
        add.onclick = openAddDialog;
        const imp = el("button", "btn", "Import OPML");
        imp.onclick = () => $("import-file").click();
        const row = el("div", "actions center");
        row.append(imp, add);
        empty.append(row);
      }
    }
    $("timeline").scrollTop = top;
  }

  // Above the timeline: the feeds you follow as a row of pictures (unread ones ringed), or, on a feed's
  // own page, its profile.
  function renderTop() {
    const top = $("top");
    top.textContent = "";
    const c = counts();
    if (S.view.startsWith("feed:")) {
      const f = feedById(S.view.slice(5));
      if (!f) return;
      const prof = el("div", "profile");
      const info = el("div", "pinfo");
      const link = el("a", "plink", f.x ? "@" + f.x : host(f.siteUrl || f.url));
      link.href = f.siteUrl || f.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      const total = [...S.items.values()].filter(i => i.feedId === f.id).length;
      info.append(el("h2", null, f.title), link, el("p", "pstats", total + (total === 1 ? " post" : " posts") + (c.feeds[f.id] ? " · " + c.feeds[f.id] + " unread" : "") +
        (c.hidden[f.id] ? " · " + c.hidden[f.id] + " hidden by filters" : "") + (f.group ? " · in " + f.group : "") + (f.error ? " · last refresh failed" : "")));
      const edit = el("button", "btn", hasFilters(f) ? "Edit · Filtered" : "Edit & filter");
      edit.onclick = () => openFeedDialog(f);
      prof.append(avatar(f, "big"), info, edit);
      top.append(prof);
      return;
    }
    if (S.view === "groups") {
      const row = el("div", "gchips");
      const cur = currentGroup();
      for (const g of tabGroups()) {
        const b = el("button", "gchip" + (g === cur ? " active" : ""), g);
        b.type = "button";
        if (c.groups[g]) b.append(el("b", null, String(c.groups[g])));
        b.onclick = () => { S.settings.groupSel = g; saveSettings(); renderList(); $("timeline").scrollTop = 0; };
        row.append(b);
      }
      if (groupNames().length) {
        const gear = el("button", "gchip gear");
        gear.type = "button";
        gear.title = "Choose the groups shown here";
        gear.setAttribute("aria-label", gear.title);
        gear.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>';
        gear.onclick = openGroupsDialog;
        row.append(gear);
      }
      top.append(row);
      if (!cur) return;
    }
    if (S.view === "starred" || !S.feeds.length || S.query) return;
    const latest = {};
    for (const it of S.items.values()) if (!latest[it.feedId] || it.date > latest[it.feedId]) latest[it.feedId] = it.date;
    const pool = S.view === "groups" ? groupFeeds(currentGroup()) : S.view.startsWith("group:") ? groupFeeds(S.view.slice(6)) : S.view === "podcasts" ? S.feeds.filter(f => f.podcast) : S.feeds.filter(f => !f.podcast && !(f.groupOnly && f.group));
    const feeds = [...pool].sort((a, b) => (!!c.feeds[b.id] - !!c.feeds[a.id]) || ((latest[b.id] || 0) - (latest[a.id] || 0)));
    const row = el("div", "stories");
    const add = el("button", "story add");
    add.append(el("span", "ring", "+"), el("span", "sname", "Follow"));
    add.onclick = openAddDialog;
    row.append(add);
    for (const f of feeds) {
      const b = el("button", "story" + (c.feeds[f.id] ? " new" : ""));
      b.dataset.view = "feed:" + f.id;
      b.title = f.title + (c.feeds[f.id] ? " · " + c.feeds[f.id] + " unread" : "");
      const ring = el("span", "ring");
      ring.append(avatar(f));
      b.append(ring, el("span", "sname", f.title));
      row.append(b);
    }
    top.append(row);
  }

  function renderMore() {
    const ul = $("items");
    const old = ul.querySelector(".sentinel");
    if (old) old.remove();
    const frag = document.createDocumentFragment();
    const end = Math.min(S.shown.length, S.rendered + PAGE);
    for (let i = S.rendered; i < end; i++) { const it = S.items.get(S.shown[i]); const li = S.view === "podcasts" ? podRow(it) : itemRow(it); if (S.view !== "podcasts") readObserver.observe(li); frag.append(li); }
    S.rendered = end;
    if (end < S.shown.length) {
      const s = el("li", "sentinel");
      frag.append(s);
      moreObserver.observe(s);
    }
    ul.append(frag);
  }

  const moreObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) { moreObserver.disconnect(); renderMore(); }
  }, { rootMargin: "600px" });

  const ICONS = {
    star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    read: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>'
  };

  function actionBtn(cls, icon, label) {
    const b = el("button", "pact " + cls);
    b.type = "button";
    b.innerHTML = ICONS[icon];
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  // A post in the timeline: who and when, the text, a big picture or video, and actions
  function itemRow(it) {
    const f = feedById(it.feedId) || { title: "", url: "" };
    const li = el("li", "post" + (it.read ? "" : " unread") + (it.star ? " starred" : "") + (it.key === S.current ? " active" : "") + (it.video ? " media" : "") + (isVideo(it) ? " video" : ""));
    li.dataset.key = it.key;
    li.tabIndex = 0;

    const head = el("div", "phead");
    const who = el("div", "who");
    // A repost: the original account's picture, name and handle, with "↻ @you-follow reposted" above
    const rp = f.x && isRepost(it) ? repostOf(it) : null;
    const prof = rp ? xProfile(rp) : null;
    const name = rp ? el("a", "pname", prof && prof.name ? prof.name : "@" + rp) : el("button", "pname", f.title);
    if (rp) { name.href = "https://x.com/" + rp; name.target = "_blank"; name.rel = "noopener noreferrer"; name.dataset.xh = rp; }
    else { name.type = "button"; name.dataset.view = "feed:" + f.id; }
    const time = el("time", null, ago(it.date));
    time.dateTime = new Date(it.date).toISOString();
    time.title = new Date(it.date).toLocaleString();
    const sub = el("span", "psub");
    const handle = rp ? "@" + rp : f.x ? (/^@\w+$/.test(it.author || "") ? it.author : "@" + f.x) : it.author && it.author !== f.title ? it.author : "";
    if (f.x && isRepost(it)) {
      const rp = el("div", "repost", "↻ @" + f.x + " reposted");
      li.append(rp);
    }
    if (handle) sub.append(el("span", "handle", handle), el("span", "dot", "·"));
    sub.append(time);
    who.append(name, sub);
    let face = avatar(rp ? repostFeed(rp, prof) : f);
    if (rp) { const a = el("a", "rpface"); a.href = "https://x.com/" + rp; a.target = "_blank"; a.rel = "noopener noreferrer"; a.dataset.xh = rp; a.append(face); face = a; }
    else face.dataset.view = "feed:" + f.id;
    head.append(face, who, el("span", "udot"));
    li.append(head);

    // Short posts (X, Mastodon…) repeat their text as the title: show the text once
    const text = Parse.plain(it.html, 600);
    const micro = isMicro(it, f, text);
    if (micro) {
      const p = el("p", "ptext full");
      p.append(text ? richText(it, f, 600, true) : it.title);
      li.append(p);
    } else {
      li.append(el("h3", "ptitle", it.title));
      const snip = Parse.plain(it.html, 280);
      // The text under a post's title only when previews are on (off by default); opening the post shows it all
      if (S.settings.previews && snip && snip !== it.title && !isVideo(it)) { const p = el("p", "ptext"); p.append(richText(it, f, 280, false)); li.append(p); }
    }

    const pics = it.video ? [] : gallery(it);
    if (pics.length) li.append(galleryEl(pics));
    else if (it.image || it.video) {
      const box = el("div", "pmedia" + (it.video && it.video.short ? " short" : "") + (it.video ? (it.video.audio ? " audio" : " playable") : ""));
      if (it.image && !(it.video && it.video.audio)) {
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.src = it.image;
        img.onerror = () => { img.remove(); if (!it.video) box.remove(); };
        box.append(img);
      }
      if (it.video) {
        box.append(el("span", "play", "▶"));
        if (it.video.audio) box.append(el("span", "alabel", it.pos > 5 && !it.watched ? "Resume episode" : "Play episode"));
        if (it.video.ytOnly) box.append(el("span", "badge yt", "Plays on YouTube"));
        else if (it.watched) box.append(el("span", "badge", "Watched"));
        else if (it.pos > 5 && it.dur) { const bar = el("span", "progress"); const fill = el("i"); fill.style.width = Math.min(100, it.pos / it.dur * 100) + "%"; bar.append(fill); box.append(bar); }
      }
      li.append(box);
    }

    if (it.quote) li.append(quoteEl(it, false));

    const acts = el("div", "pactions");
    const star = actionBtn("star", "star", it.star ? "Unstar" : "Star");
    star.setAttribute("aria-pressed", it.star);
    acts.append(star, actionBtn("share", "share", "Share"));
    if (it.link) {
      const a = el("a", "pact open");
      a.href = it.link; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.innerHTML = ICONS.open;
      a.title = "Open on " + (host(it.link) || "the site");
      a.setAttribute("aria-label", a.title);
      acts.append(a);
    }
    acts.append(el("span", "grow"), actionBtn("read", "read", it.read ? "Mark unread" : "Mark read"));
    li.append(acts);
    return li;
  }

  // A post's text for the timeline with its links kept: the post's own links, plus bare web addresses
  // (and @mentions and #hashtags for X accounts) made clickable. Cut at `max` characters.
  function richText(it, f, max, multiline) {
    const base = it.link || f.siteUrl || f.url;
    const doc = new DOMParser().parseFromString("<!doctype html><body>" + Parse.sanitize(it.html, base), "text/html");
    const frag = document.createDocumentFragment();
    let used = 0, done = false, lastBreak = true;
    const addText = (t) => {
      if (done || !t) return;
      if (t === "\n") {
        if (lastBreak) return;
        lastBreak = true;
        t = multiline ? "\n" : " ";
      } else {
        if (lastBreak) t = t.replace(/^\s+/, "");
        if (!t) return;
        lastBreak = false;
      }
      if (used + t.length > max) { t = t.slice(0, Math.max(0, max - used)).replace(/\s+\S*$/, "") + "…"; done = true; }
      used += t.length;
      linkify(frag, t, f);
    };
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (done) return;
        if (n.nodeType === 3) { addText(n.nodeValue.replace(/\s+/g, " ")); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.localName;
        if (/^(img|video|audio|picture|svg|figure|table)$/.test(tag)) continue;
        if (tag === "br") { addText("\n"); continue; }
        if (tag === "a" && n.getAttribute("href")) {
          const label = n.textContent.replace(/\s+/g, " ").trim();
          if (!label) continue;
          if (used + label.length > max) { addText(label); continue; }
          frag.append(linkEl(n.getAttribute("href"), label));
          used += label.length;
          lastBreak = false;
          continue;
        }
        const block = /^(p|div|li|h[1-6]|blockquote|ul|ol|pre|tr|section|article)$/.test(tag);
        if (block) addText("\n");
        walk(n);
        if (block) addText("\n");
      }
    };
    walk(doc.body);
    while (frag.lastChild && frag.lastChild.nodeType === 3 && !frag.lastChild.nodeValue.trim()) frag.lastChild.remove();
    return frag;
  }

  function linkEl(href, label) {
    const a = el("a", "tlink", /^https?:\/\//.test(label) ? shortUrl(label) : label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = href;
    return a;
  }
  const shortUrl = (u) => { const s = u.replace(/^https?:\/\/(www\.)?/, ""); return s.length > 38 ? s.slice(0, 36) + "…" : s; };

  function linkify(frag, text, f) {
    const re = f.x ? /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|(^|[^\w@/])@(\w{1,15})|(^|[^\w&/])#([\p{L}\p{N}_]+)/gu : /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m[1]) { frag.append(text.slice(last, m.index), linkEl(m[1], m[1])); }
      else if (m[3]) { frag.append(text.slice(last, m.index) + m[2], linkEl("https://x.com/" + m[3], "@" + m[3])); }
      else if (m[5]) { frag.append(text.slice(last, m.index) + m[4], linkEl("https://x.com/hashtag/" + encodeURIComponent(m[5]), "#" + m[5])); }
      last = re.lastIndex;
    }
    frag.append(text.slice(last));
  }

  // A post's pictures: the ones in its text, else the feed's picture for it
  function gallery(it) {
    const f = feedById(it.feedId) || {};
    const imgs = Parse.images(it.html, it.link || f.siteUrl || f.url);
    if (!imgs.length && it.image) imgs.push(it.image);
    return imgs;
  }

  // 1 picture: shown whole. 2–4: a grid (like social apps). More: "+N" on the fourth.
  function galleryEl(pics) {
    const shown = pics.slice(0, 4);
    const g = el("div", "pgallery n" + shown.length);
    const retag = () => { if (!g.children.length) g.remove(); else g.className = "pgallery n" + g.children.length; };
    shown.forEach((src, i) => {
      const cell = el("button", "cell");
      cell.type = "button";
      cell.dataset.i = i;
      cell.setAttribute("aria-label", "View picture " + (i + 1) + " of " + pics.length);
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = src;
      img.onerror = () => { cell.remove(); retag(); };
      // Small pictures (thumbnails) are shown at their own size rather than blown up
      img.onload = () => { if (shown.length === 1 && img.naturalWidth && img.naturalWidth < 320) g.classList.add("small"); };
      cell.append(img);
      if (i === 3 && pics.length > 4) cell.append(el("span", "more", "+" + (pics.length - 4)));
      g.append(cell);
    });
    return g;
  }

  // ---------- Picture viewer ----------

  const LB = { list: [], i: 0, closing: false };
  function openLightbox(list, i) {
    if (!list.length) return;
    LB.list = list;
    LB.i = Math.max(0, Math.min(i, list.length - 1));
    showLightbox();
    $("lightbox").hidden = false;
    history.pushState({ lightbox: true }, "");
    $("lb-close").focus();
  }
  function showLightbox() {
    $("lb-img").src = LB.list[LB.i];
    $("lb-count").textContent = LB.list.length > 1 ? (LB.i + 1) + " / " + LB.list.length : "";
    $("lb-prev").hidden = LB.i === 0;
    $("lb-next").hidden = LB.i >= LB.list.length - 1;
  }
  function stepLightbox(d) {
    const i = LB.i + d;
    if (i < 0 || i >= LB.list.length) return;
    LB.i = i;
    showLightbox();
  }
  function closeLightbox(fromHistory) {
    if ($("lightbox").hidden) return;
    $("lightbox").hidden = true;
    $("lb-img").removeAttribute("src");
    if (!fromHistory && history.state && history.state.lightbox) { LB.closing = true; history.back(); }
  }
  $("lb-close").onclick = () => closeLightbox();
  $("lb-prev").onclick = (e) => { e.stopPropagation(); stepLightbox(-1); };
  $("lb-next").onclick = (e) => { e.stopPropagation(); stepLightbox(1); };
  $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
  // Swipe left / right between pictures, down to close
  let swipe = null;
  $("lightbox").addEventListener("pointerdown", (e) => { swipe = { x: e.clientX, y: e.clientY }; });
  $("lightbox").addEventListener("pointerup", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepLightbox(dx < 0 ? 1 : -1);
    else if (dy > 90) closeLightbox();
  });

  async function share(it) {
    const url = it.link || "";
    try {
      if (navigator.share) return await navigator.share({ title: it.title, url });
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (e) { /* cancelled */ }
  }

  // Play a video or episode right in the timeline
  function playInline(li, it) {
    stopPlayer();
    const box = li.querySelector(".pmedia");
    if (!box) return;
    const p = playerFor(it);
    p.classList.add("inline");
    box.replaceWith(p);
    setRead(it, true);
  }

  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  // ---------- Reading ----------

  function openArticle(key, { fromHistory } = {}) {
    const it = typeof key === "object" ? key : S.items.get(key);
    if (!it) return;
    key = it.key;
    const prev = document.querySelector(".post.active");
    if (prev) prev.classList.remove("active");
    S.current = key;
    const row = document.querySelector('.post[data-key="' + CSS.escape(key) + '"]');
    if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }); }

    const f = feedById(it.feedId) || { title: "" };
    const art = $("article");
    stopPlayer();
    art.textContent = "";
    const pf = feedById(it.feedId);
    const episode = pf && pf.podcast && isEpisode(it, pf);
    art.classList.toggle("has-video", !!it.video && !it.video.audio && !episode);
    if (episode) {
      const box = el("div", "podhead");
      const img = el("img", "podbig"); img.src = it.image || ""; img.alt = ""; img.referrerPolicy = "no-referrer";
      const play = el("button", "btn primary podgo", Pod.item && Pod.item.key === it.key ? (Pod.playing ? "❚❚ Pause" : "▶ Resume") : it.pos > 5 && !it.watched ? "▶ Resume (" + length(Math.max(0, it.ytDur - it.pos)) + " left)" : "▶ Play episode · " + length(it.ytDur));
      play.onclick = () => { podPlay(it); setTimeout(() => { play.textContent = Pod.playing ? "❚❚ Pause" : "▶ Resume"; }, 600); };
      box.append(img, play);
      art.append(box);
    } else if (it.video) art.append(playerFor(it));
    const head = el("header");
    const src = el("a", "src");
    // A repost, or a quoted post opened on its own: the original account in the header
    const rpOf = it.virtual ? it.quoteAuthor.handle : f.x && isRepost(it) ? repostOf(it) : null;
    if (rpOf) {
      const pr = xProfile(rpOf);
      if (!it.virtual) head.append(el("div", "repost", "↻ @" + f.x + " reposted"));
      const nm = it.virtual && it.quoteAuthor.name ? it.quoteAuthor.name : pr && pr.name ? pr.name : "@" + rpOf;
      src.append(avatar(repostFeed(rpOf, pr || { name: nm })), el("span", null, nm));
    } else src.append(avatar(f), el("span", null, f.title));
    src.href = rpOf ? "https://x.com/" + rpOf : f.siteUrl || it.link || "#";
    if (rpOf) src.dataset.xh = rpOf;
    src.target = "_blank";
    src.rel = "noopener noreferrer";
    const h = el("h1");
    if (it.link) {
      const a = el("a", null, it.title);
      a.href = it.link; a.target = "_blank"; a.rel = "noopener noreferrer";
      h.append(a);
    } else h.textContent = it.title;
    const by = el("p", "byline", [it.author, it.date ? new Date(it.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""].filter(Boolean).join(" · "));
    // A social post's title only repeats its text: show the text once
    if (isMicro(it, f)) { head.append(src, by); head.classList.add("micro"); }
    else head.append(src, h, by);
    const content = el("div", "content");
    const clean = Parse.sanitize(it.html, it.link || f.siteUrl);
    content.innerHTML = clean;
    // Show the feed's picture when the article itself has none (videos have the player instead)
    if (it.image && !content.querySelector("img") && !(it.video && !it.video.audio)) {
      const img = el("img", "lead");
      img.src = it.image; img.alt = ""; img.referrerPolicy = "no-referrer";
      img.onerror = () => img.remove();
      content.prepend(img);
    }
    for (const img of content.querySelectorAll("img")) img.addEventListener("error", () => img.remove());
    if (it.video) linkTimestamps(content);
    if (!Parse.plain(clean).length && !content.querySelector("img") && !it.video) content.append(el("p", "muted", "This feed only shares a headline."));
    art.append(head, content);
    if (it.quote) art.append(quoteEl(it, true));
    if (it.link) {
      const more = el("a", "btn readmore", (it.video && it.video.kind === "youtube" ? "Watch on " : "Read on ") + (host(it.link) || "the site"));
      more.href = it.link; more.target = "_blank"; more.rel = "noopener noreferrer";
      art.append(more);
    }
    $("reader-scroll").scrollTop = 0;
    $("open-btn").href = it.link || "#";
    $("open-btn").hidden = !it.link;
    if (!it.virtual) setRead(it, true);
    syncReaderButtons(it);
    // A quoted post isn't one of your posts: no star / read buttons
    $("star-btn").hidden = $("read-btn").hidden = !!it.virtual;
    document.body.classList.add("reading");
    if (!fromHistory && !(history.state && history.state.article)) history.pushState({ article: key }, "");
  }

  function closeArticle() {
    document.body.classList.remove("reading");
    // Stop any video or audio once the article slides away
    if ($("article").querySelector(".player")) setTimeout(() => { if (!document.body.classList.contains("reading")) { stopPlayer(); $("article").querySelector(".player")?.remove(); } }, 260);
    if (S.settings.unreadOnly) setTimeout(() => renderList(true), 250);
  }

  function syncReaderButtons(it) {
    $("star-btn").setAttribute("aria-pressed", it.star);
    $("star-btn").title = it.star ? "Unstar (s)" : "Star (s)";
    $("read-btn").title = it.read ? "Mark unread (m)" : "Mark read (m)";
    $("read-btn").classList.toggle("on", !it.read);
  }

  function step(dir) {
    const i = S.shown.indexOf(S.current);
    const next = S.shown[i < 0 ? 0 : i + dir];
    if (!next) return;
    while (S.shown.indexOf(next) >= S.rendered) renderMore();
    openArticle(next);
  }

  // ---------- Video / audio player ----------

  // The YouTube player talks to the page with postMessage (the same messages its IFrame API uses), so we
  // can save where you stopped, mark videos watched and make timestamps in descriptions seek, without
  // loading any YouTube script into the page.
  const player = { frame: null, media: null, item: null, ready: false, timer: 0, lastSave: 0 };

  function playerFor(it) {
    const v = it.video;
    const wrap = el("div", "player" + (v.short ? " short" : "") + (v.audio ? " audio" : ""));
    player.item = it;
    player.ready = false;
    const start = !it.watched && it.pos > 5 && (!it.dur || it.pos < it.dur - 10) ? Math.floor(it.pos) : 0;
    if (v.kind === "x") {
      // Just the video: its file comes from the post's Nitter page (saved once found). If no server has it,
      // fall back to X's embedded post.
      wrap.classList.add("xvid");
      const fallback = () => { wrap.className = "player x" + (wrap.classList.contains("inline") ? " inline" : ""); wrap.textContent = ""; xEmbed(wrap, it, v); };
      if (v.src) mediaEl(wrap, it, { url: v.src, gif: v.gif }, start, fallback);
      else {
        wrap.append(el("div", "xload", "Loading video…"));
        xVideoSrc(it).then(found => {
          if (!wrap.isConnected || player.item !== it) return;
          wrap.textContent = "";
          if (!found) return fallback();
          v.src = found.src;
          v.gif = found.gif;
          saveItems([it]);
          mediaEl(wrap, it, { url: v.src, gif: v.gif }, start, fallback);
        });
      }
    } else if (v.kind === "youtube") {
      // Known to play only on YouTube: say so straight away instead of loading a player that will refuse
      if (v.ytOnly) {
        if (S.settings.invidious) playInvidious(wrap, it, v, start);
        else ytCard(wrap, it, v, "Plays only on YouTube", "The uploader doesn't allow this video to be played in other apps.");
        return wrap;
      }
      const f = el("iframe");
      const q = new URLSearchParams({ autoplay: "1", enablejsapi: "1", rel: "0", playsinline: "1", origin: location.origin });
      if (start) q.set("start", start);
      f.dataset.query = q;
      f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(v.id) + "?" + q;
      f.title = it.title;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write; web-share";
      f.allowFullscreen = true;
      // YouTube refuses to play embeds that don't say which site they're on
      f.referrerPolicy = "strict-origin-when-cross-origin";
      f.addEventListener("load", () => listen(f));
      player.frame = f;
      wrap.append(f);
      // A player that never answers was blocked (an extension or the browser's protection)
      setTimeout(() => {
        if (player.frame !== f || player.ready || !f.isConnected) return;
        ytCard(wrap, it, v, "YouTube's player didn't load", "An ad blocker or your browser's privacy protection is probably blocking it. Allow this site, or watch it on YouTube.", true);
      }, 12000);
    } else mediaEl(wrap, it, v, start);
    return wrap;
  }

  // A video or audio file in BT Feeder's own player (remembers where you stopped). GIFs loop silently.
  function mediaEl(wrap, it, v, start, onError) {
    const m = el(v.audio ? "audio" : "video");
    m.controls = true;
    m.preload = "metadata";
    m.playsInline = true;
    if (v.gif) { m.loop = true; m.muted = true; }
    m.src = v.url;
    if (it.image && !v.audio) m.poster = it.image;
    m.addEventListener("loadedmetadata", () => { if (start && !v.gif) m.currentTime = start; m.play().catch(() => {}); });
    if (!v.gif) {
      m.addEventListener("timeupdate", () => progress(m.currentTime, m.duration));
      m.addEventListener("pause", () => progress(m.currentTime, m.duration, true));
      m.addEventListener("ended", () => finished());
    }
    m.addEventListener("error", () => { if (onError) onError(); else wrap.replaceChildren(el("p", "muted", "This file can't be played here.")); });
    player.media = m;
    wrap.append(m);
  }

  // Find an X post's video file on Nitter: the feed's own server first, then two others, in one call
  async function xVideoSrc(it) {
    const m = /x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(it.link || "");
    if (!m) return null;
    const f = feedById(it.feedId) || {};
    const hosts = [f.x ? new URL(f.url).hostname : "", ...(await nitterHosts())].filter((h, i, a) => h && a.indexOf(h) === i).slice(0, 3);
    const urls = hosts.map(h => "https://" + h + "/" + m[1] + "/status/" + m[2]);
    let results;
    try { results = await fetchBatch(urls); } catch (e) { return null; }
    for (const r of results) {
      const found = r.ok && Parse.nitterVideo(r.body);
      if (found) return found;
    }
    return null;
  }

  // X's official embedded post (text + video); it reports its height so the frame can fit it
  function xEmbed(wrap, it, v) {
    const f = el("iframe");
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    f.src = "https://platform.twitter.com/embed/Tweet.html?" + new URLSearchParams({ id: v.id, dnt: "true", theme: dark ? "dark" : "light", hideThread: "true", lang: "en" });
    f.title = it.title;
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    f.referrerPolicy = "strict-origin-when-cross-origin";
    wrap.classList.add("x");
    player.frame = f;
    wrap.append(f);
    // Privacy protections (Brave Shields, Firefox tracking protection, ad blockers) often block X's player.
    // It reports its size as soon as it works; if it hasn't after a few seconds, explain and offer X instead.
    setTimeout(() => {
      if (f.dataset.ok || !f.isConnected) return;
      wrap.classList.add("blocked");
      const note = el("div", "blocked-note");
      note.append(el("b", null, "X's video player didn't load"),
        el("p", null, "Your browser's privacy protection or an ad blocker is probably blocking it. Allow this site in Brave Shields, Firefox's tracking protection or your blocker, or watch it on X."));
      const go = el("a", "btn primary", "Watch on X");
      go.href = it.link || "https://x.com/i/status/" + v.id; go.target = "_blank"; go.rel = "noopener noreferrer";
      note.append(go);
      wrap.append(note);
    }, 8000);
  }

  // Ask the YouTube player to start sending its state; repeat until it answers (it may load slowly)
  function listen(f) {
    clearInterval(player.timer);
    let tries = 0;
    const send = () => {
      if (player.ready || player.frame !== f || ++tries > 20) return clearInterval(player.timer);
      try { f.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*"); } catch (e) {}
    };
    send();
    player.timer = setInterval(send, 500);
  }

  function command(func, args) {
    if (player.frame) player.frame.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: args || [], id: 1, channel: "widget" }), "*");
  }

  // X embeds say how tall they are: { "twttr.embed": { method: "twttr.private.resize", params: [{ height }] } }
  addEventListener("message", (e) => {
    if (e.origin !== "https://platform.twitter.com") return;
    let d;
    try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    const msg = d && d["twttr.embed"];
    const h = msg && msg.method === "twttr.private.resize" && msg.params && msg.params[0] && msg.params[0].height;
    if (!h) return;
    for (const f of document.querySelectorAll(".player.x iframe")) {
      if (f.contentWindow !== e.source) continue;
      f.style.height = Math.ceil(h) + "px";
      f.dataset.ok = "1";
      // It loaded after all (slow connection): drop the warning
      f.parentElement.classList.remove("blocked");
      f.parentElement.querySelector(".blocked-note")?.remove();
    }
  });

  addEventListener("message", (e) => {
    if (!player.frame || e.source !== player.frame.contentWindow || !/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
    let d;
    try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!d || !d.event) return;
    player.ready = true;
    // It loaded after all: drop a "didn't load" note
    const wrap = player.frame.parentElement;
    if (wrap && wrap.classList.contains("ytcard")) { wrap.classList.remove("ytcard", "blocked"); wrap.querySelector(".ytnote")?.remove(); }
    if (d.event === "onError") return youtubeError(+d.info);
    const info = d.info || {};
    if (typeof info.currentTime === "number") progress(info.currentTime, info.duration);
    if (info.playerState === 0) finished();
    if (info.playerState === 2) progress(info.currentTime, info.duration, true);
  });

  // YouTube player errors: 2 bad request, 5 HTML5 player, 100 private/removed, 101 / 150 embedding not allowed,
  // 152 / 153 player setup. First retry in YouTube's standard player (some videos refuse only the
  // privacy-enhanced one); after that, explain and offer YouTube.
  function youtubeError(code) {
    const f = player.frame, it = player.item;
    if (!f || !it || !it.video) return;
    const v = it.video, wrap = f.parentElement;
    if (f.src.includes("youtube-nocookie.com")) {
      player.ready = false;
      f.src = "https://www.youtube.com/embed/" + encodeURIComponent(v.id) + "?" + f.dataset.query;
      return;
    }
    if (code === 101 || code === 150) {
      v.ytOnly = true;
      saveItems([it]);
      if (S.settings.invidious) { wrap.textContent = ""; clearInterval(player.timer); player.frame = null; return playInvidious(wrap, it, v, 0); }
      return ytCard(wrap, it, v, "Plays only on YouTube", "The uploader doesn't allow this video to be played in other apps.");
    }
    if (code === 100) return ytCard(wrap, it, v, "Video unavailable", "This video is private or was removed.");
    ytCard(wrap, it, v, "This video can't play here", "YouTube's player reported a problem (" + code + ").");
  }

  // Your own Invidious server (Settings: "YouTube fallback") plays videos YouTube won't play in other apps.
  // Asked from the browser first (works for a server on your home network), then through the feed fetcher.
  async function playInvidious(wrap, it, v, start) {
    const base = S.settings.invidious.replace(/\/+$/, "");
    wrap.classList.add("xvid");
    wrap.textContent = "";
    wrap.append(el("div", "xload", "Loading from your Invidious server…"));
    const api = base + "/api/v1/videos/" + encodeURIComponent(v.id) + "?local=true";
    let data = null;
    try { data = await (await fetch(api)).json(); } catch (e) {
      try { const [r] = await fetchBatch([api]); if (r.ok) data = JSON.parse(r.body); } catch (e2) { /* below */ }
    }
    if (!wrap.isConnected || player.item !== it) return;
    const streams = (data && data.formatStreams || []).filter(s => s.url && /mp4|webm/.test(s.type || s.container || ""));
    // Best combined (video + sound) stream, mp4 first
    streams.sort((a, b) => (parseInt(b.resolution || b.qualityLabel) || 0) - (parseInt(a.resolution || a.qualityLabel) || 0) || (/mp4/.test(b.type) - /mp4/.test(a.type)));
    wrap.textContent = "";
    if (!streams.length) {
      wrap.classList.remove("xvid");
      return ytCard(wrap, it, v, "Your Invidious server couldn't play it", data && data.error ? String(data.error).slice(0, 140) : "It didn't answer, or had no playable stream for this video.");
    }
    const url = streams[0].url.startsWith("/") ? base + streams[0].url : streams[0].url;
    mediaEl(wrap, it, { url }, start, () => { wrap.classList.remove("xvid"); ytCard(wrap, it, v, "Your Invidious server couldn't play it", "The video stream didn't load."); });
  }

  function applyInvidious() { $("invidious-btn").textContent = "YouTube fallback: " + (S.settings.invidious ? host(S.settings.invidious) || "on" : "Off"); }
  $("invidious-btn").onclick = async () => {
    const r = await ask({ title: "YouTube fallback",
      text: "Address of your own Invidious server. BT Feeder uses it to play YouTube videos whose uploader doesn't allow playback in other apps, and podcasts as audio only.",
      input: S.settings.invidious || "", placeholder: "https://invidious.example.com", ok: "Save", extra: S.settings.invidious ? "Turn off" : "" });
    if (r.action === "cancel") return;
    const t = r.action === "extra" ? "" : r.value;
    if (t && !/^https:\/\/[^\s/]+/i.test(t)) return toast("Use the server's https:// address");
    S.settings.invidious = t.replace(/\/+$/, "");
    saveSettings();
    applyInvidious();
    toast(t ? "YouTube fallback: " + host(t) : "YouTube fallback off");
  };

  // In place of the player: the thumbnail, why it can't play, and a button to YouTube (opens the app on phones)
  function ytCard(wrap, it, v, title, text, keepFrame) {
    if (!wrap) return;
    if (!keepFrame) { wrap.textContent = ""; if (player.item === it) { clearInterval(player.timer); player.frame = null; } }
    wrap.querySelector(".ytnote")?.remove();
    wrap.classList.add("ytcard");
    if (keepFrame) wrap.classList.add("blocked");
    const note = el("div", "ytnote");
    if (it.image) { const bg = el("img", "ytbg"); bg.src = it.image; bg.alt = ""; bg.referrerPolicy = "no-referrer"; note.append(bg); }
    const box = el("div", "ytmsg");
    box.append(el("b", null, title), el("p", null, text));
    const go = el("a", "btn primary", "▶ Watch on YouTube");
    go.href = (v.short ? "https://www.youtube.com/shorts/" : "https://www.youtube.com/watch?v=") + encodeURIComponent(v.id) + (it.pos > 5 && !it.watched ? (v.short ? "" : "&t=" + Math.floor(it.pos)) : "");
    go.target = "_blank";
    go.rel = "noopener noreferrer";
    box.append(go);
    note.append(box);
    wrap.append(note);
  }

  function progress(pos, dur, force) {
    const it = player.item;
    if (!it || !isFinite(pos)) return;
    it.pos = pos;
    if (dur && isFinite(dur)) it.dur = dur;
    // Save every few seconds while playing, and straight away on pause
    if (force || Date.now() - player.lastSave > 5000) { player.lastSave = Date.now(); saveItems([it]); }
  }

  function finished() {
    const it = player.item;
    if (!it || it.watched) return;
    it.watched = true;
    it.pos = 0;
    saveItems([it]);
  }

  function seek(t) {
    if (player.media) { player.media.currentTime = t; player.media.play().catch(() => {}); }
    else if (player.frame) { command("seekTo", [t, true]); command("playVideo"); }
    const p = $("article").querySelector(".player");
    if (p && narrow()) $("reader-scroll").scrollTo({ top: 0, behavior: "smooth" });
  }

  function stopPlayer() {
    if (player.item && player.media) progress(player.media.currentTime, player.media.duration, true);
    else if (player.item) saveItems([player.item]);
    clearInterval(player.timer);
    if (player.media) player.media.pause();
    // Refresh the list row so it shows the new progress bar / "Watched"
    if (player.item) {
      const row = document.querySelector('.post[data-key="' + CSS.escape(player.item.key) + '"]');
      if (row) row.replaceWith(itemRow(player.item));
    }
    player.frame = player.media = player.item = null;
  }

  // "1:23" / "1:02:03" in a video description become buttons that jump there
  function linkTimestamps(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (/\b\d{1,2}:\d{2}\b/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest("a")) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const re = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
      let m;
      while ((m = re.exec(n.nodeValue))) {
        frag.append(n.nodeValue.slice(last, m.index));
        const b = el("button", "ts", m[0]);
        b.dataset.t = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
        frag.append(b);
        last = re.lastIndex;
      }
      frag.append(n.nodeValue.slice(last));
      n.replaceWith(frag);
    }
  }
  $("article").addEventListener("click", (e) => {
    if (e.target.closest(".quote")) return openQuote(S.items.get(S.current));
    const b = e.target.closest(".ts");
    if (b) {
      const it = S.items.get(S.current), pf = it && feedById(it.feedId);
      if (it && pf && pf.podcast && isEpisode(it, pf)) return podPlay(it, +b.dataset.t);
      return seek(+b.dataset.t);
    }
    if (e.target.tagName === "IMG" && e.target.closest(".content")) {
      e.preventDefault();
      const all = [...$("article").querySelectorAll(".content img")];
      openLightbox(all.map(i => i.currentSrc || i.src), all.indexOf(e.target));
    }
  });

  // ---------- Podcasts ----------
  // YouTube channels followed as podcasts: their videos over the channel's minimum length (an hour by default)
  // are episodes, listed in Podcasts and played in the player bar. With your own Invidious server (YouTube
  // fallback setting) episodes play as audio only (keeps going with the screen off, lock-screen controls);
  // otherwise YouTube's own player plays them in a small window in the bar.

  const isoSecs = (d) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "") || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
  const hms = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const length = (s) => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? h + " h" + (m ? " " + m + " min" : "") : m + " min"; };
  let podProblem = "";

  function podEmpty() {
    if (!podFeeds().size) return "Follow a YouTube channel as a podcast: its videos over an hour show up here, ready to play like a podcast.";
    if (!S.settings.ytKey) return "Podcasts need your YouTube API key (bottom of the menu) to tell which videos are long enough.";
    if (podProblem) return "Couldn't get video lengths from YouTube: " + podProblem;
    return S.settings.unreadOnly ? "No new episodes. Pull down or press refresh to check." : "No episodes over the minimum length yet.";
  }

  // Video lengths for podcast channels, from the YouTube Data API (1 quota unit per 50 videos)
  let podBusy = false;
  async function podDurations() {
    if (podBusy || !S.settings.ytKey) return;
    const pods = podFeeds();
    const need = [...S.items.values()].filter(i => pods.has(i.feedId) && i.video && i.video.kind === "youtube" && i.ytDur == null);
    if (!need.length) return;
    podBusy = true;
    try {
      for (let k = 0; k < need.length; k += 50) {
        const chunk = need.slice(k, k + 50);
        const d = await fetch("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({ part: "contentDetails,snippet", id: chunk.map(i => i.video.id).join(","), fields: "items(id,contentDetails/duration,snippet/liveBroadcastContent)" }),
          { headers: { "X-Goog-Api-Key": S.settings.ytKey } }).then(r => r.json());
        if (d.error) { podProblem = (d.error.message || "error").replace(/<[^>]*>/g, ""); break; }
        podProblem = "";
        const got = new Map((d.items || []).map(v => [v.id, v]));
        for (const it of chunk) {
          const v = got.get(it.video.id);
          it.ytDur = v ? isoSecs(v.contentDetails && v.contentDetails.duration) : 0;
          it.ytLive = !!(v && v.snippet && v.snippet.liveBroadcastContent && v.snippet.liveBroadcastContent !== "none");
        }
        saveItems(chunk);
      }
    } catch (e) { podProblem = "couldn't reach the YouTube API"; }
    finally { podBusy = false; }
    renderCounts();
    if (S.view === "podcasts") renderList(true);
  }

  // An episode in the list: artwork, show, title, length / time left, and a play button
  function podRow(it) {
    const f = feedById(it.feedId) || { title: "" };
    const li = el("li", "post pod" + (it.read || it.watched ? "" : " unread") + (Pod.item && Pod.item.key === it.key ? " current" : ""));
    li.dataset.key = it.key;
    li.tabIndex = 0;
    const art = el("img", "podart");
    art.alt = ""; art.loading = "lazy"; art.referrerPolicy = "no-referrer";
    art.src = it.image || "";
    art.onerror = () => { art.replaceWith(letterIcon(f, "podart")); };
    const info = el("div", "podinfo");
    const src = el("div", "podsrc");
    const name = el("button", "pname", f.title); name.type = "button"; name.dataset.view = "feed:" + f.id;
    src.append(name, el("span", "dot", "·"), el("time", null, ago(it.date)));
    const left = it.pos > 5 && !it.watched ? Math.max(0, (it.ytDur || it.dur) - it.pos) : 0;
    const meta = el("div", "podmeta", it.watched ? "Played" : left ? length(left) + " left" : length(it.ytDur));
    info.append(src, el("h3", "ptitle", it.title), meta);
    if (left && it.ytDur) { const bar = el("span", "podprog"); const fill = el("i"); fill.style.width = Math.min(100, it.pos / it.ytDur * 100) + "%"; bar.append(fill); info.append(bar); }
    const playing = Pod.item && Pod.item.key === it.key && Pod.playing;
    const btn = el("button", "podplay", playing ? "❚❚" : "▶");
    btn.type = "button";
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    const notes = el("button", "podnotes");
    notes.type = "button"; notes.title = "Show notes"; notes.setAttribute("aria-label", "Show notes");
    notes.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9"/></svg>';
    li.append(art, info, notes, btn);
    return li;
  }

  function refreshPodRow(it) {
    const row = document.querySelector('.post.pod[data-key="' + CSS.escape(it.key) + '"]');
    if (row) row.replaceWith(podRow(it));
  }

  // ---------- The player bar ----------

  const Pod = { item: null, mode: "", media: null, frame: null, playing: false, time: 0, dur: 0, rate: 1, lastSave: 0, timer: 0, wantPlay: false, resumes: 0 };
  const RATES = [1, 1.25, 1.5, 1.75, 2];

  async function podPlay(it, at) {
    if (Pod.item && Pod.item.key === it.key) { if (at != null) podSeek(at); else podToggle(); return; }
    podStop();
    stopPlayer();
    Pod.item = it;
    Pod.wantPlay = true;
    Pod.resumes = 0;
    Pod.dur = it.ytDur || it.dur || 0;
    const start = at != null ? at : !it.watched && it.pos > 5 && (!Pod.dur || it.pos < Pod.dur - 10) ? it.pos : 0;
    Pod.time = start;
    const f = feedById(it.feedId) || { title: "" };
    $("pb-title").textContent = it.title;
    $("pb-sub").textContent = f.title;
    $("pb-art").src = it.image || "";
    $("podbar").hidden = false;
    document.body.classList.add("podding");
    podUi();
    setRead(it, true);
    if (S.view === "podcasts") refreshPodRow(it);
    // Audio only from your own Invidious server; YouTube's player otherwise
    const audio = S.settings.invidious ? await invidiousAudio(it.video.id) : "";
    if (Pod.item !== it) return;
    if (audio) podAudio(it, audio, start); else podYouTube(it, start);
  }

  async function invidiousAudio(id) {
    const base = S.settings.invidious.replace(/\/+$/, "");
    const api = base + "/api/v1/videos/" + encodeURIComponent(id) + "?local=true";
    let data = null;
    try { data = await (await fetch(api)).json(); } catch (e) {
      try { const [r] = await fetchBatch([api]); if (r.ok) data = JSON.parse(r.body); } catch (e2) { /* none */ }
    }
    const audio = (data && data.adaptiveFormats || []).filter(f => f.url && /^audio\//.test(f.type || ""));
    // mp4 (AAC) plays everywhere, iPhones included; then the best bitrate
    audio.sort((a, b) => (/mp4/.test(b.type) - /mp4/.test(a.type)) || ((+b.bitrate || 0) - (+a.bitrate || 0)));
    if (!audio.length) return "";
    return audio[0].url.startsWith("/") ? base + audio[0].url : audio[0].url;
  }

  function podAudio(it, url, start) {
    Pod.mode = "audio";
    const a = new Audio();
    a.preload = "auto";
    a.src = url;
    a.playbackRate = Pod.rate;
    a.addEventListener("loadedmetadata", () => { if (start) a.currentTime = start; a.playbackRate = Pod.rate; a.play().catch(() => {}); });
    a.addEventListener("timeupdate", () => podTick(a.currentTime, a.duration));
    a.addEventListener("play", () => { Pod.playing = true; podUi(); });
    a.addEventListener("pause", () => { Pod.playing = false; podTick(a.currentTime, a.duration, true); podUi(); });
    a.addEventListener("ended", podEnded);
    a.addEventListener("error", () => { if (Pod.item === it && Pod.mode === "audio") { toast("Your Invidious server couldn't play it; using YouTube's player"); podYouTube(it, Pod.time); } });
    Pod.media = a;
    $("pb-media").replaceChildren();
    $("podbar").classList.remove("yt");
    mediaSession(it);
  }

  function podYouTube(it, start) {
    Pod.mode = "yt";
    if (Pod.media) { Pod.media.pause(); Pod.media = null; }
    const f = el("iframe");
    const q = new URLSearchParams({ autoplay: "1", enablejsapi: "1", rel: "0", playsinline: "1", controls: "0", origin: location.origin });
    if (start) q.set("start", Math.floor(start));
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(it.video.id) + "?" + q;
    f.title = it.title;
    f.allow = "autoplay; encrypted-media; picture-in-picture";
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.addEventListener("load", () => {
      clearInterval(Pod.timer);
      let n = 0;
      const hello = () => { if (Pod.frame !== f || ++n > 20) return clearInterval(Pod.timer); try { f.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 2, channel: "widget" }), "*"); } catch (e) {} };
      hello();
      Pod.timer = setInterval(hello, 500);
    });
    Pod.frame = f;
    $("pb-media").replaceChildren(f);
    $("podbar").classList.add("yt");
  }

  function ytCommand(func, args) {
    if (Pod.frame) Pod.frame.contentWindow.postMessage(JSON.stringify({ event: "command", func, args: args || [], id: 2, channel: "widget" }), "*");
  }

  addEventListener("message", (e) => {
    if (!Pod.frame || e.source !== Pod.frame.contentWindow || !/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
    let d;
    try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!d || !d.event) return;
    clearInterval(Pod.timer);
    if (d.event === "onError") {
      // Playable only on YouTube
      $("pb-sub").textContent = "Plays only on YouTube · set YouTube fallback to play it here";
      Pod.playing = false; podUi();
      return;
    }
    if (d.event === "initialDelivery" && Pod.rate !== 1) ytCommand("setPlaybackRate", [Pod.rate]);
    const info = d.info || {};
    if (typeof info.playerState === "number") {
      if (info.playerState === 1) { Pod.playing = true; Pod.resumes = 0; }
      if (info.playerState === 2) {
        // In the Android app, YouTube may pause on its own when BT Feeder goes to the background: if you didn't
        // pause it (bar, notification or headphones), carry on (a few tries, so a real stop isn't fought forever)
        if (window.ReaderApp && Pod.wantPlay && Pod.resumes < 5) { Pod.resumes++; setTimeout(() => ytCommand("playVideo"), 300); return; }
        Pod.playing = false; podTick(Pod.time, Pod.dur, true);
      }
      if (info.playerState === 0) return podEnded();
      podUi();
    }
    if (typeof info.currentTime === "number") podTick(info.currentTime, info.duration);
  });

  function podTick(t, dur, force) {
    const it = Pod.item;
    if (!it || !isFinite(t)) return;
    Pod.time = t;
    if (dur && isFinite(dur)) Pod.dur = dur;
    it.pos = t;
    if (Pod.dur) it.dur = Pod.dur;
    if (force || Date.now() - Pod.lastSave > 5000) { Pod.lastSave = Date.now(); saveItems([it]); }
    podUi();
  }

  function podEnded() {
    const it = Pod.item;
    if (!it) return;
    it.watched = true;
    it.pos = 0;
    saveItems([it]);
    Pod.playing = false;
    Pod.wantPlay = false;
    podUi();
    toast("Finished: " + it.title.slice(0, 60));
    if (S.view === "podcasts") refreshPodRow(it);
    renderCounts();
  }

  function podToggle() {
    if (!Pod.item) return;
    Pod.wantPlay = !Pod.playing;
    if (Pod.mode === "audio" && Pod.media) { if (Pod.media.paused) Pod.media.play().catch(() => {}); else Pod.media.pause(); }
    else if (Pod.mode === "yt") { ytCommand(Pod.playing ? "pauseVideo" : "playVideo"); Pod.playing = !Pod.playing; podUi(); }
  }

  function podSeek(t) {
    Pod.wantPlay = true;
    t = Math.max(0, Math.min(Pod.dur || t, t));
    if (Pod.mode === "audio" && Pod.media) { Pod.media.currentTime = t; Pod.media.play().catch(() => {}); }
    else if (Pod.mode === "yt") { ytCommand("seekTo", [t, true]); ytCommand("playVideo"); }
    Pod.time = t;
    podUi();
  }

  function podStop() {
    const it = Pod.item;
    if (it) { it.pos = Pod.time; saveItems([it]); }
    clearInterval(Pod.timer);
    if (Pod.media) { Pod.media.pause(); Pod.media.removeAttribute("src"); Pod.media.load(); }
    Pod.media = Pod.frame = null;
    Pod.item = null;
    Pod.playing = false;
    Pod.wantPlay = false;
    $("pb-media").replaceChildren();
    if (it && S.view === "podcasts") refreshPodRow(it);
  }

  function podUi() {
    $("pb-play").innerHTML = Pod.playing ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>';
    $("pb-play").setAttribute("aria-label", Pod.playing ? "Pause" : "Play");
    $("pb-time").textContent = hms(Pod.time);
    $("pb-left").textContent = Pod.dur ? "-" + hms(Pod.dur - Pod.time) : "";
    if (!podDragging) $("pb-seek").value = Pod.dur ? Math.round(Pod.time / Pod.dur * 1000) : 0;
    $("pb-rate").textContent = Pod.rate + "×";
    const row = Pod.item && document.querySelector('.post.pod[data-key="' + CSS.escape(Pod.item.key) + '"] .podplay');
    if (row) { row.textContent = Pod.playing ? "❚❚" : "▶"; row.setAttribute("aria-label", Pod.playing ? "Pause" : "Play"); }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = Pod.playing ? "playing" : "paused";
    tellApp();
  }

  // In the Android app: a media notification (and lock-screen / headphone controls) while the player is open,
  // which also keeps the app running so the episode plays on with the screen off
  let toldApp = "";
  function tellApp() {
    const app = window.ReaderApp;
    if (!app) return;
    const f = Pod.item ? feedById(Pod.item.feedId) : null;
    const state = JSON.stringify([!!Pod.item, Pod.playing, Pod.item ? Pod.item.key : ""]);
    if (state === toldApp) return;
    toldApp = state;
    try {
      if (app.mediaState) app.mediaState(!!Pod.item, Pod.playing, Pod.item ? Pod.item.title : "", f ? f.title : "");
      else app.setPlaying(Pod.playing, Pod.item ? Pod.item.title : "", f ? f.title : "");
    } catch (e) { /* older app */ }
  }

  // The app's notification and headphone buttons
  window.ReaderPod = { toggle: () => podToggle(), back: () => podSeek(Pod.time - 15), fwd: () => podSeek(Pod.time + 30) };


  // Lock screen / headphone controls (audio mode)
  function mediaSession(it) {
    if (!("mediaSession" in navigator)) return;
    const f = feedById(it.feedId) || { title: "" };
    navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: f.title, artwork: it.image ? [{ src: it.image, sizes: "480x360" }] : [] });
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
    set("play", () => podToggle());
    set("pause", () => podToggle());
    set("seekbackward", () => podSeek(Pod.time - 15));
    set("seekforward", () => podSeek(Pod.time + 30));
    set("seekto", (d) => podSeek(d.seekTime));
  }

  let podDragging = false;
  $("pb-play").onclick = podToggle;
  $("pb-back").onclick = () => podSeek(Pod.time - 15);
  $("pb-fwd").onclick = () => podSeek(Pod.time + 30);
  $("pb-rate").onclick = () => {
    Pod.rate = RATES[(RATES.indexOf(Pod.rate) + 1) % RATES.length];
    if (Pod.media) Pod.media.playbackRate = Pod.rate;
    if (Pod.mode === "yt") ytCommand("setPlaybackRate", [Pod.rate]);
    podUi();
  };
  $("pb-close").onclick = () => { podStop(); podUi(); $("podbar").hidden = true; document.body.classList.remove("podding"); };
  $("pb-title").onclick = () => { if (Pod.item) openArticle(Pod.item.key); };
  $("pb-seek").addEventListener("input", () => { podDragging = true; if (Pod.dur) $("pb-time").textContent = hms($("pb-seek").value / 1000 * Pod.dur); });
  $("pb-seek").addEventListener("change", () => { podDragging = false; if (Pod.dur) podSeek($("pb-seek").value / 1000 * Pod.dur); });

  // ---------- Reposted X accounts ----------
  // The feed only names a repost's original account by @handle. Its name and picture come from that account's
  // own Nitter feed: looked up once, all at once, and kept for a week (a failed lookup is retried after a day).
  const XP = new Map();          // handle (lower case) -> { name, icon, at, failed }
  const xpWanted = new Set();
  let xpTimer = 0, xpBusy = false;
  const repostOf = (it) => { const m = /^RT @([A-Za-z0-9_]{1,15})/.exec(it.title || "") || /^@([A-Za-z0-9_]{1,15})$/.exec(it.author || ""); return m ? m[1] : ""; };
  const repostFeed = (handle, prof) => ({ title: prof && prof.name ? prof.name : handle, icon: prof && prof.icon, siteUrl: "https://x.com/" + handle, url: "https://x.com/" + handle });

  function xProfile(handle) {
    const p = XP.get(handle.toLowerCase());
    const fresh = p && Date.now() - p.at < (p.failed ? 86400000 : 7 * 86400000);
    if (!fresh) { xpWanted.add(handle); clearTimeout(xpTimer); xpTimer = setTimeout(lookupProfiles, 300); }
    return p && !p.failed ? p : null;
  }

  // A quoted post, framed like on X: its account (picture, name, @handle), text and picture or video.
  // The whole card opens the quoted post on X.
  function quoteEl(it, full) {
    const q = it.quote;
    const card = el("div", "quote" + (full ? " full" : ""));
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "Open the quoted post");
    const prof = q.handle ? xProfile(q.handle) : null;
    const head = el("div", "qhead");
    if (q.handle) head.dataset.xh = q.handle;
    head.append(avatar(repostFeed(q.handle, prof && prof.icon ? { ...prof, name: q.name || prof.name } : { name: q.name || q.handle }), "qav"),
      el("b", null, q.name || (prof && prof.name) || "@" + q.handle), el("span", null, "@" + q.handle));
    card.append(head);
    const text = Parse.plain(q.html, full ? 2000 : 400);
    if (text) card.append(el("p", "qtext", text));
    if (q.image) {
      const box = el("div", "qmedia");
      const img = el("img"); img.src = q.image; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      // A video keeps its box and ▶ even if the thumbnail doesn't load; a picture that fails goes
      img.onerror = () => { if (q.video) img.remove(); else box.remove(); };
      box.append(img);
      if (q.video) box.append(el("span", "play", "▶"));
      card.append(box);
    }
    return card;
  }

  // ---------- Hold-press on a reposted or quoted account: follow it, or block it ----------
  // Blocking hides that account's reposts and the posts quoting it, everywhere. Unblock from the menu.
  let holdTimer = 0, holdAt = null, heldUntil = 0, menuOpen = false;
  const xFollowed = (h) => S.feeds.find(f => f.x && f.x.toLowerCase() === h.toLowerCase());

  async function accountMenu(h) {
    if (menuOpen) return;
    menuOpen = true;
    heldUntil = Date.now() + 800;      // the click that ends the hold doesn't open the link
    const prof = xProfile(h), followed = xFollowed(h);
    const blocked = (S.settings.xBlocked || []).some(b => b.toLowerCase() === h.toLowerCase());
    const r = await ask({ title: prof && prof.name ? prof.name : "@" + h, text: "@" + h + (followed ? " · You follow this account" : ""),
      ok: followed ? "Open feed" : "Follow", extra: blocked ? "Unblock" : "Block" });
    menuOpen = false;
    if (r.action === "ok") {
      if (followed) return selectView("feed:" + followed.id);
      toast("Following @" + h + "…");
      try {
        const [found] = await lookupX(h);
        $("add-group").value = ""; $("add-podcast").checked = false;
        await addFeed(found.url, found.parsed, found.x);
      } catch (e) { toast(e.message || "Couldn't follow @" + h); }
    } else if (r.action === "extra") setBlocked(h, !blocked);
  }

  function setBlocked(h, on) {
    const list = (S.settings.xBlocked || []).filter(b => b.toLowerCase() !== h.toLowerCase());
    if (on) list.push(h);
    if (list.length) S.settings.xBlocked = list; else delete S.settings.xBlocked;
    saveSettings();
    applyBlocked();
    renderCounts();
    renderList(true);
    if (on) toast("Blocked @" + h + ": their reposts and quotes are hidden", "Undo", () => setBlocked(h, false));
    else toast("Unblocked @" + h);
  }

  const heldTarget = (e) => e.target.closest && e.target.closest("[data-xh]");
  document.addEventListener("pointerdown", (e) => {
    const t = heldTarget(e);
    clearTimeout(holdTimer);
    if (!t || e.button > 0) return;
    holdAt = { x: e.clientX, y: e.clientY };
    holdTimer = setTimeout(() => accountMenu(t.dataset.xh), 550);
  });
  document.addEventListener("pointermove", (e) => { if (holdAt && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 10) { clearTimeout(holdTimer); holdAt = null; } });
  for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { clearTimeout(holdTimer); holdAt = null; });
  // A long-press on a phone, or a right-click
  document.addEventListener("contextmenu", (e) => { const t = heldTarget(e); if (!t) return; e.preventDefault(); clearTimeout(holdTimer); accountMenu(t.dataset.xh); });
  document.addEventListener("click", (e) => { if (Date.now() < heldUntil && heldTarget(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

  // Blocked accounts, from the menu: untick to unblock
  function applyBlocked() { const n = (S.settings.xBlocked || []).length; $("blocked-btn").textContent = "Blocked accounts: " + (n || "None"); }
  $("blocked-btn").onclick = () => {
    const box = $("blocked-choices");
    box.textContent = "";
    const list = S.settings.xBlocked || [];
    $("blocked-none").hidden = !!list.length;
    for (const h of list) {
      const l = el("label", "check"), c = el("input");
      c.type = "checkbox"; c.value = h; c.checked = true;
      l.append(c, " @" + h);
      box.append(l);
    }
    $("blocked-dialog").showModal();
  };
  $("blocked-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const keep = [...$("blocked-choices").querySelectorAll("input:checked")].map(c => c.value);
    if (keep.length) S.settings.xBlocked = keep; else delete S.settings.xBlocked;
    saveSettings(); applyBlocked(); renderCounts(); renderList(true);
    $("blocked-dialog").close();
  });
  $("blocked-cancel").onclick = () => $("blocked-dialog").close();

  // The quoted post on its own, in the reading view: its account, full text, pictures, and its video playing
  // in BT Feeder's player. It's shown, never saved.
  function openQuote(parent) {
    const q = parent && parent.quote;
    if (!q) return;
    openArticle({
      virtual: true,
      key: "quote:" + (q.id || parent.key),
      feedId: parent.feedId,
      id: "x:" + q.id,
      title: Parse.plain(q.html, 90) || "@" + q.handle,
      link: q.id ? "https://x.com/" + q.handle + "/status/" + q.id : "https://x.com/" + q.handle,
      date: 0,
      author: "@" + q.handle,
      html: q.html,
      image: q.image,
      video: q.video && q.id ? { kind: "x", id: q.id } : null,
      read: true,
      quoteAuthor: { handle: q.handle, name: q.name }
    });
  }

  async function lookupProfiles() {
    if (xpBusy || !xpWanted.size) return;
    xpBusy = true;
    const handles = [...xpWanted].slice(0, 40);
    handles.forEach(h => xpWanted.delete(h));
    try {
      const hosts = await nitterHosts();
      const urls = handles.map((h, i) => "https://" + hosts[i % Math.min(3, hosts.length)] + "/" + h + "/rss");
      const results = await fetchBatch(urls);
      results.forEach((r, i) => {
        const parsed = r.ok && Parse.parseFeed(r.body, urls[i]);
        XP.set(handles[i].toLowerCase(), parsed ? { name: Parse.xName(parsed.title) || "@" + handles[i], icon: parsed.icon || "", at: Date.now() } : { failed: true, at: Date.now() });
      });
      Store.set("xprofiles", Object.fromEntries(XP));
      renderList(true);
    } catch (e) { /* offline: try again next time */ }
    finally { xpBusy = false; if (xpWanted.size) xpTimer = setTimeout(lookupProfiles, 300); }
  }

  // ---------- Views / navigation ----------

  function selectView(view) {
    S.view = view;
    S.current = null;
    document.body.classList.remove("reading");
    stopPlayer();
    $("article").textContent = "";
    markActiveNav();
    renderList();
    closeDrawer();
  }

  function openDrawer() {
    document.body.classList.add("drawer");
    if (!(history.state && history.state.drawer)) history.pushState({ drawer: true }, "");
  }

  function closeDrawer() {
    if (!document.body.classList.contains("drawer")) return;
    document.body.classList.remove("drawer");
    if (history.state && history.state.drawer) history.back();
  }

  addEventListener("popstate", () => {
    if (LB.closing) { LB.closing = false; return; }
    if (!$("lightbox").hidden) return closeLightbox(true);
    if (document.body.classList.contains("drawer")) { document.body.classList.remove("drawer"); return; }
    if (document.body.classList.contains("reading")) closeArticle();
  });

  // ---------- Dialogs ----------

  function openAddDialog() {
    closeDrawer();
    $("add-url").value = "";
    $("add-group").value = S.view.startsWith("group:") ? S.view.slice(6) : S.view === "groups" ? currentGroup() : "";
    $("add-podcast").checked = S.view === "podcasts";
    $("add-pod-row").hidden = S.view !== "podcasts";
    addState.input = "";
    addState.found = null;
    showAddResults();
    addMessage("");
    $("add-submit").disabled = false;
    $("add-submit").textContent = "Follow";
    $("add-dialog").showModal();
    $("add-url").focus();
  }

  // Look for feeds while the person types, and list the ones that really exist
  const addState = { input: "", found: null, seq: 0, timer: 0 };

  function addMessage(msg, isError) {
    const m = $("add-error");
    m.hidden = !msg;
    m.textContent = msg || "";
    m.classList.toggle("error", !!isError);
    m.classList.toggle("hint", !isError);
  }

  async function search(input) {
    const seq = ++addState.seq;
    addState.input = input;
    addState.found = null;
    addMessage("Looking for feeds…");
    showAddResults();
    try {
      const found = await findFeeds(input);
      if (seq !== addState.seq) return null;
      addState.found = found;
      addMessage(found.length > 1 ? "Found " + found.length + " feeds. Pick one:" : "");
      showAddResults();
      return found;
    } catch (err) {
      if (seq !== addState.seq) return null;
      addMessage(err.message, true);
      return null;
    }
  }

  function showAddResults() {
    const ul = $("add-results");
    ul.textContent = "";
    for (const r of addState.found || []) {
      const p = r.parsed;
      const li = el("li");
      const b = el("button", "result");
      b.type = "button";
      const subscribed = !!subscribedTo(r.url, p);
      const latest = p.items.reduce((m, i) => Math.max(m, i.date || 0), 0);
      const info = [p.items.length + (p.items.length === 1 ? " item" : " items"), latest ? "latest " + ago(latest) + (ago(latest) === "now" ? "" : " ago") : ""].filter(Boolean).join(" · ");
      b.append(el("b", null, p.title || host(r.url)), el("span", "url", r.x ? "x.com/" + r.x + " · via " + host(r.url) : r.url.replace(/^https?:\/\//, "")), el("span", "info", subscribed ? "Already subscribed" : info));
      b.disabled = subscribed;
      b.onclick = () => subscribe(r);
      li.append(b);
      ul.append(li);
    }
    ul.hidden = !ul.children.length;
  }

  async function subscribe(r) {
    try {
      await addFeed(r.url, r.parsed, r.x);
      $("add-dialog").close();
    } catch (err) {
      addMessage(err.message, true);
    }
  }

  $("add-url").addEventListener("input", () => {
    // The podcast option is offered for YouTube addresses (and always in Podcasts)
    $("add-pod-row").hidden = !(S.view === "podcasts" || /youtu\.?be|youtube\.com/i.test($("add-url").value));
    clearTimeout(addState.timer);
    const v = $("add-url").value.trim();
    if (v === addState.input) return;
    addState.seq++;
    addState.found = null;
    showAddResults();
    addMessage("");
    if (looksLikeAddress(v)) addState.timer = setTimeout(() => search(v), 700);
  });
  // Fill in the scheme when the box loses focus, so "example.com" reads as an address
  $("add-url").addEventListener("blur", () => {
    const v = $("add-url").value.trim();
    if (v && !/^https?:\/\//i.test(v) && looksLikeAddress(v)) $("add-url").value = "https://" + v;
  });

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearTimeout(addState.timer);
    const v = $("add-url").value.trim();
    if (!v) return;
    const btn = $("add-submit");
    btn.disabled = true;
    btn.textContent = "Looking…";
    try {
      const strip = (x) => x.replace(/^https?:\/\//i, "");
      const shown = strip(v) === strip(addState.input) && addState.found;
      const found = shown || await search(v);
      if (!found) return;
      const pick = found.find(r => !subscribedTo(r.url, r.parsed));
      if (!pick) return addMessage("You're already subscribed to " + (found[0].parsed.title || "this feed") + ".", true);
      // Several feeds the person hasn't seen yet: they're listed now, let them choose
      if (found.length > 1 && !shown) return;
      await subscribe(pick);
    } finally {
      btn.disabled = false;
      btn.textContent = "Follow";
    }
  });
  $("add-cancel").onclick = () => $("add-dialog").close();

  let editing = null;
  function openFeedDialog(f) {
    editing = f;
    $("feed-name").value = f.title;
    $("feed-url").value = f.url;
    $("feed-group").value = f.group || "";
    $("feed-grouponly").checked = !!f.groupOnly;
    $("feed-grouponly-row").hidden = !f.group;
    const r = f.filters || {};
    $("flt-mute").value = r.mute || "";
    $("flt-only").value = r.only || "";
    $("flt-media").checked = !!r.mediaOnly;
    $("flt-reposts").checked = !!r.noReposts;
    $("flt-replies").checked = !!r.noReplies;
    $("flt-x").hidden = !f.x;
    $("pod-opts").hidden = !YT_FEED.test(f.url);
    $("feed-podcast").checked = !!f.podcast;
    $("feed-podmin").value = f.podMin || 60;
    $("feed-error").textContent = f.error ? "Last refresh: " + f.error : "";
    $("feed-error").hidden = !f.error;
    $("feed-dialog").showModal();
  }
  $("feed-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!editing) return $("feed-dialog").close();
    const name = $("feed-name").value.trim();
    if (name && name !== editing.title) { editing.title = name; editing.customTitle = true; }
    editing.group = $("feed-group").value.trim().replace(/\s+/g, " ");
    if (!editing.group) delete editing.group;
    if (editing.group && $("feed-grouponly").checked) editing.groupOnly = true; else delete editing.groupOnly;
    const filters = { mute: $("flt-mute").value.trim(), only: $("flt-only").value.trim(), mediaOnly: $("flt-media").checked,
      noReposts: !!editing.x && $("flt-reposts").checked, noReplies: !!editing.x && $("flt-replies").checked };
    if (hasFilters({ filters })) editing.filters = filters; else delete editing.filters;
    if (YT_FEED.test(editing.url)) {
      const wasPod = !!editing.podcast;
      if ($("feed-podcast").checked) { editing.podcast = true; editing.podMin = Math.max(1, Math.min(600, parseInt($("feed-podmin").value, 10) || 60)); }
      else { delete editing.podcast; delete editing.podMin; }
      if (!wasPod && editing.podcast) setTimeout(podDurations, 0);
    }
    S.feeds.sort((a, b) => a.title.localeCompare(b.title));
    saveFeeds();
    renderFeeds();
    renderList(true);
    $("feed-dialog").close();
  });
  $("feed-cancel").onclick = () => $("feed-dialog").close();
  // "Only show in its group" makes sense once the feed has a group
  $("feed-group").addEventListener("input", () => { $("feed-grouponly-row").hidden = !$("feed-group").value.trim(); });
  $("feed-delete").onclick = async () => {
    if (!editing) return;
    const f = editing;
    const r = await ask({ title: "Unsubscribe from " + f.title + "?", text: "Its saved posts (including starred ones) will be removed.", ok: "Unsubscribe", danger: true });
    if (r.action !== "ok") return;
    $("feed-dialog").close();
    await removeFeed(f.id);
    toast("Unsubscribed from " + f.title);
  };
  for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });

  // ---------- OPML ----------

  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const list = Parse.parseOpml(await file.text());
    if (!list) return toast("That file isn't valid OPML");
    const known = new Set(S.feeds.map(f => f.url));
    const fresh = list.filter(f => !known.has(f.url) && known.add(f.url));
    if (!fresh.length) return toast("No new feeds in that file");
    const feeds = fresh.map(f => ({ id: uid(), url: f.url, title: f.title || host(f.url), siteUrl: f.siteUrl, added: Date.now(), lastFetch: 0, error: "", customTitle: !!f.title, ...(f.group ? { group: f.group } : {}) }));
    S.feeds.push(...feeds);
    S.feeds.sort((a, b) => a.title.localeCompare(b.title));
    await saveFeeds();
    closeDrawer();
    renderFeeds();
    renderList();
    toast("Imported " + feeds.length + " feed" + (feeds.length === 1 ? "" : "s"));
    refresh(feeds);
  };

  $("export-btn").onclick = () => {
    if (!S.feeds.length) return toast("No feeds to export yet");
    // In the Android app, the app saves it to Downloads (its web view can't download files itself)
    if (window.ReaderApp) return window.ReaderApp.saveFile("reader-subscriptions.opml", "text/x-opml", Parse.buildOpml(S.feeds));
    const blob = new Blob([Parse.buildOpml(S.feeds)], { type: "text/x-opml" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "reader-subscriptions.opml";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  function applyShorts() { $("shorts-btn").textContent = "Shorts: " + (S.settings.hideShorts ? "Hidden" : "Shown"); }
  $("shorts-btn").onclick = () => {
    S.settings.hideShorts = !S.settings.hideShorts;
    applyShorts();
    saveSettings();
    renderCounts();
    renderList(true);
  };

  // ---------- Theme ----------

  const THEMES = ["system", "light", "dark"];
  function applyTheme() {
    const t = S.settings.theme;
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = t;
    $("theme-btn").textContent = "Theme: " + t.charAt(0).toUpperCase() + t.slice(1);
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? "#0a0a16" : "#eef0fa";
  }
  $("theme-btn").onclick = () => {
    S.settings.theme = THEMES[(THEMES.indexOf(S.settings.theme) + 1) % THEMES.length];
    applyTheme();
    saveSettings();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // ---------- Status and toasts ----------

  function status(msg, isError) {
    const s = $("status");
    s.hidden = !msg;
    s.textContent = msg || "";
    s.classList.toggle("error", !!isError);
  }

  // BT Feeder's own question dialog, instead of the browser's prompt() / confirm() boxes.
  // ask({ title, text, input, placeholder, ok, extra, danger }) → { action: "ok" | "extra" | "cancel", value }
  function ask(o) {
    return new Promise((resolve) => {
      const d = $("ask-dialog"), inp = $("ask-input"), extra = $("ask-extra");
      $("ask-title").textContent = o.title || "";
      $("ask-text").textContent = o.text || "";
      $("ask-text").hidden = !o.text;
      inp.hidden = o.input == null;
      inp.value = o.input || "";
      inp.placeholder = o.placeholder || "";
      $("ask-ok").textContent = o.ok || "OK";
      $("ask-ok").classList.toggle("danger-fill", !!o.danger);
      extra.hidden = !o.extra;
      extra.textContent = o.extra || "";
      let done = false;
      const finish = (action) => {
        if (done) return;
        done = true;
        $("ask-form").removeEventListener("submit", onSubmit);
        d.removeEventListener("close", onClose);
        if (d.open) d.close();
        resolve({ action, value: inp.value.trim() });
      };
      const onSubmit = (e) => { e.preventDefault(); finish("ok"); };
      // (A "closed" notice left over from the previous question arrives while this one is open: ignore it)
      const onClose = () => { if (!d.open) finish("cancel"); };
      $("ask-form").addEventListener("submit", onSubmit);
      d.addEventListener("close", onClose);
      $("ask-cancel").onclick = () => finish("cancel");
      extra.onclick = () => finish("extra");
      d.showModal();
      if (!inp.hidden) setTimeout(() => { inp.focus(); inp.select(); }, 0);
    });
  }

  let toastTimer = 0;
  function toast(msg, action, onAction) {
    const t = $("toast");
    t.textContent = msg;
    if (action) {
      const b = el("button", null, action);
      b.onclick = () => { onAction(); t.classList.remove("show"); };
      t.append(b);
    }
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 3000);
  }

  // ---------- Events ----------

  document.querySelector(".views").addEventListener("click", (e) => { const b = e.target.closest(".nav"); if (b) selectView(b.dataset.view); });
  $("feeds").addEventListener("click", (e) => { const b = e.target.closest(".nav"); if (b) selectView(b.dataset.view); });
  $("items").addEventListener("click", (e) => {
    const li = e.target.closest(".post");
    if (!li) return;
    const it = S.items.get(li.dataset.key);
    if (!it) return;
    if (li.classList.contains("pod")) {
      const goto = e.target.closest("[data-view]");
      if (goto) return selectView(goto.dataset.view);
      if (e.target.closest(".podnotes")) return openArticle(it.key);
      return podPlay(it);
    }
    if (e.target.closest(".quote")) return openQuote(it);
    if (e.target.closest("a, .player")) return;   // links and the player handle themselves
    const goto = e.target.closest("[data-view]");
    if (goto) return selectView(goto.dataset.view);
    const act = e.target.closest(".pact");
    if (act) {
      if (act.classList.contains("star")) setStar(it, !it.star);
      else if (act.classList.contains("read")) setRead(it, !it.read);
      else if (act.classList.contains("share")) share(it);
      return;
    }
    const cell = e.target.closest(".pgallery .cell");
    if (cell) return openLightbox(gallery(it), +cell.dataset.i);
    if (e.target.closest(".pmedia.playable, .pmedia.audio")) return playInline(li, it);
    openArticle(it.key);
  });
  $("top").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) selectView(b.dataset.view); });
  $("items").addEventListener("keydown", (e) => { const li = e.target.closest(".post"); if (li && e.key === "Enter") openArticle(li.dataset.key); });
  $("add-btn").onclick = openAddDialog;
  $("menu-btn").onclick = openDrawer;
  $("scrim").onclick = closeDrawer;
  function refreshView() {
    const feeds = S.view.startsWith("feed:") ? [feedById(S.view.slice(5))].filter(Boolean) : S.view === "groups" ? groupFeeds(currentGroup()) : S.view.startsWith("group:") ? groupFeeds(S.view.slice(6)) : S.view === "podcasts" ? S.feeds.filter(f => f.podcast) : S.feeds;
    if (!feeds.length) { endPull(); return openAddDialog(); }
    refresh(feeds);
  }

  // ---------- Pull to refresh (touch: pull down at the top; mouse / trackpad: keep scrolling up at the top) ----------
  const PULL_AT = 64;
  let pull = null, wheelPull = 0, wheelTimer = 0;
  function setPull(px, settle) {
    const ptr = $("ptr");
    ptr.classList.toggle("settle", !!settle);
    ptr.style.transform = "translate(-50%, " + (px - 48) + "px) rotate(" + (px * 4) + "deg)";
    ptr.style.opacity = Math.min(1, px / PULL_AT);
    ptr.classList.toggle("ready", px >= PULL_AT);
  }
  function startPullRefresh() {
    $("ptr").classList.add("spinning");
    setPull(PULL_AT - 8, true);
    refreshView();
  }
  function endPull() { $("ptr").classList.remove("spinning", "ready"); setPull(0, true); }
  const tl = $("timeline");
  tl.addEventListener("touchstart", (e) => { pull = tl.scrollTop <= 0 && !S.refreshing ? { y: e.touches[0].clientY, d: 0 } : null; }, { passive: true });
  tl.addEventListener("touchmove", (e) => {
    if (!pull) return;
    const d = e.touches[0].clientY - pull.y;
    if (d <= 0 || tl.scrollTop > 0) { pull.d = 0; setPull(0); return; }
    pull.d = Math.min(d * 0.5, 100);
    setPull(pull.d);
  }, { passive: true });
  tl.addEventListener("touchend", () => {
    if (!pull) return;
    const go = pull.d >= PULL_AT;
    pull = null;
    if (go) startPullRefresh(); else setPull(0, true);
  });
  tl.addEventListener("wheel", (e) => {
    if (tl.scrollTop > 0 || e.deltaY >= 0 || S.refreshing) { wheelPull = 0; return; }
    wheelPull = Math.min(wheelPull + Math.min(-e.deltaY, 60) * 0.35, 100);
    setPull(wheelPull);
    clearTimeout(wheelTimer);
    if (wheelPull >= 100) { wheelPull = 0; startPullRefresh(); return; }
    wheelTimer = setTimeout(() => { wheelPull = 0; if (!S.refreshing) setPull(0, true); }, 350);
  }, { passive: true });

  // ---------- Read on scroll: a post you've seen and scrolled past counts as read ----------
  const onScreen = new Set();
  const readObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const key = e.target.dataset.key;
      // A post taken off the page (the timeline was redrawn) reports itself as gone: that's not scrolling past
      if (!e.target.isConnected) continue;
      if (e.isIntersecting) { onScreen.add(key); continue; }
      if (!onScreen.has(key) || !S.settings.markOnScroll || !e.rootBounds) continue;
      // Gone off the top (scrolled past), not off the bottom
      if (e.boundingClientRect.bottom <= e.rootBounds.top + 2) setRead(S.items.get(key), true);
    }
  }, { root: $("timeline"), threshold: 0 });

  function applyPreviews() { $("previews-btn").textContent = "Previews: " + (S.settings.previews ? "On" : "Off"); }
  $("previews-btn").onclick = () => { S.settings.previews = !S.settings.previews; saveSettings(); applyPreviews(); renderList(true); };

  function applyScrollRead() { $("scrollread-btn").textContent = "Read on scroll: " + (S.settings.markOnScroll ? "On" : "Off"); }
  $("scrollread-btn").onclick = () => { S.settings.markOnScroll = !S.settings.markOnScroll; saveSettings(); applyScrollRead(); };
  $("clear-btn").onclick = markAllRead;
  $("add-top").onclick = () => openAddDialog();
  $("unread-btn").onclick = () => { S.settings.unreadOnly = !S.settings.unreadOnly; saveSettings(); renderList(); };
  $("back-btn").onclick = () => { if (history.state && history.state.article) history.back(); else closeArticle(); };
  $("star-btn").onclick = () => { const it = S.items.get(S.current); if (it) setStar(it, !it.star); };
  $("read-btn").onclick = () => { const it = S.items.get(S.current); if (it) setRead(it, !it.read); };

  function showSearch(on) {
    $("search-box").hidden = !on;
    $("search-btn").setAttribute("aria-pressed", on);
    if (on) { $("timeline").scrollTop = 0; $("search").focus(); }
    else if (S.query) { $("search").value = ""; S.query = ""; renderList(); }
  }
  $("search-btn").onclick = () => showSearch($("search-box").hidden);
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.view) { if (b.dataset.view === S.view) $("timeline").scrollTo({ top: 0, behavior: "smooth" }); else selectView(b.dataset.view); }
    else if (b.id === "tab-clear") markAllRead();
    else if (b.id === "tab-feeds") openDrawer();
  });

  let searchTimer = 0;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.query = e.target.value.trim(); renderList(); }, 150);
  });

  document.addEventListener("keydown", (e) => {
    if (!$("lightbox").hidden) {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") stepLightbox(-1);
      else if (e.key === "ArrowRight") stepLightbox(1);
      return;
    }
    if (e.target.closest("input, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === "Escape" && e.target.id === "search") { showSearch(false); e.target.blur(); }
      return;
    }
    const it = S.items.get(S.current);
    switch (e.key) {
      case "j": case "ArrowDown": if (e.key === "j" || document.body.classList.contains("reading")) { step(1); e.preventDefault(); } break;
      case "k": case "ArrowUp": if (e.key === "k" || document.body.classList.contains("reading")) { step(-1); e.preventDefault(); } break;
      case "s": if (it) setStar(it, !it.star); break;
      case "m": if (it) setRead(it, !it.read); break;
      case "o": case "v": if (it && it.link) window.open(it.link, "_blank", "noopener"); break;
      case "r": refreshView(); break;
      case "a": openAddDialog(); e.preventDefault(); break;
      case "/": showSearch(true); e.preventDefault(); break;
      case "Escape": if (document.body.classList.contains("drawer")) closeDrawer(); else if (document.body.classList.contains("reading")) $("back-btn").click(); break;
    }
  });

  // Coming back to the app after a while counts as opening it again
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshStale(); });

  // ---------- Start ----------

  // X posts saved before video support don't know they're videos: work it out from their saved text
  function upgradeSaved() {
    for (const f of S.feeds) {
      if (!f.x) continue;
      const quoted = [...S.items.values()].filter(it => it.feedId === f.id && !it.quote && /<hr\s*\/?>\s*<blockquote>/i.test(it.html || ""));
      if (!quoted.length) continue;
      Parse.xify({ items: quoted }, f.x);
      saveItems(quoted);
    }
    let renamed = false;
    for (const f of S.feeds) {
      if (f.x && !f.customTitle && Parse.xName(f.title) && Parse.xName(f.title) !== f.title) { f.title = Parse.xName(f.title); renamed = true; }
    }
    if (renamed) { S.feeds.sort((a, b) => a.title.localeCompare(b.title)); saveFeeds(); }
    for (const f of S.feeds) {
      if (!f.x) continue;
      const old = [...S.items.values()].filter(it => it.feedId === f.id && !it.video && /(Video|Gif)\s*(<br>\s*)?<img|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb/i.test(it.html || ""));
      if (!old.length) continue;
      Parse.xify({ items: old }, f.x);
      saveItems(old);
    }
  }

  // What the account / sync module (account.js) can see and change
  const accountApi = {
    getFeeds: () => S.feeds,
    getSettings: () => S.settings,
    getItems: () => S.items,
    async setFeeds(list, removedIds) {
      for (const id of removedIds || []) {
        const keys = [...S.items.values()].filter(i => i.feedId === id).map(i => i.key);
        keys.forEach(k => S.items.delete(k));
        await Store.deleteItems(keys);
        if (S.view === "feed:" + id) S.view = "all";
      }
      S.feeds = list.sort((a, b) => a.title.localeCompare(b.title));
      await saveFeeds();
      renderFeeds();
      renderList(true);
    },
    async setSettings(s) {
      S.settings = s;
      await saveSettings();
      applyTheme(); applyShorts(); applyScrollRead(); applyPreviews(); applyInvidious(); applyYtKey(); applyBlocked();
      renderCounts();
      renderList(true);
    },
    // A feed already in the account under another id: move this device's posts over to that id
    async remapFeed(oldId, newId) {
      const f = feedById(oldId);
      if (!f) return;
      const moved = [], oldKeys = [];
      for (const it of [...S.items.values()]) {
        if (it.feedId !== oldId) continue;
        oldKeys.push(it.key);
        S.items.delete(it.key);
        const n = { ...it, feedId: newId, key: newId + "|" + (it.id || it.link) };
        S.items.set(n.key, n);
        moved.push(n);
      }
      f.id = newId;
      if (S.view === "feed:" + oldId) S.view = "feed:" + newId;
      await Store.deleteItems(oldKeys);
      await saveItems(moved);
    },
    // A star added or removed on another device
    applyStar(key, star, data) {
      let it = S.items.get(key);
      if (!it && star && data) {
        it = { ...data, read: true, readAt: 0, star: true, seen: Date.now(), pos: 0, dur: 0, watched: false };
        delete it.starredAt;
        S.items.set(key, it);
        saveItems([it]);
        if (S.view === "starred") renderList(true);
        renderCounts();
        return;
      }
      if (it && it.star !== star) { setStar(it, star); if (S.view === "starred") renderList(true); }
    },
    // Read marks from another device
    itemsUpdated(list) {
      saveItems(list);
      for (const it of list) {
        const row = document.querySelector('.post[data-key="' + CSS.escape(it.key) + '"]');
        if (row) row.classList.toggle("unread", !it.read);
      }
      renderFeeds();
    },
    refresh: (feeds) => refresh(feeds, { quiet: true }),
    toast, el, closeDrawer
  };

  async function start() {
    try {
      const [feeds, settings, items] = await Promise.all([Store.get("feeds"), Store.get("settings"), Store.allItems()]);
      S.feeds = feeds || [];
      S.settings = { ...S.settings, ...(settings || {}) };
      // Settings saved before "read posts leave on refresh" existed: turn the new behaviour on once
      if ((S.settings.v || 0) < 2) { S.settings.unreadOnly = true; S.settings.markOnScroll = true; S.settings.v = 2; saveSettings(); }
      // Once: re-read X accounts, so posts saved before quotes were understood get their quote (and its video)
      if ((S.settings.v || 0) < 3) { S.settings.v = 3; saveSettings(); for (const f of feeds || []) if (f.x) f.lastFetch = 0; }
      for (const it of items) S.items.set(it.key, it);
      for (const [k, v] of Object.entries((await Store.get("xprofiles")) || {})) XP.set(k, v);
      upgradeSaved();
    } catch (e) {
      status("This browser won't let BT Feeder save anything (private mode?). Feeds will be forgotten when you close it.", true);
    }
    applyTheme();
    applyShorts();
    applyScrollRead();
    applyPreviews();
    applyBlocked();
    applyInvidious();
    applyYtKey();
    renderFeeds();
    renderList();
    podDurations();
    refreshStale();
    Account.init(accountApi);
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  start();
})();
