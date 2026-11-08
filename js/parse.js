// Feed parsing (RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed), feed discovery on web pages, and HTML cleaning.
// Everything here is pure: text in, plain objects out.

const Parse = (() => {
  // Children / descendants by local name, ignoring XML namespaces (content:encoded, media:thumbnail, ...)
  const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const text = (el) => el ? el.textContent.trim() : "";
  const findDeep = (el, name) => {
    if (!el) return null;
    for (const d of el.getElementsByTagName("*")) if (d.localName === name) return d;
    return null;
  };

  function absolute(url, base) {
    if (!url) return "";
    try { return new URL(url.trim(), base || undefined).href; } catch (e) { return ""; }
  }

  function parseDate(s) {
    if (!s) return 0;
    const t = Date.parse(s.trim());
    return isNaN(t) ? 0 : t;
  }

  function decodeEntities(s) {
    if (!s || !/[&<]/.test(s)) return s || "";
    const d = new DOMParser().parseFromString("<!doctype html><body>" + s, "text/html");
    return d.body.textContent || "";
  }

  // Plain text of an HTML fragment, for titles and list snippets
  function plain(html, max) {
    const t = decodeEntities(String(html || "").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return max && t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
  }

  // ---- Feeds ----

  // Returns { title, siteUrl, items: [{ id, title, link, date, author, html, image }] } or null if this isn't a feed.
  function parseFeed(body, baseUrl) {
    const trimmed = (body || "").replace(/^\uFEFF/, "").trim();
    if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, baseUrl);
    // A web page, not a feed (parsing it as XML would only produce an error)
    if (!trimmed.startsWith("<") || /^<(!doctype\s+html|html[\s>])/i.test(trimmed)) return null;
    const doc = new DOMParser().parseFromString(trimmed, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    const root = doc.documentElement;
    if (root.localName === "feed") return parseAtom(root, baseUrl);
    if (root.localName === "rss" || root.localName === "RDF") return parseRss(root, baseUrl);
    return null;
  }

  function parseRss(root, baseUrl) {
    const channel = kid(root, "channel");
    // RSS 2.0 keeps items inside <channel>; RSS 1.0 (RDF) puts them next to it
    const items = kids(channel, "item").length ? kids(channel, "item") : kids(root, "item");
    const siteUrl = absolute(linkText(channel), baseUrl);
    const base = siteUrl || baseUrl;
    const img = kid(channel, "image") || kid(root, "image");
    return {
      title: plain(text(kid(channel, "title"))),
      siteUrl,
      icon: absolute(text(kid(img, "url")) || (img && img.getAttribute("href")) || "", base),
      items: items.map(it => {
        const link = absolute(linkText(it) || linkFromGuid(it), base);
        const html = text(kid(it, "encoded")) || text(kid(it, "description")) || text(findDeep(it, "description"));
        return {
          id: text(kid(it, "guid")) || it.getAttribute("rdf:about") || link || text(kid(it, "title")),
          title: plain(text(kid(it, "title"))) || plain(html, 90) || "(untitled)",
          link,
          date: parseDate(text(kid(it, "pubDate")) || text(kid(it, "date")) || text(kid(it, "updated"))),
          author: plain(text(kid(it, "creator")) || text(kid(it, "author"))),
          html,
          image: imageOf(it, html, link),
          video: videoOf(it, link, base)
        };
      })
    };
  }

  // RSS <link> holds its URL as text; skip <atom:link href="..."/> self-links that often sit beside it
  function linkText(el) {
    const l = kids(el, "link").find(l => text(l));
    return l ? text(l) : "";
  }

  function linkFromGuid(it) {
    const g = kid(it, "guid");
    return g && g.getAttribute("isPermaLink") !== "false" && /^https?:/.test(text(g)) ? text(g) : "";
  }

  function parseAtom(root, baseUrl) {
    const pickLink = (el) => {
      const links = kids(el, "link");
      const l = links.find(l => (l.getAttribute("rel") || "alternate") === "alternate" && (!l.getAttribute("type") || /html/.test(l.getAttribute("type")))) ||
                links.find(l => (l.getAttribute("rel") || "alternate") === "alternate") || links[0];
      return l ? l.getAttribute("href") : "";
    };
    const siteUrl = absolute(pickLink(root), baseUrl);
    const base = siteUrl || baseUrl;
    return {
      title: plain(atomText(kid(root, "title"))),
      siteUrl,
      icon: absolute(text(kid(root, "icon")) || text(kid(root, "logo")), base),
      logo: absolute(text(kid(root, "logo")), base),
      items: kids(root, "entry").map(e => {
        const link = absolute(pickLink(e), base);
        const video = videoOf(e, link, base);
        const html = atomText(kid(e, "content")) || atomText(kid(e, "summary")) ||
          (video && video.kind === "youtube" ? textToHtml(text(findDeep(e, "description"))) : text(findDeep(e, "description")));
        return {
          id: text(kid(e, "id")) || link || text(kid(e, "title")),
          title: plain(atomText(kid(e, "title"))) || plain(html, 90) || "(untitled)",
          link,
          date: parseDate(text(kid(e, "published")) || text(kid(e, "updated")) || text(kid(e, "issued"))),
          author: plain(text(kid(kid(e, "author"), "name")) || text(kid(kid(root, "author"), "name"))),
          html,
          image: imageOf(e, html, link),
          video
        };
      })
    };
  }

  // Atom text constructs: type="xhtml" holds real markup, others hold (escaped) text or HTML
  function atomText(el) {
    if (!el) return "";
    if (el.getAttribute("type") === "xhtml") {
      const div = kid(el, "div") || el;
      return [...div.childNodes].map(n => new XMLSerializer().serializeToString(n)).join("").trim();
    }
    if (el.getAttribute("type") === "text") return escapeHtml(el.textContent.trim());
    return el.textContent.trim();
  }

  function parseJsonFeed(body, baseUrl) {
    let f;
    try { f = JSON.parse(body); } catch (e) { return null; }
    if (!f || !Array.isArray(f.items) || !/jsonfeed/.test(f.version || "")) return null;
    const siteUrl = absolute(f.home_page_url, baseUrl);
    return {
      title: plain(f.title || ""),
      siteUrl,
      icon: absolute(f.icon || f.favicon || "", siteUrl || baseUrl),
      items: f.items.map(i => {
        const html = i.content_html || (i.content_text ? escapeHtml(i.content_text).replace(/\n/g, "<br>") : "") || i.summary || "";
        const link = absolute(i.url || i.external_url, siteUrl || baseUrl);
        const author = (i.authors && i.authors[0] && i.authors[0].name) || (i.author && i.author.name) || "";
        return {
          id: String(i.id || link || i.title || ""),
          title: plain(i.title || "") || plain(html, 90) || "(untitled)",
          link,
          date: parseDate(i.date_published || i.date_modified),
          author: plain(author),
          html,
          image: absolute(i.image || i.banner_image, link) || firstImage(html, link),
          video: youtubeVideo(link) || mediaFile((i.attachments || []).map(a => ({ url: absolute(a.url, link), type: a.mime_type || "" })))
        };
      })
    };
  }

  // ---- Video and audio ----

  // { kind: "youtube", id, short } for YouTube videos; { kind: "file", url, type, audio } for video/audio
  // attached to a post (podcasts, video blogs); null otherwise.
  function videoOf(el, link, base) {
    const ytId = text(kid(el, "videoId"));
    if (/^[\w-]{11}$/.test(ytId)) return { kind: "youtube", id: ytId, short: /\/shorts\//.test(link) };
    const yt = youtubeVideo(link);
    if (yt) return yt;
    const files = [];
    for (const e of kids(el, "enclosure")) files.push({ url: absolute(e.getAttribute("url"), base), type: e.getAttribute("type") || "" });
    for (const d of el.getElementsByTagName("*")) {
      if (d.localName === "content" && d.namespaceURI && /mrss|media/.test(d.namespaceURI) && d.getAttribute("url"))
        files.push({ url: absolute(d.getAttribute("url"), base), type: d.getAttribute("type") || (d.getAttribute("medium") === "video" ? "video/mp4" : d.getAttribute("medium") === "audio" ? "audio/mpeg" : "") });
    }
    return mediaFile(files);
  }

  function mediaFile(files) {
    const f = files.find(f => /^https?:/.test(f.url) && /^(video|audio)\//.test(f.type)) ||
              files.find(f => /^https?:/.test(f.url) && /\.(mp4|m4v|webm|mov|mp3|m4a|aac|ogg|oga|opus|wav)(\?|$)/i.test(f.url));
    if (!f) return null;
    const audio = /^audio\//.test(f.type) || (!/^video\//.test(f.type) && /\.(mp3|m4a|aac|ogg|oga|opus|wav)(\?|$)/i.test(f.url));
    return { kind: "file", url: f.url, type: f.type, audio };
  }

  // The video id in a YouTube watch / shorts / youtu.be / embed link
  function youtubeVideo(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    let id = "";
    if (h === "youtu.be") id = u.pathname.slice(1, 12);
    else if (h === "youtube.com" || h === "youtube-nocookie.com") {
      id = u.searchParams.get("v") || (/^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname) || [])[2] || "";
    }
    return /^[\w-]{11}$/.test(id) ? { kind: "youtube", id, short: /^\/shorts\//.test(u.pathname) } : null;
  }

  // Plain text (YouTube descriptions) to HTML: paragraphs, line breaks and clickable links
  function textToHtml(t) {
    if (!t) return "";
    return t.trim().split(/\n{2,}/).map(p =>
      "<p>" + escapeHtml(p).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, u => '<a href="' + u + '">' + u + "</a>").replace(/\n/g, "<br>") + "</p>"
    ).join("");
  }

  function imageOf(el, html, base) {
    for (const name of ["thumbnail", "content"]) {
      const m = [...el.getElementsByTagName("*")].find(d => d.localName === name && d.namespaceURI && /mrss|media/.test(d.namespaceURI) && d.getAttribute("url") &&
        (name === "thumbnail" || d.getAttribute("medium") === "image" || /^image\//.test(d.getAttribute("type") || "") || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(d.getAttribute("url"))));
      if (m) return absolute(m.getAttribute("url"), base);
    }
    const enc = kids(el, "enclosure").find(e => /^image\//.test(e.getAttribute("type") || ""));
    if (enc) return absolute(enc.getAttribute("url"), base);
    const itImg = kid(el, "image");
    if (itImg && itImg.getAttribute("href")) return absolute(itImg.getAttribute("href"), base);
    return firstImage(html, base);
  }

  // Every real picture in a post (skips tracking pixels, emoji, icons and avatars), in order, without repeats
  function images(html, base) {
    const out = [];
    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html || ""))) {
      const tag = m[0];
      const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!src) continue;
      const w = /\swidth\s*=\s*["']?(\d+)/i.exec(tag), h = /\sheight\s*=\s*["']?(\d+)/i.exec(tag);
      if ((w && +w[1] < 60) || (h && +h[1] < 60)) continue;
      if (/emoji|twemoji|smilies|feedburner|\/pixel|gravatar|avatar|\.svg(\?|$)|doubleclick|\bstats\./i.test(tag)) continue;
      const u = absolute(decodeEntities(src[1]), base);
      if (/^https?:/.test(u) && !out.includes(u)) out.push(u);
    }
    return out;
  }

  function firstImage(html, base) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || "");
    return m && !/^data:/.test(m[1]) ? absolute(decodeEntities(m[1]), base) : "";
  }

  // ---- Discovery: a web page that links to its feed(s) ----

  function discover(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const found = [...doc.querySelectorAll('link[rel~="alternate"][href]')]
      .filter(l => /(rss|atom|feed)\+?(xml|json)|application\/json/i.test(l.getAttribute("type") || ""))
      .map(l => absolute(l.getAttribute("href"), pageUrl))
      .filter(Boolean);
    // YouTube channel, video and handle pages name the channel even when there's no feed link
    if (/(^|\.)youtube\.com$/.test(hostOf(pageUrl))) {
      const m = /"externalId":"(UC[\w-]{22})"/.exec(html) || /itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/.exec(html) || /"channelId":"(UC[\w-]{22})"/.exec(html);
      if (m) found.push("https://www.youtube.com/feeds/videos.xml?channel_id=" + m[1]);
    }
    return [...new Set(found)];
  }

  // YouTube addresses whose feed is known without loading the page
  function youtubeFeed(url) {
    let u;
    try { u = new URL(url); } catch (e) { return ""; }
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return "";
    const ch = /^\/channel\/(UC[\w-]{22})/.exec(u.pathname);
    if (ch) return "https://www.youtube.com/feeds/videos.xml?channel_id=" + ch[1];
    const list = u.searchParams.get("list");
    if (list && (u.pathname === "/playlist" || !u.searchParams.get("v"))) return "https://www.youtube.com/feeds/videos.xml?playlist_id=" + encodeURIComponent(list);
    return "";
  }

  // ---- X / Twitter (read through Nitter servers, which serve any account as RSS) ----

  const X_RESERVED = new Set(["home", "explore", "search", "i", "settings", "notifications", "messages", "hashtag", "intent",
    "share", "compose", "login", "logout", "signup", "tos", "privacy", "about", "jobs", "download", "communities", "lists"]);

  // The account name in an x.com / twitter.com link (profile, post or media link), or ""
  function xUser(url) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url); } catch (e) { return ""; }
    if (!/^((www|mobile)\.)?(twitter|x)\.com$/i.test(u.hostname)) return "";
    const name = u.pathname.split("/")[1] || "";
    return /^[A-Za-z0-9_]{1,15}$/.test(name) && !X_RESERVED.has(name.toLowerCase()) ? name : "";
  }

  // A Nitter feed made server-independent: posts are keyed by their X post id and link to x.com,
  // so switching to another Nitter server later doesn't duplicate anything.
  // Nitter titles feeds "Name / @handle": keep just the name
  const xName = (title) => String(title || "").replace(/\s*\/\s*@[A-Za-z0-9_]{1,15}\s*$/, "").trim();

  function xify(parsed, user) {
    parsed.siteUrl = "https://x.com/" + user;
    if (parsed.title) parsed.title = xName(parsed.title) || parsed.title;
    for (const it of parsed.items) {
      const m = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(it.link || it.id || "");
      if (!m) continue;
      // Links inside the post point at the Nitter server; send them to t.co / x.com so they survive a server change
      const server = /^https?:\/\/([^/]+)\//.exec(it.link || "");
      if (server && it.html) {
        const origin = "https?://" + server[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/";
        it.html = it.html.replace(new RegExp(origin + "t\\.co/", "g"), "https://t.co/").replace(new RegExp(origin + "(?!pic/|video/)", "g"), "https://x.com/");
      }
      // A quoted post: Nitter appends it as <hr/><blockquote><b>Name (@handle)</b><p>…</p><footer>…/handle/status/ID</footer>
      // </blockquote>. Keep it apart, so the post's own text, pictures and video are only its own.
      const q = /<hr\s*\/?>\s*<blockquote>([\s\S]*?)<\/blockquote>\s*$/i.exec(it.html || "");
      if (q) {
        const inner = q[1];
        const who = /<b>([\s\S]*?)\s*\(@([A-Za-z0-9_]{1,15})\)\s*<\/b>/.exec(inner);
        const cite = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec((/<footer>([\s\S]*?)<\/footer>/i.exec(inner) || [])[1] || "");
        let qhtml = inner.replace(/<b>[\s\S]*?<\/b>/, "").replace(/<footer>[\s\S]*?<\/footer>/i, "").trim();
        const qvid = /<a[^>]*>\s*(?:<br>\s*)?(Video|Gif)\s*(?:<br>\s*)?(<img[^>]*>)\s*<\/a>/i.exec(qhtml);
        let qthumb = "";
        if (qvid) { qhtml = qhtml.replace(qvid[0], ""); qthumb = (/src="([^"]+)"/.exec(qvid[2]) || [])[1] || ""; }
        const qimgs = images(qhtml, "https://x.com/");
        it.quote = {
          name: who ? decodeEntities(who[1]).trim() : "",
          handle: who ? who[2] : cite ? cite[1] : "",
          id: cite ? cite[2] : "",
          html: qhtml,
          image: qthumb || qimgs[0] || "",
          video: !!qvid
        };
        it.html = it.html.slice(0, q.index);
        // The quote's picture or video belongs to the quote
        const savedImage = it.image;
        it.image = firstImage(it.html, it.link);
        if (it.video && it.video.kind === "x" && !/(Video|Gif)\s*(<br>\s*)?<img|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb/i.test(it.html)) {
          // Saved by an older Reader, which took the quote's video for the post's own (and dropped it from the
          // quote): give it back to the quote, with its thumbnail
          delete it.video;
          if (!it.quote.video && !it.quote.image) { it.quote.video = true; it.quote.image = savedImage || ""; }
        }
      }
      it.id = "x:" + m[2];
      it.link = "https://x.com/" + m[1] + "/status/" + m[2];
      // Nitter marks video / GIF posts with a linked thumbnail labelled "Video" or "Gif" (the feed has no video file):
      // play those with X's official embedded-post player, and drop the label from the text
      const vid = /<a[^>]*>\s*(?:<br>\s*)?(Video|Gif)\s*(?:<br>\s*)?(<img[^>]*>)\s*<\/a>/i.exec(it.html || "");
      if (vid || /(amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)/.test(it.html || "")) {
        it.video = { kind: "x", id: m[2] };
        if (vid) it.html = it.html.replace(vid[0], "");
        if (!it.image) { const t = /src="([^"]+)"/.exec(vid ? vid[2] : it.html); if (t) it.image = t[1]; }
      }
    }
    return parsed;
  }

  // ---- Reddit ----

  const isReddit = (u) => /(^|\.)reddit\.com$/i.test(hostOf(u));

  // The feed for any Reddit address: a subreddit (and its sorting, e.g. /top/?t=week), a user, a multireddit,
  // or a post (its subreddit). Also takes the shorthand "r/name" and "u/name". "" when it isn't Reddit.
  function redditFeed(input) {
    let s = String(input || "").trim();
    const short = /^\/?(r|u|user)\/([\w-]+)(\/.*)?$/i.exec(s);
    if (short) s = "https://www.reddit.com/" + (short[1].toLowerCase() === "r" ? "r/" : "user/") + short[2] + (short[3] || "");
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch (e) { return ""; }
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return "";
    let path = u.pathname.replace(/\/+$/, "");
    path = path.replace(/^\/u\//i, "/user/");
    // A post: follow its subreddit
    path = path.replace(/^(\/r\/[\w-]+)\/comments\/.*$/i, "$1");
    if (!/^\/(r|user)\/[\w-]+/i.test(path) && path !== "") return "";
    if (/\.rss$/.test(path)) path = path.replace(/\/?\.rss$/, "");
    const q = u.searchParams.get("t") ? "?t=" + encodeURIComponent(u.searchParams.get("t")) : "";
    // www.reddit.com answers Cloudflare; old.reddit.com refuses it
    return "https://www.reddit.com" + path + "/.rss" + q;
  }

  // Reddit's feed wraps each post in a layout table with "submitted by /u/… [link] [comments]".
  // Keep the post's own text, its picture (full size when it's an image post) and the link it shares.
  function redditify(parsed) {
    if (parsed.logo && !/redditstatic\.com\/icon/.test(parsed.logo)) parsed.icon = parsed.logo;
    for (const it of parsed.items) {
      const doc = new DOMParser().parseFromString("<!doctype html><body>" + (it.html || ""), "text/html");
      const self = doc.querySelector(".md");
      const out = self ? self.innerHTML.trim() : "";
      let shared = "";
      for (const a of doc.querySelectorAll("a")) if (a.textContent.trim() === "[link]") shared = a.getAttribute("href") || "";
      shared = absolute(shared, "https://www.reddit.com/");
      const thumb = doc.querySelector("td img");
      const thumbSrc = thumb ? absolute(thumb.getAttribute("src"), "https://www.reddit.com/") : "";
      let html = out;
      const isImage = /^https:\/\/(i\.redd\.it|i\.imgur\.com|preview\.redd\.it)\/[^?#]+\.(jpe?g|png|gif|webp)(\?|$)/i.test(shared);
      if (isImage) {
        it.image = shared;
        html += '<p><img src="' + escapeHtml(shared) + '"></p>';
      } else {
        const yt = youtubeVideo(shared);
        if (yt) it.video = yt;
        // Small thumbnails (Reddit's 140px ones) are left for the list; bigger previews are shown as the post's picture
        const small = /[?&]width=(\d+)/.exec(thumbSrc);
        if (thumbSrc && !(small && +small[1] < 300)) it.image = thumbSrc;
        else if (thumbSrc && !it.image) it.image = thumbSrc;
        if (shared && !isReddit(shared) && !yt) {
          const host = hostOf(shared).replace(/^www\./, "");
          html += '<p><a href="' + escapeHtml(shared) + '">' + escapeHtml(host) + " ↗</a></p>";
        }
        if (thumbSrc && !(small && +small[1] < 300) && !yt) html += '<p><img src="' + escapeHtml(thumbSrc) + '"></p>';
      }
      it.html = html;
      it.author = (it.author || "").replace(/^\/u\//, "u/");
    }
    return parsed;
  }

  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ""; } }

  // Places feeds usually live, tried when a page doesn't link to one. For example.com/blog/post it tries
  // under /blog/post, /blog and the site root, deepest first.
  function guesses(pageUrl) {
    const u = new URL(pageUrl);
    const parts = u.pathname.split("/").filter(Boolean).slice(0, 2);
    const dirs = [];
    for (let i = parts.length; i >= 0; i--) dirs.push(u.origin + (i ? "/" + parts.slice(0, i).join("/") : ""));
    const out = [];
    for (const d of dirs) for (const p of ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"]) out.push(d + p);
    // Blogger and Squarespace keep theirs elsewhere
    out.push(u.origin + "/feeds/posts/default", dirs[0] + "?format=rss");
    return [...new Set(out)].slice(0, 16);
  }

  // ---- HTML cleaning for article bodies ----

  const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button",
    "textarea", "select", "option", "link", "meta", "base", "noscript", "template", "svg", "math", "dialog"]);
  const URL_ATTRS = new Set(["href", "src", "poster", "cite"]);
  const KEEP_ATTRS = new Set(["href", "src", "srcset", "alt", "title", "width", "height", "colspan", "rowspan", "poster", "controls", "cite", "datetime", "start", "type"]);

  function sanitize(html, base) {
    // Inline styles are dropped anyway; removing them before parsing keeps the page's CSP from reporting them
    const stripped = String(html || "").replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const doc = new DOMParser().parseFromString("<!doctype html><body>" + stripped, "text/html");
    const walk = (node) => {
      for (const el of [...node.children]) {
        const tag = el.localName;
        if (DROP.has(tag)) { el.remove(); continue; }
        for (const a of [...el.attributes]) {
          const n = a.name.toLowerCase();
          if (!KEEP_ATTRS.has(n)) { el.removeAttribute(a.name); continue; }
          if (URL_ATTRS.has(n)) {
            const v = absolute(a.value, base);
            if (!/^(https?:|mailto:)/i.test(v)) el.removeAttribute(a.name); else el.setAttribute(a.name, v);
          }
          if (n === "srcset") {
            const v = a.value.split(",").map(s => {
              const [u, d] = s.trim().split(/\s+/);
              const abs = absolute(u, base);
              return /^https?:/i.test(abs) ? abs + (d ? " " + d : "") : "";
            }).filter(Boolean).join(", ");
            if (v) el.setAttribute("srcset", v); else el.removeAttribute("srcset");
          }
        }
        if (tag === "a") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
        if (tag === "img") {
          el.setAttribute("loading", "lazy"); el.setAttribute("decoding", "async"); el.setAttribute("referrerpolicy", "no-referrer");
          // Tracking pixels
          if (el.getAttribute("width") === "1" || el.getAttribute("height") === "1") { el.remove(); continue; }
        }
        if (tag === "video" || tag === "audio") el.setAttribute("controls", "");
        walk(el);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- OPML ----

  function parseOpml(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return [...doc.getElementsByTagName("outline")]
      .filter(o => o.getAttribute("xmlUrl"))
      .map(o => {
        // A feed inside a folder outline belongs to that group
        const parent = o.parentElement;
        const group = parent && parent.localName === "outline" && !parent.getAttribute("xmlUrl") ? (parent.getAttribute("title") || parent.getAttribute("text") || "").trim() : "";
        return {
          url: o.getAttribute("xmlUrl").trim(),
          title: o.getAttribute("title") || o.getAttribute("text") || "",
          siteUrl: o.getAttribute("htmlUrl") || "",
          group
        };
      });
  }

  function buildOpml(feeds) {
    const a = (s) => escapeHtml(s || "");
    const line = (f, pad) => pad + '<outline type="rss" text="' + a(f.title) + '" title="' + a(f.title) + '" xmlUrl="' + a(f.url) + '"' +
      (f.siteUrl ? ' htmlUrl="' + a(f.siteUrl) + '"' : "") + "/>";
    const groups = [...new Set(feeds.map(f => f.group).filter(Boolean))].sort((x, y) => x.localeCompare(y));
    const body = [
      ...feeds.filter(f => !f.group).map(f => line(f, "    ")),
      ...groups.map(g => '    <outline text="' + a(g) + '" title="' + a(g) + '">\n' + feeds.filter(f => f.group === g).map(f => line(f, "      ")).join("\n") + "\n    </outline>")
    ];
    return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Reader subscriptions</title><dateCreated>' +
      new Date().toUTCString() + "</dateCreated></head>\n  <body>\n" + body.join("\n") + "\n  </body>\n</opml>\n";
  }

  // The video (or GIF) of the post on a Nitter post page: a direct .mp4 on X's video server
  function nitterVideo(html) {
    // Only the markup matters: drop styles and scripts first (also keeps the page's CSP from reporting them)
    const bare = String(html || "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const doc = new DOMParser().parseFromString(bare, "text/html");
    const main = doc.querySelector(".main-tweet") || doc;
    const video = main.querySelector("video");
    if (!video) return null;
    const source = video.querySelector("source[src]");
    const src = (source && source.getAttribute("src")) || video.getAttribute("src") || video.getAttribute("data-url") || "";
    if (!/^https:\/\/video\.twimg\.com\/.+\.mp4(\?|$)/.test(src)) return null;
    return { src, gif: video.classList.contains("gif") };
  }

  return { xName, parseFeed, images, nitterVideo, discover, redditFeed, redditify, isReddit, youtubeFeed, youtubeVideo, xUser, xify, guesses, sanitize, plain, escapeHtml, parseOpml, buildOpml, absolute };
})();
