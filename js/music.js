// BT Feeder: the Music tab. Songs from a folder on this device, with their tags and cover art (read here, from the
// files themselves), album / artist / song info and lyrics found online, playlists, likes, most and recently played.
//
// Where the files come from:
//  - the Android app: a folder you pick (Android's folder picker); the app lists it and serves each file to the page
//    at __music/?id=… (MainActivity.java), so nothing is copied;
//  - a desktop browser with folder access (Chrome, Edge): the folder is remembered, and asked for again after a restart;
//  - any other browser: pick the folder's files; they're readable until the page is closed (the library is kept).
//  - your own Telegram bot: songs you send or forward to it are added (saved into the folder in the Android app,
//    else kept in this browser).
// The library itself (tags, likes, play counts, playlists) is kept in this browser's IndexedDB, never sent anywhere.

const Music = (() => {
  const $ = (id) => document.getElementById(id);
  let A = null;                       // what app.js lends: el, toast, ask, fetchBatch, tellApp, stopOthers…
  const el = (tag, cls, txt) => A.el(tag, cls, txt);

  // Files that look like music. What actually plays depends on the device (Chrome: MP3, AAC/M4A, FLAC, Ogg, Opus,
  // WAV, WebM; Android also AMR / 3GP; Safari ALAC / AIFF / CAF).
  const AUDIO = /\.(mp3|m4a|m4b|mp4|aac|adts|flac|ogg|oga|opus|wav|wave|weba|webm|mka|wma|aif|aiff|aifc|caf|alac|3gp|amr|ape|wv|dsf|mpc)$/i;
  const TAGV = 2;                     // bump when the tag reader improves, so files are read again
  const PAGE = 120;

  const M = {
    tracks: new Map(),                // id (path in the folder) -> track
    playlists: [],                    // [{ id, name, ids, at }]
    art: new Map(),                   // art key -> small JPEG (data: URL), from the files' embedded pictures
    artists: {},                      // artist (lower case) -> { pic, fans, albums, bio, wiki, link, at }
    source: null,                     // { kind: "app" | "dir" | "files", name }
    files: new Map(),                 // id -> File or FileSystemFileHandle (this session only)
    dir: null,                        // the remembered folder (FileSystemDirectoryHandle)
    need: "",                         // "" | "reconnect" | "repick" | "scan"
    listed: false,                    // the folder was listed this session
    tab: "songs", sort: "title", stack: [], query: "",
    queue: [], order: null, qi: -1, shuffle: false, repeat: "off",
    playing: false, counted: false, listened: 0, lastT: 0, errors: 0, url: "",
    scanning: null, nowOpen: false, panel: "lyrics", lrc: null, lrcAt: -1,
    tg: null                          // { token, bot, owner, offset, seen } your Telegram bot (this device only)
  };
  const isTg = (id) => String(id).startsWith("tg:");                // a song kept in this browser (from Telegram)
  function clearFolderTracks() { for (const id of [...M.tracks.keys()]) if (!isTg(id)) M.tracks.delete(id); }
  const audio = new Audio();
  audio.preload = "auto";

  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\(.*?\)|\[.*?\]/g, "").replace(/\b(feat|ft|featuring)\b.*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const hms = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const cur = () => M.tracks.get(M.queue[M.qi]);
  const mainArtist = (t) => (t.artist || "").split(/\s*(?:;|\s\/\s|,\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\s&\s|\sx\s|\svs\.?\s)\s*/i)[0].trim() || "Unknown artist";
  const dirOf = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const albumKey = (t) => (norm(t.album) || "~" + dirOf(t.path).toLowerCase()) + "|" + (norm(t.albumArtist) || (t.album ? "" : mainArtist(t).toLowerCase()) || dirOf(t.path).toLowerCase());
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  // ---------- Saving ----------

  let saveTimer = 0, artTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Store.set("music", {
      v: 1, tracks: [...M.tracks.values()], playlists: M.playlists, artists: M.artists, source: M.source, tg: M.tg,
      prefs: { tab: M.tab, sort: M.sort, shuffle: M.shuffle, repeat: M.repeat, queue: M.queue.slice(0, 3000), qi: M.qi, pos: audio.currentTime || 0 }
    }).catch(() => {}), 500);
  }
  function saveArt() { clearTimeout(artTimer); artTimer = setTimeout(() => Store.set("musicart", Object.fromEntries(M.art)).catch(() => {}), 1500); }

  // ---------- Reading the files ----------

  const APP = () => window.ReaderApp && window.ReaderApp.musicPick ? window.ReaderApp : null;
  const appUrl = (id) => new URL("__music/?id=" + encodeURIComponent(id), document.baseURI).href;

  // Something that reads a range of a file: { size, read(start, length) -> Uint8Array }
  async function tgBlob(id) {
    let b = M.files.get(id);
    if (!b) { b = await Store.get("tgfile:" + id); if (!b) throw new Error("nofile"); M.files.set(id, b); }
    return b;
  }

  async function opener(t) {
    if (isTg(t.id)) { const f = await tgBlob(t.id); return { size: f.size, read: async (s, n) => new Uint8Array(await f.slice(s, s + n).arrayBuffer()) }; }
    if (M.source && M.source.kind === "app") {
      const url = appUrl(t.id);
      return { size: t.size, read: async (s, n) => {
        const r = await fetch(url, { headers: { Range: "bytes=" + s + "-" + (s + n - 1) } });
        if (!r.ok) throw new Error("read " + r.status);
        const b = new Uint8Array(await r.arrayBuffer());
        return r.status === 206 ? b : b.subarray(s, s + n);
      } };
    }
    let f = M.files.get(t.id);
    if (!f) throw new Error("nofile");
    if (f.getFile) f = await f.getFile();
    return { size: f.size, read: async (s, n) => new Uint8Array(await f.slice(s, s + n).arrayBuffer()) };
  }

  async function mediaSrc(t) {
    if (isTg(t.id)) return URL.createObjectURL(await tgBlob(t.id));
    if (M.source && M.source.kind === "app") return appUrl(t.id);
    let f = M.files.get(t.id);
    if (!f && M.source && M.source.kind === "dir" && M.dir) {
      if (!(await permitted(true))) throw new Error("nofile");
      await listDir();
      f = M.files.get(t.id);
    }
    if (!f) throw new Error("nofile");
    if (f.getFile) f = await f.getFile();
    return URL.createObjectURL(f);
  }

  // ---------- Tags: ID3 (MP3, AAC), FLAC and Ogg (Vorbis comments), MP4 / M4A, WAV ----------

  const dec8 = new TextDecoder("utf-8"), dec1 = new TextDecoder("latin1"), decLE = new TextDecoder("utf-16le"), decBE = new TextDecoder("utf-16be");
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const syncsafe = (b, i) => (b[i] & 127) * 2097152 + (b[i + 1] & 127) * 16384 + (b[i + 2] & 127) * 128 + (b[i + 3] & 127);
  const ascii = (b, i, n) => { let s = ""; for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]); return s; };
  const tidy = (s) => String(s || "").replace(/\0+$/, "").replace(/\0/g, " / ").replace(/\s+/g, " ").trim();
  function text(b, enc) {
    if (enc === 1) {
      if (b[0] === 0xFE && b[1] === 0xFF) return decBE.decode(b.subarray(2));
      if (b[0] === 0xFF && b[1] === 0xFE) return decLE.decode(b.subarray(2));
      return decLE.decode(b);
    }
    if (enc === 2) return decBE.decode(b);
    if (enc === 3) return dec8.decode(b);
    return dec1.decode(b);
  }
  function zero(b, i, enc) {
    if (enc === 1 || enc === 2) { for (; i + 1 < b.length; i += 2) if (!b[i] && !b[i + 1]) return i; return b.length; }
    for (; i < b.length; i++) if (!b[i]) return i;
    return b.length;
  }
  const zlen = (enc) => enc === 1 || enc === 2 ? 2 : 1;
  function unsync(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xFF && b[i + 1] === 0) i++; }
    return out.subarray(0, n);
  }
  const GENRES = ("Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|Alternative Rock|Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychedelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock").split("|");
  const genre = (g) => { g = tidy(g); const m = /^\(?(\d{1,3})\)?$/.exec(g) || /^\((\d{1,3})\)(.*)$/.exec(g); return m ? (m[2] && m[2].trim()) || GENRES[+m[1]] || "" : g; };
  const num = (s) => parseInt(String(s || ""), 10) || 0;

  function id3(b, out) {
    const ver = b[3], flags = b[5];
    let data = b.subarray(10, Math.min(b.length, 10 + syncsafe(b, 6)));
    if (flags & 0x80 && ver < 4) data = unsync(data);
    let i = 0;
    if (flags & 0x40) i = ver === 3 ? 4 + be32(data, 0) : syncsafe(data, 0);
    const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
    const F = { TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TALB: "album", TAL: "album", TPE2: "albumArtist", TP2: "albumArtist",
      TRCK: "track", TRK: "track", TPOS: "disc", TPA: "disc", TYER: "year", TYE: "year", TDRC: "year", TCON: "genre", TCO: "genre", TLEN: "len", TLE: "len" };
    while (i + hLen <= data.length) {
      const id = ascii(data, i, idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const size = ver === 2 ? (data[i + 3] << 16) | (data[i + 4] << 8) | data[i + 5] : ver === 4 ? syncsafe(data, i + 4) : be32(data, i + 4);
      const fl = ver === 2 ? 0 : data[i + 9];
      let f = data.subarray(i + hLen, i + hLen + size);
      i += hLen + size;
      if (!size) continue;
      if (ver === 3 && fl & 0xC0) continue;                     // compressed / encrypted
      if (ver === 4) { if (fl & 0x0C) continue; if (fl & 0x02) f = unsync(f); if (fl & 0x01) f = f.subarray(4); }
      const key = F[id];
      if (key) {
        const v = tidy(text(f.subarray(1), f[0]));
        if (key === "len") { if (+v) out.dur = out.dur || +v / 1000; }
        else if (v && !out[key]) out[key] = key === "genre" ? genre(v) : v;
      } else if (id === "APIC" || id === "PIC") {
        const enc = f[0];
        let p, mime, type;
        if (id === "PIC") { mime = "image/" + ascii(f, 1, 3).toLowerCase().replace("jpg", "jpeg"); type = f[4]; p = 5; }
        else { const e = zero(f, 1, 0); mime = ascii(f, 1, e - 1) || "image/jpeg"; if (!mime.includes("/")) mime = "image/" + mime.toLowerCase(); type = f[e + 1]; p = e + 2; }
        p = zero(f, p, enc) + zlen(enc);
        if (!out.pic || type === 3) out.pic = { mime, data: f.slice(p) };
      } else if ((id === "USLT" || id === "ULT") && !out.lyrics) {
        const enc = f[0];
        const p = zero(f, 4, enc) + zlen(enc);
        out.lyrics = text(f.subarray(p), enc).replace(/\0+$/, "").trim();
      }
    }
  }

  function vorbis(d, out) {
    let i = 0;
    const vlen = le32(d, i); i += 4 + vlen;
    const n = le32(d, i); i += 4;
    const K = { TITLE: "title", ARTIST: "artist", ALBUM: "album", ALBUMARTIST: "albumArtist", "ALBUM ARTIST": "albumArtist", DATE: "year", YEAR: "year",
      TRACKNUMBER: "track", DISCNUMBER: "disc", GENRE: "genre", LYRICS: "lyrics", UNSYNCEDLYRICS: "lyrics" };
    for (let k = 0; k < n && i + 4 <= d.length; k++) {
      const len = le32(d, i); i += 4;
      const s = dec8.decode(d.subarray(i, i + len)); i += len;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const name = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1);
      if (name === "METADATA_BLOCK_PICTURE") {
        try { const bin = Uint8Array.from(atob(v), c => c.charCodeAt(0)); const p = flacPic(bin); if (p && (!out.pic || p.type === 3)) out.pic = p; } catch (e) { /* bad base64 */ }
        continue;
      }
      const key = K[name];
      if (!key || !v.trim()) continue;
      if (key === "artist" && out.artist) out.artist += " / " + v.trim();
      else if (!out[key]) out[key] = key === "lyrics" ? v.trim() : tidy(v);
    }
  }

  function flacPic(d) {
    let i = 0;
    const type = be32(d, i); i += 4;
    const ml = be32(d, i); i += 4;
    const mime = ascii(d, i, ml); i += ml;
    const dl = be32(d, i); i += 4 + dl + 16;
    const len = be32(d, i); i += 4;
    return len && i + len <= d.length ? { type, mime: mime || "image/jpeg", data: d.slice(i, i + len) } : null;
  }

  async function flac(get, out) {
    let i = 4;
    for (let n = 0; n < 64; n++) {
      const h = await get(i, 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80, type = h[0] & 0x7F, len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 0 || type === 4 || type === 6) {
        const d = await get(i + 4, Math.min(len, 16e6));
        if (type === 0 && d.length >= 18) { const sr = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4); const total = (d[13] & 0x0F) * 4294967296 + be32(d, 14); if (sr) out.dur = total / sr; }
        else if (type === 4) vorbis(d, out);
        else if (type === 6) { const p = flacPic(d); if (p && (!out.pic || p.type === 3)) out.pic = p; }
      }
      i += 4 + len;
      if (last) break;
    }
  }

  async function ogg(get, size, out) {
    let pos = 0, cur = [];
    const packets = [];
    while (packets.length < 2 && pos < size && pos < 24e6) {
      const h = await get(pos, 27);
      if (ascii(h, 0, 4) !== "OggS") break;
      const nseg = h[26], segs = await get(pos + 27, nseg);
      const body = pos + 27 + nseg;
      let total = 0;
      for (const L of segs) total += L;
      const data = await get(body, total);
      let o = 0;
      for (const L of segs) {
        cur.push(data.subarray(o, o + L)); o += L;
        if (L < 255) { const n = cur.reduce((a, c) => a + c.length, 0), p = new Uint8Array(n); let w = 0; for (const c of cur) { p.set(c, w); w += c.length; } packets.push(p); cur = []; if (packets.length >= 2) break; }
      }
      pos = body + total;
    }
    if (packets.length < 2) return;
    const [id, com] = packets;
    let rate = 0, skip = 0;
    if (ascii(id, 1, 6) === "vorbis") rate = le32(id, 12);
    else if (ascii(id, 0, 8) === "OpusHead") { rate = 48000; skip = id[10] | (id[11] << 8); }
    if (ascii(com, 1, 6) === "vorbis") vorbis(com.subarray(7), out);
    else if (ascii(com, 0, 8) === "OpusTags") vorbis(com.subarray(8), out);
    // Length: the last page's position
    if (rate && size) {
      const tail = await get(Math.max(0, size - 65536), Math.min(65536, size));
      for (let i = tail.length - 14; i >= 0; i--) {
        if (tail[i] === 0x4F && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
          const g = le32(tail, i + 6) + le32(tail, i + 10) * 4294967296;
          if (g > skip) out.dur = (g - skip) / rate;
          break;
        }
      }
    }
  }

  async function mp4(get, size, out) {
    let pos = 0, moov = null;
    for (let n = 0; n < 64 && pos + 8 <= size; n++) {
      const h = await get(pos, 16);
      let len = be32(h, 0);
      const type = ascii(h, 4, 4);
      if (len === 1) len = be32(h, 8) * 4294967296 + be32(h, 12); else if (len === 0) len = size - pos;
      if (len < 8) break;
      if (type === "moov") { moov = await get(pos + 8, Math.min(len - 8, 24e6)); break; }
      pos += len;
    }
    if (!moov) return;
    const walk = (b, s, e, depth) => {
      for (let i = s; i + 8 <= e && depth < 8;) {
        let len = be32(b, i);
        const type = ascii(b, i + 4, 4);
        if (len < 8 || i + len > e) len = e - i;
        if (type === "mvhd") {
          const v = b[i + 8];
          const scale = be32(b, i + (v ? 28 : 20)), dur = v ? be32(b, i + 32) * 4294967296 + be32(b, i + 36) : be32(b, i + 24);
          if (scale) out.dur = dur / scale;
        } else if (type === "udta" || type === "ilst") walk(b, i + 8, i + len, depth + 1);
        else if (type === "meta") walk(b, i + 12, i + len, depth + 1);
        else if (depth > 0 && b[i + 12] !== undefined && ascii(b, i + 12, 4) === "data") item(type, b.subarray(i + 8, i + len));
        i += len;
      }
    };
    const item = (type, d) => {
      const len = be32(d, 0), kind = be32(d, 8) & 0xFFFFFF, v = d.subarray(16, len);
      const K = { "\xA9nam": "title", "\xA9ART": "artist", "aART": "albumArtist", "\xA9alb": "album", "\xA9day": "year", "\xA9gen": "genre", "\xA9lyr": "lyrics" };
      if (K[type]) { const s = dec8.decode(v); if (!out[K[type]]) out[K[type]] = K[type] === "lyrics" ? s.trim() : tidy(s); }
      else if (type === "trkn" && v.length >= 4) out.track = String((v[2] << 8) | v[3]);
      else if (type === "disk" && v.length >= 4) out.disc = String((v[2] << 8) | v[3]);
      else if (type === "gnre" && v.length >= 2 && !out.genre) out.genre = GENRES[((v[0] << 8) | v[1]) - 1] || "";
      else if (type === "covr" && !out.pic) out.pic = { mime: kind === 14 ? "image/png" : "image/jpeg", data: v.slice() };
    };
    walk(moov, 0, moov.length, 0);
  }

  async function wav(get, size, out) {
    let pos = 12, rate = 0;
    for (let n = 0; n < 64 && pos + 8 <= size; n++) {
      const h = await get(pos, 8);
      const id = ascii(h, 0, 4), len = le32(h, 4);
      if (id === "fmt ") { const d = await get(pos + 8, 16); rate = le32(d, 8); }
      else if (id === "data") { if (rate) out.dur = len / rate; }
      else if (id === "LIST") {
        const d = await get(pos + 8, Math.min(len, 1e6));
        if (ascii(d, 0, 4) === "INFO") {
          const K = { INAM: "title", IART: "artist", IPRD: "album", ICRD: "year", IGNR: "genre", ITRK: "track", IPRT: "track" };
          for (let i = 4; i + 8 <= d.length;) { const k = ascii(d, i, 4), l = le32(d, i + 4); const v = tidy(dec8.decode(d.subarray(i + 8, i + 8 + l))); if (K[k] && v && !out[K[k]]) out[K[k]] = v; i += 8 + l + (l & 1); }
        }
      } else if (id === "id3 " || id === "ID3 ") { const d = await get(pos + 8, Math.min(len, 16e6)); if (ascii(d, 0, 3) === "ID3") id3(d, out); }
      pos += 8 + len + (len & 1);
    }
  }

  function mp3Length(b, bytes) {
    for (let i = 0; i + 40 < b.length; i++) {
      if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) continue;
      const vb = (b[i + 1] >> 3) & 3, lb = (b[i + 1] >> 1) & 3, bi = b[i + 2] >> 4, si = (b[i + 2] >> 2) & 3;
      if (vb === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) continue;
      const v1 = vb === 3, layer = 4 - lb;
      const sr = [44100, 48000, 32000][si] / (vb === 3 ? 1 : vb === 2 ? 2 : 4);
      const tab = v1 ? (layer === 1 ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] : layer === 2 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384] : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])
        : (layer === 1 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]);
      const spf = layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152;
      const mono = (b[i + 3] >> 6) === 3;
      const x = i + 4 + (v1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
      const tag = ascii(b, x, 4);
      if ((tag === "Xing" || tag === "Info") && (b[x + 7] & 1)) return be32(b, x + 8) * spf / sr;
      if (ascii(b, i + 36, 4) === "VBRI") return be32(b, i + 50) * spf / sr;
      return tab[bi] ? bytes * 8 / (tab[bi] * 1000) : 0;
    }
    return 0;
  }

  // Everything the file says about itself (nothing for formats without tags, or a file that can't be read)
  async function readTags(t) {
    const r = await opener(t);
    const size = r.size || t.size || 0;
    const head = await r.read(0, Math.min(size || 262144, 262144));
    const get = async (s, n) => s + n <= head.length ? head.subarray(s, s + n) : r.read(s, n);
    const out = {};
    const magic = ascii(head, 0, 4);
    if (magic.startsWith("ID3")) {
      const end = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
      const tag = end <= head.length ? head : await r.read(0, Math.min(end, 16e6));
      id3(tag, out);
      if (end + 8 < size) {
        const after = await get(end, 4096);
        if (ascii(after, 0, 4) === "fLaC") await flac(async (s, n) => get(end + s, n), out);
        else if (!out.dur) out.dur = mp3Length(after, size - end);
      }
    } else if (magic === "fLaC") await flac(get, out);
    else if (magic === "OggS") await ogg(get, size, out);
    else if (ascii(head, 4, 4) === "ftyp") await mp4(get, size, out);
    else if (magic === "RIFF" && ascii(head, 8, 4) === "WAVE") await wav(get, size, out);
    else if (/\.mp3$/i.test(t.name)) out.dur = mp3Length(head, size);
    // ID3 version 1, at the very end (old MP3s)
    if (!out.title && /\.mp3$/i.test(t.name) && size > 128) {
      const v1 = await get(size - 128, 128);
      if (ascii(v1, 0, 3) === "TAG") {
        const f = (s, n) => tidy(dec1.decode(v1.subarray(s, s + n)));
        out.title = f(3, 30); out.artist = out.artist || f(33, 30); out.album = out.album || f(63, 30); out.year = out.year || f(93, 4);
        if (!v1[125] && v1[126]) out.track = out.track || String(v1[126]);
        if (!out.genre && v1[127] < GENRES.length) out.genre = GENRES[v1[127]];
      }
    }
    return out;
  }

  // A cover picture -> a small JPEG to keep (about 20 KB)
  async function thumb(pic) {
    try {
      const bmp = await createImageBitmap(new Blob([pic.data], { type: pic.mime || "image/jpeg" }));
      const s = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return c.toDataURL("image/jpeg", .84);
    } catch (e) { return ""; }
  }

  // Without tags: "Artist - Title", "01 Title", folders Artist / Album
  function fromPath(path) {
    const parts = path.split("/");
    let title = parts.pop().replace(/\.[^.]+$/, "").replace(/_/g, " ").trim(), artist = "", track = "";
    let m = /^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(title);
    if (m) { track = String(+m[1]); title = m[2]; }
    m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
    if (m) { artist = m[1]; title = m[2]; }
    const album = parts.length ? parts[parts.length - 1] : "";
    if (!artist && parts.length >= 2) artist = parts[parts.length - 2];
    return { title: title.trim(), artist: artist.trim(), album, track };
  }

  async function readTrack(f, old) {
    const t = {
      id: f.id, path: f.path, name: f.name, size: f.size, mtime: f.mtime || 0, v: TAGV,
      plays: 0, last: 0, liked: false, added: Date.now(),
      ...(old ? { plays: old.plays || 0, last: old.last || 0, liked: !!old.liked, likedAt: old.likedAt, added: old.added || Date.now(), info: old.info, lyrics: old.lyrics, fix: old.fix, dur: old.dur } : {})
    };
    let tags = {};
    try { tags = await readTags(t); } catch (e) { tags = {}; }
    const g = fromPath(f.path);
    t.title = tags.title || g.title;
    t.artist = tags.artist || (tags.title ? "" : g.artist);
    t.album = tags.album || (tags.title ? "" : g.album);
    t.albumArtist = tags.albumArtist || "";
    t.year = (/\d{4}/.exec(tags.year || "") || [""])[0];
    t.track = num(tags.track || g.track);
    t.disc = num(tags.disc);
    t.genre = tags.genre || "";
    if (tags.dur && isFinite(tags.dur)) t.dur = tags.dur;
    t.lyr = tags.lyrics || "";
    t.guessed = !tags.title || !tags.artist;
    delete t.art;
    if (tags.pic && tags.pic.data && tags.pic.data.length > 100) {
      const key = "a:" + albumKey(t);
      if (!M.art.has(key)) { const img = await thumb(tags.pic); if (img) { M.art.set(key, img); saveArt(); } }
      if (M.art.has(key)) t.art = key;
    }
    applyFix(t);
    return t;
  }
  const applyFix = (t) => { if (t.fix) for (const k of ["title", "artist", "album", "year", "genre"]) if (t.fix[k]) t[k] = t.fix[k]; };

  // ---------- The folder ----------

  // The folder's files now -> the library: new and changed files are read (three at a time), gone ones leave
  async function scan(list, name) {
    if (M.scanning) return;
    const seen = new Set(), todo = [];
    for (const f of list) {
      seen.add(f.id);
      const old = M.tracks.get(f.id);
      if (old && old.size === f.size && (!f.mtime || !old.mtime || old.mtime === f.mtime) && old.v === TAGV) { if (old.path !== f.path) old.path = f.path; continue; }
      todo.push(f);
    }
    let gone = 0;
    for (const id of [...M.tracks.keys()]) if (!seen.has(id) && !isTg(id)) { M.tracks.delete(id); gone++; }
    M.listed = true;
    M.need = "";
    if (name && M.source) M.source.name = name;
    if (!todo.length) { if (gone) save(); render(); return; }
    M.scanning = { done: 0, total: todo.length };
    render();
    let k = 0, lastDraw = 0;
    const worker = async () => {
      while (k < todo.length) {
        const f = todo[k++];
        try { M.tracks.set(f.id, await readTrack(f, M.tracks.get(f.id))); } catch (e) { /* skip it */ }
        M.scanning.done++;
        if (Date.now() - lastDraw > 700) { lastDraw = Date.now(); progress(); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    M.scanning = null;
    save();
    render();
    A.toast(M.tracks.size ? plural(M.tracks.size, "song") + " in your library" : "No music found in that folder");
  }
  function progress() {
    const p = $("m-progress");
    if (p && M.scanning) p.querySelector("span").textContent = "Reading your music… " + M.scanning.done + " of " + M.scanning.total;
    else render();
  }

  // Android app: the app lists the folder and answers here
  window.ReaderMusic = {
    onScan(json) {
      let d;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (d.cancelled) { if (!M.source) render(); return; }
      if (d.error) { M.need = d.error === "none" ? "" : "scan"; if (d.error === "none") M.source = null; render(); if (d.error !== "none") A.toast("Couldn't read the music folder: " + d.error); return; }
      if (!M.source || M.source.kind !== "app") { M.source = { kind: "app", name: d.folder || "Music" }; clearFolderTracks(); }
      scan(d.files || [], d.folder);
    }
  };

  async function listDir() {
    const out = [];
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith(".")) continue;
        if (h.kind === "directory") await walk(h, prefix + name + "/");
        else if (AUDIO.test(name)) {
          let f;
          try { f = await h.getFile(); } catch (e) { continue; }
          out.push({ id: prefix + name, path: prefix + name, name, size: f.size, mtime: f.lastModified });
          M.files.set(prefix + name, h);
        }
      }
    };
    M.files.clear();
    await walk(M.dir, "");
    return out;
  }
  async function permitted(ask) {
    if (!M.dir) return false;
    try {
      if ((await M.dir.queryPermission({ mode: "read" })) === "granted") return true;
      return ask && (await M.dir.requestPermission({ mode: "read" })) === "granted";
    } catch (e) { return false; }
  }

  async function chooseFolder() {
    const app = window.ReaderApp;
    if (app && app.musicPick) { app.musicPick(); return; }
    if (app) return A.toast("Update the BT Feeder app to choose a music folder");
    if (window.showDirectoryPicker) {
      let dir;
      try { dir = await showDirectoryPicker({ id: "music", mode: "read" }); } catch (e) { return; }
      const same = M.source && M.source.kind === "dir" && M.dir && (await M.dir.isSameEntry(dir).catch(() => false));
      M.dir = dir;
      Store.set("musicdir", dir).catch(() => {});
      if (!same) clearFolderTracks();
      M.source = { kind: "dir", name: dir.name };
      M.need = "";
      render();
      scan(await listDir(), dir.name);
      return;
    }
    $("m-files").click();
  }
  $("m-files").addEventListener("change", (e) => {
    const files = [...e.target.files].filter(f => AUDIO.test(f.name));
    e.target.value = "";
    if (!files.length) return A.toast("No music files in that folder");
    const root = (files[0].webkitRelativePath || "").split("/")[0] || "Music";
    if (!M.source || M.source.kind !== "files" || M.source.name !== root) clearFolderTracks();
    M.source = { kind: "files", name: root };
    M.files.clear();
    const list = files.map(f => {
      const path = (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
      M.files.set(path, f);
      return { id: path, path, name: f.name, size: f.size, mtime: f.lastModified };
    });
    scan(list, root);
  });

  async function rescan() {
    if (!M.source) return chooseFolder();
    if (M.source.kind === "app") { const app = APP(); if (app) { app.musicScan(); A.toast("Checking your music folder…"); } return; }
    if (M.source.kind === "dir") { if (!(await permitted(true))) { M.need = "reconnect"; return render(); } return scan(await listDir()); }
    $("m-files").click();
  }

  // The first time the tab opens (or a song plays): see what's in the folder now
  async function ensureListed() {
    if (M.listed || M.scanning || !M.source) return;
    if (M.source.kind === "app") { M.listed = true; const app = APP(); if (app) app.musicScan(); return; }
    if (M.source.kind === "dir") {
      if (await permitted(false)) { M.listed = true; scan(await listDir()); }
      else { M.need = "reconnect"; render(); }
      return;
    }
    M.need = "repick";
    render();
  }

  function forget() {
    A.ask({ title: "Forget the music folder?", text: "Your library, likes, play counts and playlists are removed from BT Feeder (songs from Telegram kept in this browser too). The music files in the folder stay where they are.", ok: "Forget", danger: true }).then(r => {
      if (r.action !== "ok") return;
      stop();
      for (const id of M.tracks.keys()) if (isTg(id)) Store.del("tgfile:" + id).catch(() => {});
      M.tracks.clear(); M.playlists = []; M.art.clear(); M.artists = {}; M.queue = []; M.qi = -1; M.source = null; M.dir = null; M.files.clear(); M.stack = []; M.need = "";
      Store.set("musicdir", null).catch(() => {});
      const app = window.ReaderApp;
      try { if (app && app.musicForget) app.musicForget(); } catch (e) { /* older app */ }
      save(); saveArt(); render();
    });
  }

  // ---------- Online: song and album info (iTunes), artist pictures (Deezer) and bios (Wikipedia), lyrics (LRCLIB) ----------

  // Straight from the browser when the site allows it, else through BT Feeder's fetcher.
  // null: the site says there's nothing (404). undefined: it couldn't be asked (offline…), so nothing is remembered.
  async function getJSON(url, viaFetcher) {
    if (!viaFetcher) {
      try {
        const r = await fetch(url, { referrerPolicy: "no-referrer" });
        return r.ok ? await r.json() : r.status === 404 ? null : undefined;
      } catch (e) { /* not allowed from here: through the fetcher */ }
    }
    try {
      const [r] = await A.fetchBatch([url]);
      return r && r.ok ? JSON.parse(r.body) : r && r.status === 404 ? null : undefined;
    } catch (e) { return undefined; }
  }

  const infoQ = [];
  let infoBusy = false;
  function wantInfo(t, urgent) {
    if (!t || (t.info && Date.now() - (t.info.at || 0) < (t.info.none ? 14 : 120) * 86400000)) return;
    const i = infoQ.indexOf(t.id);
    if (i >= 0) { if (!urgent) return; infoQ.splice(i, 1); }
    if (urgent) infoQ.unshift(t.id); else infoQ.push(t.id);
    runInfo();
  }
  async function runInfo() {
    if (infoBusy) return;
    infoBusy = true;
    while (infoQ.length) {
      const t = M.tracks.get(infoQ.shift());
      if (!t) continue;
      try { await songInfo(t); } catch (e) { /* offline: next time */ }
      save();
      refreshArt(t);
      await new Promise(r => setTimeout(r, 1300));     // iTunes allows about 20 searches a minute
    }
    infoBusy = false;
  }

  // Search results -> candidates, best match first
  function rankSongs(results, t) {
    const nt = norm(t.title), na = norm(mainArtist(t));
    return (results || []).filter(r => r.kind === "song" || r.wrapperType === "track").map(r => {
      const rt = norm(r.trackName), ra = norm(r.artistName);
      let s = 0;
      if (rt && nt) s += rt === nt ? 4 : rt.includes(nt) || nt.includes(rt) ? 2 : 0;
      if (ra && na && na !== "unknown artist") s += ra === na ? 3 : ra.includes(na) || na.includes(ra) ? 2 : 0;
      if (t.dur && r.trackTimeMillis) { const d = Math.abs(r.trackTimeMillis / 1000 - t.dur); s += d < 3 ? 2 : d < 10 ? 1 : 0; }
      if (t.album && norm(r.collectionName) === norm(t.album)) s += 1;
      return { r, s };
    }).sort((a, b) => b.s - a.s);
  }
  const infoFrom = (r) => ({
    at: Date.now(), title: r.trackName || "", artist: r.artistName || "", album: r.collectionName || "", genre: r.primaryGenreName || "",
    year: (r.releaseDate || "").slice(0, 4), cover: (r.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/600x600bb."), url: r.trackViewUrl || "",
    count: r.trackCount || 0, number: r.trackNumber || 0, explicit: r.trackExplicitness === "explicit"
  });

  async function songInfo(t) {
    const term = t.guessed && !t.fix ? t.name.replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").replace(/^\d{1,3}\s+/, "") : [mainArtist(t) === "Unknown artist" ? "" : mainArtist(t), t.title].filter(Boolean).join(" ");
    const d = await getJSON("https://itunes.apple.com/search?" + new URLSearchParams({ term, media: "music", entity: "song", limit: "10" }));
    if (!d) throw new Error("offline");
    const best = rankSongs(d.results, t)[0];
    // Recognised: good enough to trust (for files without tags, the search was its file name)
    if (best && best.s >= (t.guessed ? 2 : 4)) {
      t.info = infoFrom(best.r);
      if (t.guessed && !t.fix) {
        t.title = t.info.title || t.title; t.artist = t.info.artist || t.artist;
        if (!t.album || t.album === fromPath(t.path).album) t.album = t.info.album || t.album;
        t.recognised = true;
      }
      if (!t.genre) t.genre = t.info.genre;
      if (!t.year) t.year = t.info.year;
    } else t.info = { at: Date.now(), none: true };
  }

  async function lyrics(t) {
    if (t.lyrics && Date.now() - (t.lyrics.at || 0) < (t.lyrics.none ? 7 : 365) * 86400000) return t.lyrics;
    const q = { track_name: t.title, artist_name: mainArtist(t) };
    if (t.album) q.album_name = t.album;
    if (t.dur) q.duration = String(Math.round(t.dur));
    let d = await getJSON("https://lrclib.net/api/get?" + new URLSearchParams(q));
    if (d === undefined) throw new Error("offline");
    if (!d || (!d.plainLyrics && !d.syncedLyrics && !d.instrumental)) {
      const s = await getJSON("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: t.title, artist_name: q.artist_name === "Unknown artist" ? "" : q.artist_name }));
      if (s === undefined) throw new Error("offline");
      d = Array.isArray(s) ? s.find(x => x.syncedLyrics && (!t.dur || Math.abs(x.duration - t.dur) < 6)) || s.find(x => x.plainLyrics) || null : null;
    }
    t.lyrics = d ? { at: Date.now(), plain: d.plainLyrics || "", synced: d.syncedLyrics || "", instrumental: !!d.instrumental } : { at: Date.now(), none: true };
    save();
    return t.lyrics;
  }

  async function artistInfo(name) {
    const k = name.toLowerCase();
    const had = M.artists[k];
    if (had && Date.now() - had.at < 60 * 86400000) return had;
    const a = { at: Date.now() };
    const dz = await getJSON("https://api.deezer.com/search/artist?" + new URLSearchParams({ q: name, limit: "3" }), true);
    const hit = dz && dz.data && (dz.data.find(x => norm(x.name) === norm(name)) || dz.data[0]);
    if (hit) { a.pic = hit.picture_xl || hit.picture_big || ""; a.fans = hit.nb_fan || 0; a.albums = hit.nb_album || 0; a.link = hit.link || ""; }
    if (dz === undefined) throw new Error("offline");
    const ws = await getJSON("https://en.wikipedia.org/w/api.php?" + new URLSearchParams({ action: "query", list: "search", srsearch: name + " music", srlimit: "3", format: "json", origin: "*" }));
    const pages = ws && ws.query && ws.query.search || [];
    for (const p of pages) {
      if (!norm(p.title).includes(norm(name).split(" ")[0])) continue;
      const sum = await getJSON("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(p.title.replace(/ /g, "_")));
      if (sum && sum.type !== "disambiguation" && /singer|band|rapper|musician|composer|songwriter|DJ|producer|group|duo|orchestra|music/i.test(sum.extract || "")) {
        a.bio = sum.extract; a.wiki = sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page || "";
        if (!a.pic && sum.thumbnail) a.pic = sum.thumbnail.source;
        break;
      }
    }
    M.artists[k] = a;
    save();
    return a;
  }

  // ---------- Pictures ----------

  const artOf = (t) => (t && (M.art.get(t.art) || M.art.get("a:" + albumKey(t)) || (t.info && t.info.cover))) || "";
  function albumArt(tracks) { for (const t of tracks) { const a = artOf(t); if (a) return a; } return ""; }
  function artEl(src, cls, label) {
    const box = el("span", "mcover " + (cls || ""));
    if (src) { const img = el("img"); img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.src = src; img.onerror = () => img.remove(); box.append(img); }
    else {
      let h = 0;
      for (const c of label || "") h = (h * 31 + c.charCodeAt(0)) | 0;
      box.style.setProperty("--hue", Math.abs(h) % 360);
      box.classList.add("blank");
      box.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
    }
    return box;
  }
  // A picture found online arrived: put it in place without redrawing everything
  function refreshArt(t) {
    const src = artOf(t);
    if (!src) return;
    for (const row of document.querySelectorAll('.msong[data-id="' + CSS.escape(t.id) + '"] .mcover.blank')) row.replaceWith(artEl(src, "mart"));
    const c = cur();
    if (c && c.id === t.id) { barUi(); if (M.nowOpen) nowUi(); mediaSession(); }
  }

  // ---------- The library, by tab ----------

  const songs = () => [...M.tracks.values()];
  function matches(t, q) { return !q || norm([t.title, t.artist, t.album, t.albumArtist, t.genre].join(" ")).includes(q); }
  function sorted(list, by) {
    const c = (a, b) => (a || "").localeCompare(b || "", undefined, { sensitivity: "base", numeric: true });
    if (by === "artist") return list.sort((a, b) => c(mainArtist(a), mainArtist(b)) || c(a.album, b.album) || (a.disc - b.disc) || (a.track - b.track) || c(a.title, b.title));
    if (by === "album") return list.sort((a, b) => c(a.album, b.album) || (a.disc - b.disc) || (a.track - b.track));
    if (by === "added") return list.sort((a, b) => (b.added || 0) - (a.added || 0) || c(a.title, b.title));
    return list.sort((a, b) => c(a.title, b.title));
  }
  const byTrack = (list) => list.sort((a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 999) - (b.track || 999) || (a.title || "").localeCompare(b.title || ""));
  function albums() {
    const map = new Map();
    for (const t of M.tracks.values()) { const k = albumKey(t); if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
    return [...map.entries()].map(([key, tracks]) => {
      const artists = [...new Set(tracks.map(mainArtist))];
      const t0 = tracks.find(t => t.albumArtist) || tracks[0];
      return { key, tracks: byTrack(tracks), name: t0.album || dirOf(t0.path).split("/").pop() || "Unknown album",
        artist: t0.albumArtist || (artists.length > 2 ? "Various artists" : artists.join(", ")), year: tracks.map(t => t.year).find(Boolean) || "" };
    });
  }
  function artists() {
    const map = new Map();
    for (const t of M.tracks.values()) { const a = mainArtist(t); const k = a.toLowerCase(); if (!map.has(k)) map.set(k, { name: a, tracks: [] }); map.get(k).tracks.push(t); }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // ---------- Drawing ----------

  const TABS = [["songs", "Songs"], ["albums", "Albums"], ["artists", "Artists"], ["playlists", "Playlists"], ["liked", "Liked"], ["top", "Most played"], ["recent", "Recently played"]];

  function render() {
    if (!A) return;
    const chips = $("m-chips");
    chips.textContent = "";
    for (const [k, label] of TABS) {
      const b = el("button", "gchip" + (M.tab === k && !M.stack.length ? " active" : ""), label);
      b.type = "button"; b.dataset.tab = k;
      chips.append(b);
    }
    chips.hidden = !M.tracks.size;
    const body = $("m-body");
    body.textContent = "";
    if (!M.source && !M.tracks.size) return empty(body);
    if (M.source && (M.need === "reconnect" || M.need === "repick")) {
      const n = el("div", "mnote");
      n.append(el("span", null, M.need === "reconnect" ? "Allow BT Feeder to open “" + M.source.name + "” again to play your music." : "Pick your music folder again to play it (this browser can't keep access to it)."));
      const b = el("button", "btn primary", M.need === "reconnect" ? "Allow" : "Pick folder");
      b.type = "button"; b.dataset.act = "reconnect";
      n.append(b);
      body.append(n);
    }
    if (M.scanning) {
      const p = el("div", "mnote");
      p.id = "m-progress";
      p.append(el("span", null, "Reading your music… " + M.scanning.done + " of " + M.scanning.total), el("span", "spinner"));
      body.append(p);
    }
    const top = M.stack[M.stack.length - 1];
    if (top) return detail(body, top);
    if (!M.tracks.size) {
      if (!M.scanning) body.append(el("div", "empty", !M.source ? "No songs yet." : M.listed ? "No music files in “" + M.source.name + "”." : "Loading your library…"));
      return;
    }
    const q = norm(M.query);
    if (M.tab === "songs") {
      const list = sorted(songs().filter(t => matches(t, q)), M.sort);
      body.append(listHead(list, plural(list.length, "song"), true), songList(list));
    } else if (M.tab === "albums") {
      const list = albums().filter(a => !q || norm(a.name + " " + a.artist).includes(q) || a.tracks.some(t => matches(t, q))).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      body.append(el("p", "mcount", plural(list.length, "album")), albumGrid(list));
    } else if (M.tab === "artists") {
      const list = artists().filter(a => !q || norm(a.name).includes(q));
      const ul = el("ul", "martists");
      for (const a of list.slice(0, 1500)) ul.append(artistRow(a));
      body.append(el("p", "mcount", plural(list.length, "artist")), ul);
    } else if (M.tab === "playlists") {
      const head = el("div", "mhead");
      const nb = el("button", "btn primary", "+ New playlist");
      nb.type = "button"; nb.dataset.act = "newlist";
      head.append(el("span", "mcount", plural(M.playlists.length, "playlist")), el("span", "grow"), nb);
      body.append(head);
      const ul = el("ul", "martists");
      const virt = [{ id: "~liked", name: "Liked songs", ids: songs().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id) }];
      for (const p of [...virt, ...M.playlists]) {
        const tracks = p.ids.map(id => M.tracks.get(id)).filter(Boolean);
        const li = el("li", "martist mplist");
        li.dataset.list = p.id;
        li.append(p.id === "~liked" ? heartCover() : artEl(albumArt(tracks), "mart", p.name));
        const info = el("span", "minfo");
        info.append(el("b", null, p.name), el("span", null, plural(tracks.length, "song")));
        li.append(info);
        ul.append(li);
      }
      body.append(ul);
    } else if (M.tab === "liked") {
      const list = songs().filter(t => t.liked && matches(t, q)).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
      body.append(listHead(list, plural(list.length, "liked song")));
      body.append(list.length ? songList(list) : el("div", "empty", "Tap ♥ on a song to keep it here."));
    } else if (M.tab === "top") {
      const list = songs().filter(t => t.plays > 0 && matches(t, q)).sort((a, b) => b.plays - a.plays || b.last - a.last).slice(0, 100);
      body.append(listHead(list, "Your most played"));
      body.append(list.length ? songList(list, { plays: true, rank: true }) : el("div", "empty", "Songs you play show up here."));
    } else if (M.tab === "recent") {
      const list = songs().filter(t => t.last && matches(t, q)).sort((a, b) => b.last - a.last).slice(0, 100);
      body.append(listHead(list, "Recently played"));
      body.append(list.length ? songList(list, { when: true }) : el("div", "empty", "Songs you play show up here."));
    }
  }

  function empty(body) {
    const box = el("div", "mempty");
    const ic = el("div", "mempty-ic");
    ic.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
    const old = window.ReaderApp && !window.ReaderApp.musicPick;
    box.append(ic, el("h3", null, "Your music, in BT Feeder"),
      el("p", null, "Choose the folder your songs are in. BT Feeder reads MP3, M4A / AAC, FLAC, Ogg, Opus, WAV and WebM files (and anything else your device plays), with their tags and cover art, and finds lyrics, album and artist info online."));
    const b = el("button", "btn primary", "Choose music folder");
    b.type = "button"; b.dataset.act = "folder";
    const tg = el("button", "btn", M.tg ? "Telegram: @" + M.tg.bot : "Get songs from Telegram");
    tg.type = "button"; tg.dataset.act = "telegram";
    const row = el("div", "actions center");
    row.append(b, tg);
    if (old) { b.disabled = true; box.append(row, el("p", "hint", "Update the BT Feeder app to use a music folder.")); }
    else box.append(row, el("p", "hint", "Your music stays on this device: nothing is uploaded."));
    body.append(box);
  }

  function heartCover() {
    const c = el("span", "mcover mart heart");
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
    return c;
  }

  function listHead(list, label, sortable) {
    const h = el("div", "mhead");
    h.append(el("span", "mcount", label), el("span", "grow"));
    if (sortable) {
      const s = el("select", "msort");
      s.setAttribute("aria-label", "Sort songs");
      for (const [v, l] of [["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["added", "Recently added"]]) { const o = el("option", null, l); o.value = v; s.append(o); }
      s.value = M.sort;
      s.onchange = () => { M.sort = s.value; save(); render(); };
      h.append(s);
    }
    if (list.length) {
      const sh = el("button", "btn", "Shuffle"); sh.type = "button";
      sh.onclick = () => playList(list.map(t => t.id), -1, true);
      const pl = el("button", "btn primary", "▶ Play"); pl.type = "button";
      pl.onclick = () => playList(list.map(t => t.id), 0, false);
      h.append(sh, pl);
    }
    return h;
  }

  function songList(list, o) {
    o = o || {};
    const ul = el("ul", "msongs");
    ul._ids = list.map(t => t.id);
    ul._opts = o;
    const more = (from) => {
      ul.querySelector(".msentinel")?.remove();
      const end = Math.min(list.length, from + PAGE);
      for (let i = from; i < end; i++) ul.append(songRow(list[i], i, o));
      if (end < list.length) {
        const s = el("li", "msentinel");
        ul.append(s);
        const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); more(end); } }, { rootMargin: "600px" });
        io.observe(s);
      }
    };
    more(0);
    return ul;
  }

  function songRow(t, i, o) {
    const c = cur();
    const li = el("li", "msong" + (c && c.id === t.id ? " current" : ""));
    li.dataset.id = t.id;
    li.dataset.i = i;
    if (o.rank) li.append(el("span", "mrank", String(i + 1)));
    li.append(artEl(artOf(t), "mart", t.album || t.title));
    const info = el("span", "minfo");
    const sub = [o.album === false ? "" : mainArtist(t) === "Unknown artist" && !t.artist ? "" : t.artist, o.noAlbum ? "" : t.album].filter(Boolean).join(" · ");
    info.append(el("b", null, (o.track && t.track ? t.track + ". " : "") + t.title), el("span", null, o.plays ? plural(t.plays, "play") + (sub ? " · " + sub : "") : o.when ? ago(t.last) + (sub ? " · " + sub : "") : sub || "Unknown artist"));
    li.append(info, el("span", "mdur", t.dur ? hms(t.dur) : ""));
    const like = el("button", "mlike" + (t.liked ? " on" : ""));
    like.type = "button"; like.setAttribute("aria-label", t.liked ? "Unlike" : "Like"); like.setAttribute("aria-pressed", t.liked);
    like.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
    const more = el("button", "mmore");
    more.type = "button"; more.setAttribute("aria-label", "More");
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>';
    li.append(like, more);
    return li;
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function albumGrid(list) {
    const g = el("div", "malbums");
    for (const a of list.slice(0, 2000)) {
      const b = el("button", "malbum");
      b.type = "button"; b.dataset.album = a.key;
      b.append(artEl(albumArt(a.tracks), "", a.name), el("b", null, a.name), el("span", null, a.artist + (a.year ? " · " + a.year : "")));
      g.append(b);
      if (!albumArt(a.tracks) && infoQ.length < 40) wantInfo(a.tracks[0]);
    }
    return g;
  }

  function artistRow(a) {
    const li = el("li", "martist");
    li.dataset.artist = a.name;
    const info = M.artists[a.name.toLowerCase()];
    const face = artEl(info && info.pic || albumArt(a.tracks), "mart round", a.name);
    const albumsN = new Set(a.tracks.map(albumKey)).size;
    const txt = el("span", "minfo");
    txt.append(el("b", null, a.name), el("span", null, plural(a.tracks.length, "song") + " · " + plural(albumsN, "album")));
    li.append(face, txt);
    return li;
  }

  function back(body, label) {
    const b = el("button", "mback");
    b.type = "button"; b.dataset.act = "back";
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg>';
    b.append(label);
    body.append(b);
  }

  const triedArtist = new Set();     // looked up this session (offline: not again until next time)
  function detail(body, top) {
    const prev = M.stack[M.stack.length - 2];
    back(body, prev ? (prev.kind === "artist" ? prev.name : "Back") : (TABS.find(x => x[0] === M.tab) || [, "Music"])[1]);
    if (top.kind === "album") {
      const a = albums().find(x => x.key === top.key);
      if (!a) return body.append(el("div", "empty", "This album isn't in your library any more."));
      const head = el("div", "mhero");
      const art = artEl(albumArt(a.tracks), "big", a.name);
      const info = el("div", "mhero-info");
      const by = el("button", "mlink", a.artist); by.type = "button"; by.dataset.artist = a.artist === "Various artists" ? "" : mainArtist({ artist: a.artist });
      const genres = [...new Set(a.tracks.map(t => t.genre).filter(Boolean))].slice(0, 2).join(", ");
      const total = a.tracks.reduce((s, t) => s + (t.dur || 0), 0);
      info.append(el("span", "mkind", "Album"), el("h2", null, a.name), by, el("p", "mmeta", [a.year, genres, plural(a.tracks.length, "song"), total >= 60 ? Math.round(total / 60) + " min" : ""].filter(Boolean).join(" · ")));
      const t0 = a.tracks.find(t => t.info && !t.info.none);
      if (t0 && t0.info.url) { const l = el("a", "mlink small", "Album on Apple Music"); l.href = t0.info.url.replace(/\?i=\d+.*$/, ""); l.target = "_blank"; l.rel = "noopener noreferrer"; info.append(l); }
      head.append(art, info);
      body.append(head, listHead(a.tracks, ""), songList(a.tracks, { track: true, noAlbum: true }));
      if (!albumArt(a.tracks)) wantInfo(a.tracks[0], true);
    } else if (top.kind === "artist") {
      const name = top.name;
      const tracks = songs().filter(t => mainArtist(t).toLowerCase() === name.toLowerCase() || norm(t.artist).includes(norm(name)) && norm(name).length > 3);
      const info = M.artists[name.toLowerCase()];
      const head = el("div", "mhero artist");
      head.append(artEl(info && info.pic || albumArt(tracks), "big round", name));
      const txt = el("div", "mhero-info");
      txt.append(el("span", "mkind", "Artist"), el("h2", null, name), el("p", "mmeta", [plural(tracks.length, "song"), info && info.fans ? info.fans.toLocaleString() + " fans on Deezer" : ""].filter(Boolean).join(" · ")));
      head.append(txt);
      body.append(head);
      if (info && info.bio) {
        const bio = el("p", "mbio", info.bio);
        body.append(bio);
        if (info.wiki) { const l = el("a", "mlink small", "Read more on Wikipedia"); l.href = info.wiki; l.target = "_blank"; l.rel = "noopener noreferrer"; body.append(l); }
      } else if (!info && !triedArtist.has(name.toLowerCase())) {
        body.append(el("p", "mbio muted", "Looking up " + name + "…"));
        triedArtist.add(name.toLowerCase());
        artistInfo(name).catch(() => {}).finally(() => { if (M.stack[M.stack.length - 1] === top) render(); });
      }
      const alb = albums().filter(a => a.tracks.some(t => tracks.includes(t))).sort((a, b) => (b.year || "").localeCompare(a.year || ""));
      if (alb.length) { body.append(el("h3", "msec", "Albums")); body.append(albumGrid(alb)); }
      const byPlays = [...tracks].sort((a, b) => (b.plays || 0) - (a.plays || 0));
      const list = byPlays.some(t => t.plays) ? byPlays : sorted([...tracks], "album");
      body.append(el("h3", "msec", "Songs"), listHead(list, ""), songList(list));
    } else if (top.kind === "playlist") {
      const liked = top.id === "~liked";
      const p = liked ? { name: "Liked songs", ids: songs().filter(t => t.liked).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0)).map(t => t.id) } : M.playlists.find(x => x.id === top.id);
      if (!p) return body.append(el("div", "empty", "This playlist was removed."));
      const tracks = p.ids.map(id => M.tracks.get(id)).filter(Boolean);
      const head = el("div", "mhero");
      head.append(liked ? heartCover() : artEl(albumArt(tracks), "big", p.name));
      head.lastChild.classList.add("big");
      const txt = el("div", "mhero-info");
      const total = tracks.reduce((s, t) => s + (t.dur || 0), 0);
      txt.append(el("span", "mkind", "Playlist"), el("h2", null, p.name), el("p", "mmeta", [plural(tracks.length, "song"), total >= 60 ? Math.round(total / 60) + " min" : ""].filter(Boolean).join(" · ")));
      if (!liked) {
        const row = el("div", "mrow");
        const ren = el("button", "btn", "Rename"); ren.type = "button"; ren.dataset.act = "rename";
        const del = el("button", "btn danger", "Delete"); del.type = "button"; del.dataset.act = "dellist";
        row.append(ren, del);
        txt.append(row);
      }
      head.append(txt);
      body.append(head, listHead(tracks, ""));
      body.append(tracks.length ? songList(tracks, { playlist: liked ? "" : p.id }) : el("div", "empty", "Add songs with ⋯ → Add to playlist."));
    }
  }

  function push(entry) {
    M.stack.push(entry);
    history.pushState({ music: M.stack.length }, "");
    render();
    $("m-scroll").scrollTop = 0;
  }

  // ---------- Clicks in the library ----------

  $("m-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    const wasDeep = M.stack.length;
    M.tab = b.dataset.tab; M.stack = [];
    save(); render();
    $("m-scroll").scrollTop = 0;
    if (wasDeep && history.state && history.state.music) history.go(-wasDeep);
  });

  $("m-body").addEventListener("click", (e) => {
    const t = e.target;
    const act = t.closest("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "folder") return chooseFolder();
      if (a === "telegram") return telegram();
      if (a === "reconnect") return M.need === "repick" ? $("m-files").click() : rescan();
      if (a === "back") return history.state && history.state.music ? history.back() : (M.stack.pop(), render());
      if (a === "newlist") return newPlaylist();
      if (a === "rename" || a === "dellist") return editPlaylist(M.stack[M.stack.length - 1].id, a);
    }
    const row = t.closest(".msong");
    if (row) {
      const tr = M.tracks.get(row.dataset.id);
      if (!tr) return;
      if (t.closest(".mlike")) return like(tr);
      if (t.closest(".mmore")) return songMenu(tr, row.closest(".msongs")._opts);
      const ul = row.closest(".msongs");
      return playList(ul._ids, +row.dataset.i, false);
    }
    const al = t.closest("[data-album]");
    if (al) return push({ kind: "album", key: al.dataset.album });
    const ar = t.closest("[data-artist]");
    if (ar && ar.dataset.artist) return push({ kind: "artist", name: ar.dataset.artist });
    const pl = t.closest("[data-list]");
    if (pl) return push({ kind: "playlist", id: pl.dataset.list });
  });

  function like(t, on) {
    t.liked = on == null ? !t.liked : on;
    t.likedAt = t.liked ? Date.now() : 0;
    save();
    for (const b of document.querySelectorAll('.msong[data-id="' + CSS.escape(t.id) + '"] .mlike')) { b.classList.toggle("on", t.liked); b.setAttribute("aria-pressed", t.liked); }
    const c = cur();
    if (c && c.id === t.id) { barUi(); nowUi(); }
    if (M.tab === "liked" || (M.stack.length && M.stack[M.stack.length - 1].id === "~liked")) render();
    A.toast(t.liked ? "Added to Liked songs" : "Removed from Liked songs");
  }

  // ---------- Menus ----------

  function menu(title, sub, items) {
    const d = $("m-menu"), body = $("m-menu-body");
    body.textContent = "";
    body.append(el("h2", null, title));
    if (sub) body.append(el("p", null, sub));
    const list = el("div", "mmenu");
    for (const it of items) {
      if (!it) continue;
      if (it.node) { list.append(it.node); continue; }
      const b = el("button", "mmitem" + (it.danger ? " danger" : ""), it.label);
      b.type = "button";
      b.onclick = () => { d.close(); it.fn(); };
      list.append(b);
    }
    body.append(list);
    const cancel = el("button", "btn", "Close"); cancel.type = "button"; cancel.onclick = () => d.close();
    const row = el("div", "actions"); row.append(cancel);
    body.append(row);
    if (!d.open) d.showModal();
  }

  function songMenu(t, o) {
    o = o || {};
    menu(t.title, [t.artist, t.album].filter(Boolean).join(" · "), [
      { label: "Play next", fn: () => enqueue(t, true) },
      { label: "Add to queue", fn: () => enqueue(t, false) },
      { label: "Add to playlist…", fn: () => toPlaylist(t) },
      o.playlist ? { label: "Remove from this playlist", fn: () => { const p = M.playlists.find(x => x.id === o.playlist); if (p) { p.ids = p.ids.filter(id => id !== t.id); save(); render(); } } } : null,
      { label: t.liked ? "Unlike" : "Like", fn: () => like(t) },
      t.album ? { label: "Go to album", fn: () => goAlbum(t) } : null,
      { label: "Go to artist", fn: () => goArtist(mainArtist(t)) },
      { label: "Song info", fn: () => songInfoDialog(t) },
      { label: "Identify song…", fn: () => identify(t) },
      isTg(t.id) ? { label: "Delete this song", danger: true, fn: () => deleteTg(t) } : null
    ]);
  }
  async function deleteTg(t) {
    const r = await A.ask({ title: "Delete “" + t.title + "”?", text: "It was sent from Telegram and is kept only in BT Feeder.", ok: "Delete", danger: true });
    if (r.action !== "ok") return;
    if (cur() === t) next();
    M.tracks.delete(t.id); M.files.delete(t.id);
    M.queue = M.queue.filter(id => id !== t.id); M.qi = Math.min(M.qi, M.queue.length - 1);
    Store.del("tgfile:" + t.id).catch(() => {});
    save(); render();
  }
  // From anywhere (the Now playing screen included) to an album's or artist's page in the Music tab
  function go(entry) {
    const fromNow = M.nowOpen && history.state && history.state.musicNow;
    closeNow(true);
    if (!document.body.classList.contains("inmusic")) A.selectMusic();
    if (fromNow) { M.stack.push(entry); history.replaceState({ music: M.stack.length }, ""); render(); $("m-scroll").scrollTop = 0; }
    else push(entry);
  }
  const goAlbum = (t) => go({ kind: "album", key: albumKey(t) });
  const goArtist = (name) => go({ kind: "artist", name });

  function songInfoDialog(t) {
    const dl = el("dl", "minfo-dl");
    const row = (k, v) => { if (!v) return; dl.append(el("dt", null, k), el("dd", null, String(v))); };
    row("Title", t.title); row("Artist", t.artist); row("Album", t.album); row("Album artist", t.albumArtist); row("Track", t.track ? t.track + (t.disc ? " (disc " + t.disc + ")" : "") : "");
    row("Year", t.year); row("Genre", t.genre); row("Length", t.dur ? hms(t.dur) : ""); row("Plays", t.plays ? String(t.plays) : "0");
    row("Last played", t.last ? new Date(t.last).toLocaleString() : ""); row("File", t.path); row("Size", t.size ? (t.size / 1048576).toFixed(1) + " MB" : "");
    if (t.recognised) row("Recognised", "Title and artist found online from the file name");
    const links = el("div", "mrow");
    if (t.info && t.info.url) { const a = el("a", "btn", "Apple Music"); a.href = t.info.url; a.target = "_blank"; a.rel = "noopener noreferrer"; links.append(a); }
    menu("Song info", "", [{ node: dl }, links.children.length ? { node: links } : null, { label: "Identify song…", fn: () => identify(t) }]);
  }

  // Search online for the song and pick the right one: its title, artist, album, year, genre and cover replace the file's
  async function identify(t) {
    const r = await A.ask({ title: "Identify song", text: "Search for the song by its title and artist.", input: [t.artist, t.title].filter(Boolean).join(" ") || t.name.replace(/\.[^.]+$/, ""), ok: "Search" });
    if (r.action !== "ok" || !r.value) return;
    A.toast("Searching…");
    const d = await getJSON("https://itunes.apple.com/search?" + new URLSearchParams({ term: r.value, media: "music", entity: "song", limit: "12" }));
    const res = rankSongs(d && d.results, t).map(x => x.r);
    if (!res.length) return A.toast(d ? "Nothing found for “" + r.value + "”" : "Couldn't search (offline?)");
    menu("Which one is it?", "", res.slice(0, 10).map(x => ({ label: x.trackName + " — " + x.artistName + (x.collectionName ? " · " + x.collectionName : "") + (x.releaseDate ? " (" + x.releaseDate.slice(0, 4) + ")" : ""), fn: () => {
      t.info = infoFrom(x);
      t.fix = { title: t.info.title, artist: t.info.artist, album: t.info.album, year: t.info.year, genre: t.info.genre };
      applyFix(t);
      t.guessed = false; delete t.lyrics;
      save(); render(); refreshArt(t);
      const c = cur(); if (c && c.id === t.id) { barUi(); nowUi(); }
      A.toast("Updated “" + t.title + "”");
    } })));
  }

  async function newPlaylist(withTrack) {
    const r = await A.ask({ title: "New playlist", input: "", placeholder: "Playlist name", ok: "Create" });
    if (r.action !== "ok" || !r.value) return;
    const p = { id: Math.random().toString(36).slice(2, 10), name: r.value, ids: withTrack ? [withTrack.id] : [], at: Date.now() };
    M.playlists.push(p);
    save();
    if (withTrack) A.toast("Added to " + p.name);
    if (M.tab === "playlists" && !M.stack.length) render();
  }
  function toPlaylist(t) {
    menu("Add to playlist", t.title, [
      { label: "+ New playlist…", fn: () => newPlaylist(t) },
      ...M.playlists.map(p => ({ label: p.name + (p.ids.includes(t.id) ? " ✓" : ""), fn: () => {
        if (!p.ids.includes(t.id)) p.ids.push(t.id);
        save(); A.toast("Added to " + p.name);
      } }))
    ]);
  }
  async function editPlaylist(id, what) {
    const p = M.playlists.find(x => x.id === id);
    if (!p) return;
    if (what === "rename") {
      const r = await A.ask({ title: "Rename playlist", input: p.name, ok: "Save" });
      if (r.action === "ok" && r.value) { p.name = r.value; save(); render(); }
    } else {
      const r = await A.ask({ title: "Delete “" + p.name + "”?", text: "The songs stay in your library.", ok: "Delete", danger: true });
      if (r.action !== "ok") return;
      M.playlists = M.playlists.filter(x => x !== p);
      save();
      if (history.state && history.state.music) history.back(); else { M.stack.pop(); render(); }
    }
  }

  // ---------- Playing ----------

  function playList(ids, i, shuffle) {
    if (!ids.length) return;
    M.order = ids.slice();
    M.shuffle = !!shuffle || (M.shuffle && i < 0);
    if (M.shuffle) {
      const first = i >= 0 ? ids[i] : null;
      const rest = ids.filter(id => id !== first);
      for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
      M.queue = first ? [first, ...rest] : rest;
      playAt(0);
    } else {
      M.queue = ids.slice();
      playAt(Math.max(0, i));
    }
  }

  function enqueue(t, next) {
    if (!M.queue.length || M.qi < 0) { M.queue = [t.id]; M.order = null; return playAt(0); }
    if (next) M.queue.splice(M.qi + 1, 0, t.id); else M.queue.push(t.id);
    save();
    A.toast(next ? "Plays next: " + t.title : "Added to the queue");
    if (M.nowOpen && M.panel === "queue") panel();
  }

  async function playAt(i, startAt) {
    if (i < 0 || i >= M.queue.length) return;
    M.qi = i;
    const t = cur();
    if (!t) { M.queue.splice(i, 1); return playAt(Math.min(i, M.queue.length - 1)); }
    A.stopOthers();
    let src;
    try { src = await mediaSrc(t); } catch (e) {
      if (M.source && M.source.kind === "files") { M.need = "repick"; render(); return A.toast("Pick your music folder again to play it"); }
      if (M.source && M.source.kind === "dir") { M.need = "reconnect"; render(); return A.toast("Allow BT Feeder to open your music folder"); }
      return A.toast("This song can't be opened");
    }
    if (M.url.startsWith("blob:")) URL.revokeObjectURL(M.url);
    M.url = src;
    audio.src = src;
    if (startAt) audio.addEventListener("loadedmetadata", () => { audio.currentTime = startAt; }, { once: true });
    M.counted = false; M.listened = 0; M.lastT = startAt || 0; M.lrc = null; M.lrcAt = -1; M.resumeAt = 0;
    audio.play().catch(() => {});
    document.body.classList.add("musicking");
    $("m-bar").hidden = false;
    markCurrent();
    barUi();
    mediaSession();
    wantInfo(t, true);
    if (M.nowOpen) { nowUi(); panel(); }
    save();
  }

  function markCurrent() {
    const c = cur();
    for (const r of document.querySelectorAll(".msong.current")) r.classList.remove("current");
    if (c) for (const r of document.querySelectorAll('.msong[data-id="' + CSS.escape(c.id) + '"]')) r.classList.add("current");
  }

  function next(auto) {
    if (!M.queue.length) return;
    if (auto && M.repeat === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    if (M.qi + 1 < M.queue.length) return playAt(M.qi + 1);
    if (M.repeat === "all") return playAt(0);
    if (auto) { M.playing = false; audio.currentTime = 0; audio.pause(); barUi(); nowUi(); A.tellApp(); return; }
    playAt(0);
  }
  function prev() {
    if (!M.queue.length) return;
    if (audio.currentTime > 4 || M.qi <= 0) { audio.currentTime = 0; if (audio.paused) resume(); return; }
    playAt(M.qi - 1);
  }
  function resume() {
    const t = cur();
    if (!t) return;
    if (!audio.src || audio.src !== M.url || !M.url) return playAt(M.qi, M.resumeAt || 0);
    A.stopOthers();
    $("m-bar").hidden = false;
    document.body.classList.add("musicking");
    audio.play().catch(() => playAt(M.qi, audio.currentTime));
  }
  function toggle() { if (audio.paused) resume(); else audio.pause(); }
  function pause() { if (!audio.paused) audio.pause(); }
  function stop() {
    if (!audio.paused) audio.pause();
    M.playing = false;
    $("m-bar").hidden = true;
    document.body.classList.remove("musicking");
    closeNow();
    if ("mediaSession" in navigator && navigator.mediaSession.metadata && M.sessionOn) {
      for (const a of ["play", "pause", "previoustrack", "nexttrack", "seekto"]) { try { navigator.mediaSession.setActionHandler(a, null); } catch (e) { /* fine */ } }
      M.sessionOn = false;
    }
    A.tellApp();
  }
  function setShuffle(on) {
    M.shuffle = on;
    const id = M.queue[M.qi];
    if (on) {
      const rest = M.queue.filter((x, k) => k !== M.qi);
      for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
      if (!M.order) M.order = M.queue.slice();
      M.queue = id ? [id, ...rest] : rest; M.qi = id ? 0 : -1;
    } else if (M.order) {
      M.queue = M.order.slice(); M.qi = Math.max(0, M.queue.indexOf(id));
    }
    save(); nowUi();
    if (M.nowOpen && M.panel === "queue") panel();
    A.toast(on ? "Shuffle on" : "Shuffle off");
  }
  function cycleRepeat() {
    M.repeat = M.repeat === "off" ? "all" : M.repeat === "all" ? "one" : "off";
    save(); nowUi();
    A.toast(M.repeat === "off" ? "Repeat off" : M.repeat === "all" ? "Repeat all" : "Repeat this song");
  }

  audio.addEventListener("play", () => { M.playing = true; M.errors = 0; barUi(); nowUi(); A.tellApp(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; });
  audio.addEventListener("pause", () => { M.playing = false; barUi(); nowUi(); A.tellApp(); save(); if ("mediaSession" in navigator && M.sessionOn) navigator.mediaSession.playbackState = "paused"; });
  audio.addEventListener("ended", () => next(true));
  audio.addEventListener("loadedmetadata", () => {
    const t = cur();
    if (t && isFinite(audio.duration) && audio.duration > 0 && Math.abs((t.dur || 0) - audio.duration) > 1) { t.dur = audio.duration; save(); }
  });
  audio.addEventListener("timeupdate", () => {
    const t = cur(), now = audio.currentTime;
    if (!t) return;
    const d = now - M.lastT;
    if (d > 0 && d < 3) M.listened += d;
    M.lastT = now;
    // A play counts after 30 seconds (or half of a short song)
    if (!M.counted && M.listened >= Math.min(30, (t.dur || audio.duration || 60) * .5)) {
      M.counted = true; t.plays = (t.plays || 0) + 1; t.last = Date.now(); save();
    }
    tick();
  });
  audio.addEventListener("error", () => {
    if (!M.url || !audio.getAttribute("src")) return;
    const t = cur();
    M.errors++;
    A.toast((t ? "“" + t.title + "”" : "This song") + " can't play on this device" + (t && /\.(wma|ape|wv|dsf|mpc|aiff?|alac)$/i.test(t.name) ? " (" + t.name.split(".").pop().toUpperCase() + " isn't supported here)" : ""));
    if (M.errors < 5 && M.qi + 1 < M.queue.length) setTimeout(() => playAt(M.qi + 1), 1200);
    else { M.playing = false; barUi(); }
  });

  function mediaSession() {
    if (!("mediaSession" in navigator)) return;
    const t = cur();
    if (!t) return;
    const art = artOf(t);
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || "", album: t.album || "", artwork: art ? [{ src: art, sizes: "512x512" }] : [] }); } catch (e) { /* fine */ }
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* fine */ } };
    set("play", () => resume()); set("pause", () => pause());
    set("previoustrack", () => prev()); set("nexttrack", () => next());
    set("seekto", (d) => { audio.currentTime = d.seekTime; });
    set("seekbackward", null); set("seekforward", null);
    M.sessionOn = true;
  }

  // ---------- The bar and the Now playing screen ----------

  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';
  function barUi() {
    const t = cur();
    if (!t) return;
    $("mb-title").textContent = t.title;
    $("mb-sub").textContent = t.artist || "Unknown artist";
    const art = artOf(t);
    $("mb-art").replaceWith(Object.assign(artEl(art, "mb-art", t.album || t.title), { id: "mb-art" }));
    $("mb-play").innerHTML = M.playing ? PAUSE : PLAY;
    $("mb-play").setAttribute("aria-label", M.playing ? "Pause" : "Play");
    $("mb-like").classList.toggle("on", !!t.liked);
    $("mb-like").setAttribute("aria-pressed", !!t.liked);
  }
  let seeking = false;
  function tick() {
    const dur = audio.duration || (cur() || {}).dur || 0, now = audio.currentTime || 0;
    $("mb-fill").style.width = dur ? Math.min(100, now / dur * 100) + "%" : "0";
    if (!M.nowOpen) return;
    if (!seeking) $("mn-seek").value = dur ? Math.round(now / dur * 1000) : 0;
    $("mn-time").textContent = hms(now);
    $("mn-left").textContent = dur ? "-" + hms(dur - now) : "";
    if (M.lrc && M.panel === "lyrics") {
      let k = -1;
      for (let i = 0; i < M.lrc.length; i++) { if (M.lrc[i].t <= now + .25) k = i; else break; }
      if (k !== M.lrcAt) {
        M.lrcAt = k;
        const lines = $("mn-panel").querySelectorAll(".lrc");
        lines.forEach((l, i) => l.classList.toggle("on", i === k));
        if (k >= 0 && lines[k] && Date.now() - lyricScrolled > 4000) lines[k].scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
  let lyricScrolled = 0;
  $("mn-panel").addEventListener("wheel", () => { lyricScrolled = Date.now(); }, { passive: true });
  $("mn-panel").addEventListener("touchmove", () => { lyricScrolled = Date.now(); }, { passive: true });

  function openNow() {
    if (!cur()) return;
    M.nowOpen = true;
    $("m-now").hidden = false;
    document.body.classList.add("mnowopen");
    history.pushState({ musicNow: true }, "");
    nowUi(); panel(); tick();
  }
  function closeNow(fromHistory) {
    if (!M.nowOpen) return;
    M.nowOpen = false;
    $("m-now").hidden = true;
    document.body.classList.remove("mnowopen");
    if (!fromHistory && history.state && history.state.musicNow) history.back();
  }

  function nowUi() {
    const t = cur();
    if (!t || !M.nowOpen) return;
    const art = artOf(t);
    $("mn-art").replaceWith(Object.assign(artEl(art, "mn-art", t.album || t.title), { id: "mn-art" }));
    $("mn-bg").style.backgroundImage = art ? "url(" + JSON.stringify(art) + ")" : "";
    $("mn-title").textContent = t.title;
    $("mn-artist").textContent = t.artist || "Unknown artist";
    $("mn-album").textContent = [t.album, t.year].filter(Boolean).join(" · ");
    $("mn-album").hidden = !t.album;
    $("mn-play").innerHTML = M.playing ? PAUSE : PLAY;
    $("mn-play").setAttribute("aria-label", M.playing ? "Pause" : "Play");
    $("mn-like").classList.toggle("on", !!t.liked);
    $("mn-like").setAttribute("aria-pressed", !!t.liked);
    $("mn-shuffle").classList.toggle("on", M.shuffle);
    $("mn-shuffle").setAttribute("aria-pressed", M.shuffle);
    $("mn-repeat").classList.toggle("on", M.repeat !== "off");
    $("mn-repeat").classList.toggle("one", M.repeat === "one");
    $("mn-repeat").setAttribute("aria-label", M.repeat === "one" ? "Repeat this song" : M.repeat === "all" ? "Repeat all" : "Repeat off");
    for (const b of document.querySelectorAll(".mn-tabs button")) b.classList.toggle("active", b.dataset.panel === M.panel);
  }

  function parseLrc(s) {
    const out = [];
    for (const line of String(s || "").split(/\r?\n/)) {
      const times = [...line.matchAll(/\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g)];
      if (!times.length) continue;
      const txt = line.replace(/\[[^\]]*\]/g, "").trim();
      for (const m of times) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), txt });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async function panel() {
    const t = cur(), box = $("mn-panel");
    if (!t || !M.nowOpen) return;
    box.textContent = "";
    box.scrollTop = 0;
    M.lrc = null; M.lrcAt = -1;
    nowUi();
    if (M.panel === "lyrics") {
      const show = (L) => {
        if (cur() !== t || M.panel !== "lyrics") return;
        box.textContent = "";
        if (L && L.synced) {
          M.lrc = parseLrc(L.synced);
          for (const l of M.lrc) { const b = el("button", "lrc", l.txt || "♪"); b.type = "button"; b.onclick = () => { audio.currentTime = l.t; if (audio.paused) resume(); }; box.append(b); }
          box.append(el("p", "msrc", "Lyrics from LRCLIB"));
          tick();
        } else if (L && L.plain) { box.append(el("div", "lyrics", L.plain)); if (!L.embedded) box.append(el("p", "msrc", "Lyrics from LRCLIB")); }
        else if (L && L.instrumental) box.append(el("p", "mempty-txt", "♪ Instrumental"));
        else box.append(el("p", "mempty-txt", L ? "No lyrics found for this song." : "Couldn't look for lyrics (offline?)"));
      };
      box.append(el("p", "mempty-txt", "Looking for lyrics…"));
      let L = null;
      try { L = await lyrics(t); } catch (e) { L = null; }
      if (L && L.none && t.lyr) L = { plain: t.lyr, embedded: true };
      if (!L && t.lyr) L = { plain: t.lyr, embedded: true };
      show(L);
    } else if (M.panel === "info") {
      const a = M.artists[mainArtist(t).toLowerCase()];
      const card = el("div", "minfo-card");
      const dl = el("dl", "minfo-dl");
      const row = (k, v) => { if (v) dl.append(el("dt", null, k), el("dd", null, String(v))); };
      row("Album", t.album); row("Year", t.year); row("Genre", t.genre); row("Track", t.track ? t.track + (t.info && t.info.count ? " of " + t.info.count : "") : "");
      row("Length", t.dur ? hms(t.dur) : ""); row("Plays", String(t.plays || 0)); row("File", t.path);
      card.append(dl);
      if (t.info && t.info.url) { const l = el("a", "mlink small", "Open on Apple Music"); l.href = t.info.url; l.target = "_blank"; l.rel = "noopener noreferrer"; card.append(l); }
      box.append(card);
      const art = el("div", "minfo-card artist");
      const name = mainArtist(t);
      const head = el("button", "martist plain");
      head.type = "button"; head.onclick = () => goArtist(name);
      head.append(artEl(a && a.pic, "mart round", name));
      const it = el("span", "minfo"); it.append(el("b", null, name), el("span", null, a && a.fans ? a.fans.toLocaleString() + " fans" : "Artist"));
      head.append(it);
      art.append(head);
      if (a && a.bio) art.append(el("p", "mbio", a.bio));
      box.append(art);
      if (!a) artistInfo(name).then(() => { if (cur() === t && M.panel === "info") panel(); }).catch(() => {});
    } else {
      const ul = el("ul", "msongs");
      ul._ids = M.queue.slice(M.qi);
      ul._opts = {};
      M.queue.slice(M.qi, M.qi + 200).forEach((id, k) => { const tr = M.tracks.get(id); if (tr) { const r = songRow(tr, k, {}); ul.append(r); } });
      box.append(el("p", "mcount", "Up next · " + plural(Math.max(0, M.queue.length - M.qi - 1), "song")), ul);
      ul.addEventListener("click", (e) => {
        const r = e.target.closest(".msong");
        if (!r) return;
        e.stopPropagation();
        const tr = M.tracks.get(r.dataset.id);
        if (e.target.closest(".mlike")) return like(tr);
        if (e.target.closest(".mmore")) return songMenu(tr);
        playAt(M.qi + +r.dataset.i);
      });
    }
  }

  // Controls
  $("mb-play").onclick = toggle;
  $("mb-next").onclick = () => next();
  $("mb-prev").onclick = prev;
  $("mb-like").onclick = () => { const t = cur(); if (t) like(t); };
  $("mb-close").onclick = () => stop();
  $("mb-info").onclick = openNow;
  $("mb-art-btn").onclick = openNow;
  $("mn-close").onclick = () => closeNow();
  $("mn-play").onclick = toggle;
  $("mn-next").onclick = () => next();
  $("mn-prev").onclick = prev;
  $("mn-like").onclick = () => { const t = cur(); if (t) like(t); };
  $("mn-shuffle").onclick = () => setShuffle(!M.shuffle);
  $("mn-repeat").onclick = cycleRepeat;
  $("mn-more").onclick = () => { const t = cur(); if (t) songMenu(t); };
  $("mn-artist").onclick = () => { const t = cur(); if (t) goArtist(mainArtist(t)); };
  $("mn-album").onclick = () => { const t = cur(); if (t && t.album) goAlbum(t); };
  $("mn-seek").addEventListener("input", () => { seeking = true; const d = audio.duration || 0; if (d) $("mn-time").textContent = hms($("mn-seek").value / 1000 * d); });
  $("mn-seek").addEventListener("change", () => { seeking = false; const d = audio.duration || 0; if (d) audio.currentTime = $("mn-seek").value / 1000 * d; });
  document.querySelector(".mn-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-panel]"); if (b) { M.panel = b.dataset.panel; panel(); } });
  $("m-folder").onclick = () => {
    const tgItem = { label: M.tg ? "Telegram bot: @" + M.tg.bot + "…" : "Get songs from Telegram…", fn: telegram };
    if (!M.source) return menu("Your music", plural(M.tracks.size, "song"), [{ label: "Choose music folder…", fn: chooseFolder }, tgItem]);
    menu("Music folder", "“" + M.source.name + "” · " + plural(M.tracks.size, "song"), [
      { label: "Check for new music", fn: () => { rescan(); tgPoll(true); } },
      tgItem,
      { label: "Choose another folder…", fn: chooseFolder },
      { label: "Forget this folder", danger: true, fn: forget }
    ]);
  };
  $("m-search").onclick = () => {
    const box = $("m-searchbox");
    box.hidden = !box.hidden;
    if (!box.hidden) $("m-q").focus(); else if (M.query) { M.query = ""; $("m-q").value = ""; render(); }
  };
  let qTimer = 0;
  $("m-q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { M.query = e.target.value.trim(); if (M.stack.length) { M.stack = []; } render(); }, 150); });

  // ---------- Your Telegram bot: songs you send or forward to it ----------
  // You make a bot with @BotFather and paste its token. BT Feeder asks Telegram for the bot's new messages when the
  // app opens, every couple of minutes while it's open, and when the Music tab opens. Audio files (and audio sent as
  // files, like FLAC) are downloaded: in the Android app into the music folder's "Telegram" folder, elsewhere kept in
  // this browser. The bot answers each one. Only the first person to message the bot (you) is listened to.
  // Telegram keeps a bot's messages for 24 hours: songs sent while BT Feeder stays closed longer than that are lost.
  const TG = "https://api.telegram.org";
  const TG_FN = new URL("telegram", document.baseURI).href;
  const TG_MAX = 20 * 1048576;              // what a bot may download
  let tgBusy = false;

  // Straight to Telegram when the browser may; else through BT Feeder's function (functions/telegram.js)
  async function tgCall(method, params, token) {
    token = token || M.tg.token;
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    try {
      const r = await fetch(TG + "/bot" + token + "/" + method, { method: "POST", body: form });
      return await r.json();
    } catch (e) { /* not reachable from here */ }
    const r = await fetch(TG_FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, method, params: params || {} }) });
    return r.json();
  }
  async function tgDownload(path) {
    try {
      const r = await fetch(TG + "/file/bot" + M.tg.token + "/" + path);
      if (r.ok) return await r.blob();
    } catch (e) { /* not reachable from here */ }
    const r = await fetch(TG_FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: M.tg.token, file: path }) });
    if (!r.ok) throw new Error("Couldn't download it from Telegram");
    return r.blob();
  }
  const tgSay = (chat, text, replyTo) => tgCall("sendMessage", { chat_id: chat, text, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }).catch(() => {});

  // The Android app saves into the music folder (Telegram/…) and answers through ReaderMusic.onSaved
  const saving = new Map();
  window.ReaderMusic.onSaved = (id, json) => { const f = saving.get(id); saving.delete(id); if (f) { try { f(JSON.parse(json)); } catch (e) { f({ error: "bad answer" }); } } };
  function nativeSave(url, name) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      saving.set(id, resolve);
      window.ReaderApp.musicSave(id, url, name);
    });
  }

  const cleanName = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

  // One song from a message -> the library
  async function tgSave(f) {
    const g = await tgCall("getFile", { file_id: f.file_id });
    if (!g.ok) throw new Error(g.description || "Telegram didn't give the file");
    const path = g.result.file_path;
    const ext = (/\.[a-z0-9]{2,5}$/i.exec(path) || /\.[a-z0-9]{2,5}$/i.exec(f.file_name || "") || [".mp3"])[0];
    let name = cleanName(f.file_name) || cleanName([f.performer, f.title].filter(Boolean).join(" - ")) || "Song " + f.file_unique_id;
    if (!AUDIO.test(name)) name += ext;
    let t = null;
    const app = window.ReaderApp;
    if (app && app.musicSave && M.source && M.source.kind === "app" && !M.tg.noWrite) {
      const res = await nativeSave(TG + "/file/bot" + M.tg.token + "/" + path, name);
      if (res.ok) {
        t = await readTrack({ id: res.id, path: res.path, name: res.name, size: res.size, mtime: Date.now() }, null);
      } else if (res.error === "nowrite") {
        M.tg.noWrite = true;
        A.toast("Choose your music folder again to let BT Feeder save Telegram songs into it (kept in the app for now)");
      } else throw new Error(res.error || "Couldn't save it");
    }
    if (!t) {
      const blob = await tgDownload(path);
      const id = "tg:" + f.file_unique_id;
      await Store.set("tgfile:" + id, blob);
      M.files.set(id, blob);
      t = await readTrack({ id, path: "Telegram/" + name, name, size: blob.size, mtime: Date.now() }, null);
    }
    // No tags in the file: Telegram's own title and performer
    if (t.guessed && t.album === "Telegram") t.album = "";      // not an album: just where it was saved
    if (t.guessed && f.title) { t.title = f.title; if (f.performer) t.artist = f.performer; t.guessed = !f.performer; }
    if (!t.dur && f.duration) t.dur = f.duration;
    t.fromTg = true;
    M.tracks.set(t.id, t);
    return t;
  }

  async function tgPoll(byHand) {
    if (!M.tg || !M.tg.token || tgBusy) return;
    tgBusy = true;
    let added = 0;
    try {
      const d = await tgCall("getUpdates", { offset: M.tg.offset || 0, timeout: 0, allowed_updates: ["message"] });
      if (!d.ok) {
        if (d.error_code === 401) A.toast("Your Telegram bot's token stopped working: connect it again");
        else if (d.error_code === 409) A.toast("Your Telegram bot is connected to something else (a webhook): BT Feeder can't read it");
        else if (byHand) A.toast("Telegram: " + (d.description || "no answer"));
        return;
      }
      for (const u of d.result || []) {
        M.tg.offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.chat) continue;
        if (!M.tg.owner) { M.tg.owner = m.chat.id; M.tg.ownerName = (m.from && (m.from.username ? "@" + m.from.username : m.from.first_name)) || ""; }
        if (m.chat.id !== M.tg.owner) { tgSay(m.chat.id, "This bot is private."); continue; }
        const doc = m.document && (AUDIO.test(m.document.file_name || "") || /^audio\//.test(m.document.mime_type || "")) ? m.document : null;
        const f = m.audio || doc;
        if (!f) {
          if (m.text && /^\/start/.test(m.text)) tgSay(m.chat.id, "Hi! Send or forward songs here and they're added to your music in BT Feeder.");
          else if (m.voice || m.video || m.photo || m.text) tgSay(m.chat.id, "Send a song (an audio file) and it goes to your music in BT Feeder.", m.message_id);
          continue;
        }
        M.tg.seen = M.tg.seen || [];
        if (M.tg.seen.includes(f.file_unique_id)) { tgSay(m.chat.id, "Already in your music.", m.message_id); continue; }
        if (f.file_size > TG_MAX) { tgSay(m.chat.id, "Too big: Telegram lets bots download files up to 20 MB.", m.message_id); continue; }
        try {
          const t = await tgSave(f);
          M.tg.seen.push(f.file_unique_id);
          if (M.tg.seen.length > 5000) M.tg.seen.splice(0, 1000);
          added++;
          tgSay(m.chat.id, "✓ Added to your music: " + t.title + (t.artist ? " — " + t.artist : ""), m.message_id);
        } catch (e) {
          tgSay(m.chat.id, "Couldn't add it: " + (e.message || "error") + ". Send it again to retry.", m.message_id);
        }
        save();
      }
      save();
    } catch (e) {
      if (byHand) A.toast("Couldn't reach Telegram (offline?)");
    } finally { tgBusy = false; }
    if (added) {
      A.toast(plural(added, "song") + " from Telegram added to your music");
      if (document.body.classList.contains("inmusic")) render();
    } else if (byHand) A.toast("No new songs from Telegram");
  }

  async function telegram() {
    if (M.tg && M.tg.token) {
      return menu("Telegram bot", "@" + M.tg.bot + (M.tg.ownerName ? " · listening to " + M.tg.ownerName : " · send it a message to start"), [
        { label: "Check for new songs now", fn: () => tgPoll(true) },
        { label: "Open @" + M.tg.bot + " in Telegram", fn: () => window.open("https://t.me/" + M.tg.bot, "_blank", "noopener") },
        { label: "Connect another bot…", fn: () => connectBot() },
        { label: "Disconnect", danger: true, fn: () => { M.tg = null; save(); A.toast("Telegram bot disconnected"); render(); } }
      ]);
    }
    connectBot();
  }
  async function connectBot() {
    const r = await A.ask({ title: "Songs from Telegram",
      text: "Send or forward songs to your own Telegram bot and they're added to your music.\n\n1. In Telegram, open @BotFather and send /newbot.\n2. Paste the token it gives you here.\n3. Open your bot, press Start, then send it songs (from music bots too: forward them).\n\nOnly you can use it: the first person to message the bot. Telegram keeps messages for a day, so open BT Feeder within 24 hours of sending.",
      input: "", placeholder: "123456789:AA…", ok: "Connect" });
    if (r.action !== "ok" || !r.value) return;
    const token = r.value.replace(/\s+/g, "");
    if (!/^\d{5,15}:[\w-]{30,60}$/.test(token)) return A.toast("That doesn't look like a bot token (numbers:letters)");
    A.toast("Connecting…");
    let me;
    try { me = await tgCall("getMe", {}, token); } catch (e) { return A.toast("Couldn't reach Telegram (offline?)"); }
    if (!me || !me.ok) return A.toast("Telegram didn't accept that token");
    M.tg = { token, bot: me.result.username, owner: 0, offset: 0, seen: M.tg && M.tg.seen || [] };
    save();
    render();
    A.toast("Connected to @" + me.result.username + ". Send it songs!", "Open", () => window.open("https://t.me/" + me.result.username, "_blank", "noopener"));
    tgPoll(false);
  }

  // ---------- What app.js uses ----------

  async function init(api) {
    A = api;
    try {
      const [d, art, dir] = await Promise.all([Store.get("music"), Store.get("musicart"), Store.get("musicdir")]);
      if (d) {
        for (const t of d.tracks || []) M.tracks.set(t.id, t);
        M.playlists = d.playlists || [];
        M.artists = d.artists || {};
        M.source = d.source || null;
        M.tg = d.tg || null;
        const p = d.prefs || {};
        M.tab = p.tab || "songs"; M.sort = p.sort || "title"; M.shuffle = !!p.shuffle; M.repeat = p.repeat || "off";
        M.queue = (p.queue || []).filter(id => M.tracks.has(id)); M.qi = Math.min(p.qi == null ? -1 : p.qi, M.queue.length - 1); M.resumeAt = p.pos || 0;
      }
      for (const [k, v] of Object.entries(art || {})) M.art.set(k, v);
      if (dir) M.dir = dir;
      if (M.source && M.source.kind === "dir" && !M.dir) M.source = null;
    } catch (e) { /* nothing saved */ }
    // The last song, ready to carry on (paused)
    if (cur()) { barUi(); $("m-bar").hidden = false; document.body.classList.add("musicking"); }
    render();
    // Songs sent to your Telegram bot: now, and every two minutes while BT Feeder is open
    setTimeout(() => tgPoll(false), 3000);
    setInterval(() => { if (document.visibilityState === "visible") tgPoll(false); }, 120000);
  }

  return {
    init,
    show() { ensureListed(); render(); tgPoll(false); },
    telegram: () => telegram(),
    telegramLabel: () => M.tg ? "@" + M.tg.bot : "Off",
    back() {
      if (M.nowOpen) { closeNow(true); return true; }
      if (document.body.classList.contains("inmusic") && M.stack.length) { M.stack.pop(); render(); return true; }
      return false;
    },
    leave() { M.stack = []; },
    nowPlaying() { const t = cur(); return t && M.url && !$("m-bar").hidden ? { id: t.id, title: t.title, sub: t.artist || "", playing: M.playing } : null; },
    toggle, next: () => next(), prev, pause, stop,
    shuffleAll() { const ids = songs().map(t => t.id); if (!ids.length) return chooseFolder(); playList(ids, -1, true); },
    key(e) {
      if (e.target.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
      else if (e.key === "n" || e.key === "ArrowRight" && e.shiftKey) next();
      else if (e.key === "p" || e.key === "ArrowLeft" && e.shiftKey) prev();
      else if (e.key === "l") { const t = cur(); if (t) like(t); }
      else if (e.key === "/") { e.preventDefault(); $("m-searchbox").hidden = false; $("m-q").focus(); }
      else if (e.key === "Escape" && M.nowOpen) closeNow();
    }
  };
})();
