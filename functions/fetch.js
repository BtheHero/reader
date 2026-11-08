// Cloudflare Pages Function at /fetch (Reader's own site) or /reader/fetch (via functions/reader/fetch.js):
// fetches RSS/Atom feeds for Reader.
//
// Browsers can't read most feeds directly (the sites don't send CORS headers), so the reader asks this
// function instead. It only runs when someone presses refresh (or opens the reader with an old copy):
// there is no timer and nothing runs in the background.
//
// One call fetches a whole batch of feeds, so a refresh costs one Functions request, not one per feed.
// The free plan allows 50 outside fetches per call; the reader splits bigger lists into several calls.
//
// POST { "urls": ["https://example.com/feed", ...] }
//  -> { "results": [{ "url", "ok", "status", "finalUrl", "type", "body" | "error" }, ...] }
//
// Each feed is also kept in Cloudflare's cache for CACHE_SECONDS, so refreshing again straight away
// doesn't hit the feed's site (which could get us rate-limited or blocked).

const MAX_URLS = 45;                 // per call; under the free plan's 50 subrequests
const CACHE_SECONDS = 600;           // how long Cloudflare keeps a copy of each feed
const TIMEOUT_MS = 10000;            // give up on a slow feed after this
const MAX_BYTES = 3 * 1024 * 1024;   // ignore anything bigger (no real feed is this big)

export async function onRequestPost({ request }) {
  // Only the reader's own pages may use this, so it can't become an open proxy that eats the account's
  // daily request allowance. (Browsers always send Origin on a cross-site POST.)
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "Forbidden" }, 403);

  let urls;
  try { ({ urls } = await request.json()); } catch (e) { return json({ error: "Expected JSON" }, 400); }
  if (!Array.isArray(urls) || !urls.length) return json({ error: "No urls" }, 400);
  if (urls.length > MAX_URLS) return json({ error: "At most " + MAX_URLS + " urls per call" }, 400);

  const results = await Promise.all(urls.map(fetchOne));
  return json({ results });
}

export function onRequest() {
  return json({ error: "Use POST" }, 405);
}

async function fetchOne(url) {
  let target;
  try { target = new URL(String(url)); } catch (e) { return { url, ok: false, error: "Invalid URL" }; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return { url, ok: false, error: "Only http(s) URLs" };

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0)",
      "Accept": "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5"
    };
    // From European data centres YouTube answers with a cookie-consent page instead of the channel page;
    // this cookie says "consent given (necessary cookies only)" so the reader can find the channel's feed.
    // (Only for pages: the feeds themselves don't need it.)
    if (/(^|\.)youtube\.com$/.test(target.hostname) && !target.pathname.startsWith("/feeds/")) headers.Cookie = "SOCS=CAI; CONSENT=YES+";
    const res = await fetch(target.href, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
    });
    const type = res.headers.get("Content-Type") || "";
    const size = Number(res.headers.get("Content-Length") || 0);
    if (size > MAX_BYTES) return { url, ok: false, status: res.status, error: "Feed is too large" };
    const body = await res.text();
    if (body.length > MAX_BYTES) return { url, ok: false, status: res.status, error: "Feed is too large" };
    if (!res.ok) return { url, ok: false, status: res.status, error: "The site answered " + res.status };
    return { url, ok: true, status: res.status, finalUrl: res.url || target.href, type, body };
  } catch (e) {
    return { url, ok: false, error: e && e.name === "TimeoutError" ? "Timed out" : "Couldn't reach the site" };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
