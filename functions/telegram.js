// Cloudflare Pages Function at /telegram: talks to the Telegram Bot API for the Music tab's Telegram bot, for when
// the browser can't reach api.telegram.org itself (BT Feeder tries directly first). It only passes requests on with
// the person's own bot token; nothing is kept.
//
// POST { "token": "123:ABC…", "method": "getUpdates", "params": { … } }  -> Telegram's JSON answer
// POST { "token": "123:ABC…", "file": "music/file_12.mp3" }             -> the file's bytes (bots: up to 20 MB)

const METHODS = ["getMe", "getUpdates", "getFile", "sendMessage"];
const TIMEOUT_MS = 25000;

export async function onRequestPost({ request }) {
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ ok: false, description: "Forbidden" }, 403);

  let token, method, params, file;
  try { ({ token, method, params, file } = await request.json()); } catch (e) { return json({ ok: false, description: "Expected JSON" }, 400); }
  if (!/^\d{5,15}:[\w-]{30,60}$/.test(String(token || ""))) return json({ ok: false, description: "That doesn't look like a bot token" }, 400);

  try {
    if (file != null) {
      file = String(file);
      if (!/^[\w\-./]{1,200}$/.test(file) || file.includes("..")) return json({ ok: false, description: "Bad file path" }, 400);
      const res = await fetch("https://api.telegram.org/file/bot" + token + "/" + file, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return json({ ok: false, description: "Telegram answered " + res.status }, res.status);
      return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "no-store" } });
    }
    if (!METHODS.includes(method)) return json({ ok: false, description: "Method not allowed" }, 400);
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (e) {
    return json({ ok: false, description: e && e.name === "TimeoutError" ? "Telegram didn't answer" : "Couldn't reach Telegram" }, 502);
  }
}

export function onRequest() {
  return json({ ok: false, description: "Use POST" }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
