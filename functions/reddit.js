// Cloudflare Pages Function at /reddit: reads subreddits through Reddit's official API, with the person's own
// Reddit app ("installed app" Client ID, made at reddit.com/prefs/apps), for when Reddit's RSS feeds aren't
// available. BT Feeder only calls it when a Client ID is set in Settings, and only on refresh.
//
// POST { "clientId": "...", "deviceId": "...", "paths": ["/r/xbox/hot", "/user/name/submitted", ...] }
//  -> { "results": [{ "path", "ok", "status", "body" (Reddit's JSON listing) | "error" }, ...] }
//
// An app-only token (no Reddit account involved) is fetched with the Client ID and kept until it expires.

const MAX_PATHS = 45;
const TIMEOUT_MS = 8000;
const UA = "web:bt-feeder:1.0 (personal feed reader)";
const tokens = new Map();   // clientId|deviceId -> { token, until }

export async function onRequestPost({ request }) {
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "Forbidden" }, 403);

  let clientId, deviceId, paths;
  try { ({ clientId, deviceId, paths } = await request.json()); } catch (e) { return json({ error: "Expected JSON" }, 400); }
  if (!clientId || !/^[\w-]{10,40}$/.test(clientId)) return json({ error: "That doesn't look like a Reddit Client ID" }, 400);
  deviceId = /^[\w-]{20,40}$/.test(deviceId || "") ? deviceId : "DO_NOT_TRACK_THIS_DEVICE";
  if (!Array.isArray(paths) || !paths.length) return json({ error: "No paths" }, 400);
  if (paths.length > MAX_PATHS) return json({ error: "At most " + MAX_PATHS + " paths per call" }, 400);

  let token;
  try { token = await getToken(clientId, deviceId); }
  catch (e) { return json({ error: e.message }, 401); }

  const results = await Promise.all(paths.map(p => fetchListing(String(p), token)));
  return json({ results });
}

export function onRequest() {
  return json({ error: "Use POST" }, 405);
}

async function getToken(clientId, deviceId) {
  const key = clientId + "|" + deviceId;
  const have = tokens.get(key);
  if (have && have.until > Date.now()) return have.token;
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(clientId + ":"), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: "grant_type=" + encodeURIComponent("https://oauth.reddit.com/grants/installed_client") + "&device_id=" + encodeURIComponent(deviceId),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  let d = null;
  try { d = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !d || !d.access_token) {
    throw new Error(res.status === 401 ? "Reddit didn't accept that Client ID (it must be an \"installed app\")" : "Reddit's sign-in answered " + res.status + (d && d.error ? " (" + d.error + ")" : ""));
  }
  tokens.set(key, { token: d.access_token, until: Date.now() + Math.max(60, (d.expires_in || 3600) - 120) * 1000 });
  return d.access_token;
}

async function fetchListing(path, token) {
  // Only listings: a subreddit, a user, a multireddit or the front page, with an optional sort
  if (!/^\/((r|user)\/[\w+-]+(\/[\w-]+){0,3})?\/?(\?t=\w+)?$/.test(path)) return { path, ok: false, error: "Not a Reddit listing" };
  const [p, q] = path.split("?");
  const url = "https://oauth.reddit.com" + (p.replace(/\/$/, "") || "/") + ".json?limit=25&raw_json=1" + (q ? "&" + q : "");
  try {
    const res = await fetch(url, { headers: { "Authorization": "Bearer " + token, "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    if (!res.ok) return { path, ok: false, status: res.status, error: res.status === 404 ? "No such subreddit or user" : res.status === 403 ? "Private or banned" : "Reddit answered " + res.status };
    return { path, ok: true, status: res.status, body };
  } catch (e) {
    return { path, ok: false, error: e && e.name === "TimeoutError" ? "Timed out" : "Couldn't reach Reddit" };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
