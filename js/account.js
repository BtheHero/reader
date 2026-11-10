// Accounts and sync (optional). BT Feeder works signed out exactly as before; signing in (email + password,
// Firebase Authentication) keeps feeds, groups, filters, settings, starred posts and read state the same on
// every device, through Cloud Firestore:
//
//   users/{uid}                 { feedMap: { <feed id>: feed }, settings: { <name>: value }, updatedAt }
//                               each feed and each setting is written on its own, so changes made on two
//                               devices at once don't undo each other
//   users/{uid}/stars/{key}     a starred post, with its content                    one per starred post
//   users/{uid}/reads/{feedId}  { m: { <post hash>: ±time } }  read (+) / unread (-) and when, per feed
//
// Each device keeps its own full copy in IndexedDB (store.js); this file only mirrors changes both ways.

const Account = (() => {
  const SDK = "https://www.gstatic.com/firebasejs/11.10.0/";
  let api = null;          // functions from app.js
  let fb = null;           // loaded Firebase modules
  let auth = null, db = null, user = null;
  let unsub = [];          // live listeners while signed in
  let deviceId = "";  // (kept for future per-device needs)
  let writeTimer = 0, writeQueued = false, heldRemote = null;
  // What the account holds, as far as this device knows: feed id / setting name -> JSON
  const synced = { feeds: new Map(), settings: new Map() };
  const readTimers = new Map();
  const remoteReads = new Map();     // feedId -> { hash: ±time } as last seen from the account
  let status = "off";                // off | syncing | synced | offline | error
  let applying = false;              // true while applying remote changes (don't echo them back)

  const $ = (id) => document.getElementById(id);
  const enabled = () => typeof FIREBASE_CONFIG === "object" && FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey;

  // Short, Firestore-safe id for a post (posts' own ids can be long URLs)
  function hash(s) {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }
  const starId = (key) => hash(key) + "_" + key.length;

  // ---------- Loading Firebase ----------

  async function load() {
    if (fb) return fb;
    const [app, authM, fs] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js")]);
    fb = { ...app, ...authM, ...fs };
    const firebaseApp = fb.initializeApp(FIREBASE_CONFIG);
    auth = fb.getAuth(firebaseApp);
    db = fb.getFirestore(firebaseApp);
    // Tests point these at the local Firebase emulators
    if (window.READER_EMULATOR) {
      fb.connectAuthEmulator(auth, "http://127.0.0.1:" + window.READER_EMULATOR.auth, { disableWarnings: true });
      fb.connectFirestoreEmulator(db, "127.0.0.1", window.READER_EMULATOR.firestore);
    }
    fb.onAuthStateChanged(auth, (u) => { user = u; u ? startSync() : stopSync(); render(); });
    return fb;
  }

  // ---------- Start-up ----------

  async function init(appApi) {
    api = appApi;
    $("account-btn").hidden = !enabled();
    if (!enabled()) return;
    deviceId = (await Store.get("deviceId")) || Math.random().toString(36).slice(2) + Date.now().toString(36);
    Store.set("deviceId", deviceId);
    $("account-btn").onclick = openDialog;
    render();
    // Only load Firebase straight away if this device was signed in (it restores the session)
    if (await Store.get("signedIn")) load().catch(() => setStatus("offline"));
  }

  // ---------- Sign in / out ----------

  const MESSAGES = {
    "auth/invalid-credential": "Wrong email or password.", "auth/wrong-password": "Wrong email or password.", "auth/user-not-found": "No account with that email. Create one?",
    "auth/invalid-email": "That doesn't look like an email address.", "auth/email-already-in-use": "There's already an account with that email. Sign in instead?",
    "auth/weak-password": "Use at least 6 characters for the password.", "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
    "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.", "auth/missing-password": "Enter your password.",
    "auth/requires-recent-login": "For your safety, enter your password again."
  };
  const message = (e) => MESSAGES[e && e.code] || (e && e.message ? e.message.replace(/^Firebase: /, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "") : "Something went wrong.");

  async function signIn(email, password, create) {
    await load();
    const cred = create ? await fb.createUserWithEmailAndPassword(auth, email, password) : await fb.signInWithEmailAndPassword(auth, email, password);
    if (create) fb.sendEmailVerification(cred.user).catch(() => {});
    await Store.set("signedIn", true);
    return cred.user;
  }

  async function signOut() {
    await flush();
    await fb.signOut(auth);
    await Store.set("signedIn", false);
    api.toast("Signed out. This device keeps its copy of your feeds.");
  }

  async function resetPassword(email) {
    await load();
    await fb.sendPasswordResetEmail(auth, email);
  }

  // Deleting an account removes its synced data and the sign-in itself (the copy on this device stays)
  async function deleteAccount(password) {
    const cred = fb.EmailAuthProvider.credential(user.email, password);
    await fb.reauthenticateWithCredential(user, cred);
    const uid = user.uid;
    stopSync();
    for (const sub of ["stars", "reads"]) {
      const snap = await fb.getDocs(fb.collection(db, "users", uid, sub));
      await Promise.all(snap.docs.map(d => fb.deleteDoc(d.ref)));
    }
    await fb.deleteDoc(fb.doc(db, "users", uid));
    await fb.deleteUser(user);
    await Store.set("signedIn", false);
    api.toast("Account deleted");
  }

  // ---------- Sync ----------

  const SYNC_FEED_FIELDS = ["id", "url", "title", "siteUrl", "icon", "group", "filters", "customTitle", "x", "added", "podcast", "podMin", "groupOnly", "priority"];
  const cleanFeed = (f) => Object.fromEntries(SYNC_FEED_FIELDS.filter(k => f[k] !== undefined).map(k => [k, f[k]]));
  const LOCAL_SETTINGS = ["v"];      // stay per device
  const cleanSettings = (s) => Object.fromEntries(Object.entries(s).filter(([k, v]) => !LOCAL_SETTINGS.includes(k) && v !== undefined));
  const stateDoc = () => fb.doc(db, "users", user.uid);

  function setStatus(s) { status = s; render(); }

  async function startSync() {
    stopSync();
    setStatus("syncing");
    try {
      const snap = await fb.getDoc(stateDoc());
      if (snap.exists()) await mergeInto(snap.data());
      await writeState(true);
      await uploadLocal();
      listen();
      setStatus("synced");
    } catch (e) {
      console.error(e);
      setStatus(navigator.onLine === false ? "offline" : "error");
    }
  }

  function stopSync() {
    unsub.forEach(u => u());
    unsub = [];
    remoteReads.clear();
    synced.feeds.clear();
    synced.settings.clear();
    clearTimeout(writeTimer);
    writeQueued = false;
    if (!user) setStatus("off");
  }

  // First sign-in on this device: combine what's here with what's in the account.
  // Feeds are matched by address (the account's copy wins for name, group, filters); feeds only on this device
  // are added to the account; the account's settings win, except keys it doesn't have.
  async function mergeInto(remote) {
    applying = true;
    try {
      remember(remote);
      const remoteFeeds = Object.values(remote.feedMap || {});
      const byUrl = new Map(remoteFeeds.map(f => [f.url, f]));
      for (const f of api.getFeeds()) {
        const r = byUrl.get(f.url);
        if (r && r.id !== f.id) await api.remapFeed(f.id, r.id);
      }
      const localById = new Map(api.getFeeds().map(f => [f.id, f]));
      const merged = remoteFeeds.map(r => ({ lastFetch: 0, error: "", ...(localById.get(r.id) || {}), ...r }));
      // Feeds only on this device join the account (written by writeState next)
      for (const f of api.getFeeds()) if (!merged.some(m => m.id === f.id)) merged.push(f);
      await api.setFeeds(merged);
      await api.setSettings({ ...api.getSettings(), ...(remote.settings || {}) });
      const fresh = remoteFeeds.filter(r => !localById.has(r.id));
      if (fresh.length) api.refresh(merged.filter(m => fresh.some(r => r.id === m.id)));
    } finally { applying = false; }
  }

  // Note what the account holds
  function remember(d) {
    synced.feeds = new Map(Object.entries(d.feedMap || {}).map(([id, f]) => [id, JSON.stringify(cleanFeed(f))]));
    synced.settings = new Map(Object.entries(d.settings || {}).map(([k, v]) => [k, JSON.stringify(v)]));
  }

  async function uploadLocal() {
    // Starred posts on this device that the account doesn't have yet
    const stars = [...api.getItems().values()].filter(i => i.star);
    const existing = await fb.getDocs(fb.collection(db, "users", user.uid, "stars"));
    const have = new Set(existing.docs.map(d => d.id));
    await Promise.all(stars.filter(i => !have.has(starId(i.key))).map(i => writeStar(i)));
    // Read state of every feed (merged into what's there)
    await Promise.all(api.getFeeds().map(f => writeReads(f.id)));
  }

  function listen() {
    unsub.push(fb.onSnapshot(stateDoc(), (snap) => {
      // A change of ours is on its way: its own snapshot (with everything merged) comes right after
      if (!snap.exists() || snap.metadata.hasPendingWrites) return;
      if (writeQueued) { heldRemote = snap.data(); return; }
      heldRemote = null;
      applyState(snap.data());
    }, () => setStatus("offline")));
    unsub.push(fb.onSnapshot(fb.collection(db, "users", user.uid, "stars"), (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      applying = true;
      try {
        for (const ch of snap.docChanges()) {
          const data = ch.doc.data();
          if (ch.type === "removed") api.applyStar(data.key, false);
          else api.applyStar(data.key, true, data);
        }
      } finally { applying = false; }
    }, () => setStatus("offline")));
    unsub.push(fb.onSnapshot(fb.collection(db, "users", user.uid, "reads"), (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      for (const ch of snap.docChanges()) {
        if (ch.type === "removed") continue;
        remoteReads.set(ch.doc.id, (ch.doc.data() || {}).m || {});
        applyReads(ch.doc.id);
      }
      setStatus("synced");
    }, () => setStatus("offline")));
  }

  // Another device changed feeds or settings
  async function applyState(d) {
    const known = new Set(synced.feeds.keys());
    remember(d);
    const remoteFeeds = Object.values(d.feedMap || {});
    const localById = new Map(api.getFeeds().map(f => [f.id, f]));
    const sameFeeds = remoteFeeds.length === localById.size && remoteFeeds.every(r => localById.has(r.id) && JSON.stringify(cleanFeed(localById.get(r.id))) === JSON.stringify(cleanFeed(r)));
    const settings = { ...api.getSettings(), ...(d.settings || {}) };
    const sameSettings = JSON.stringify(cleanSettings(settings)) === JSON.stringify(cleanSettings(api.getSettings()));
    if (sameFeeds && sameSettings) return setStatus("synced");
    applying = true;
    try {
      if (!sameFeeds) {
        const feeds = remoteFeeds.map(r => ({ lastFetch: 0, error: "", ...(localById.get(r.id) || {}), ...r }));
        // Feeds added on this device that haven't reached the account yet stay
        for (const f of api.getFeeds()) if (!known.has(f.id) && !feeds.some(n => n.id === f.id)) feeds.push(f);
        const added = feeds.filter(f => !localById.has(f.id));
        const removed = api.getFeeds().filter(f => known.has(f.id) && !feeds.some(n => n.id === f.id)).map(f => f.id);
        await api.setFeeds(feeds, removed);
        if (added.length) api.refresh(added);
      }
      if (!sameSettings) await api.setSettings(settings);
    } finally { applying = false; }
    setStatus("synced");
  }

  // Apply the account's read marks to this feed's posts: whichever change is newer wins
  function applyReads(feedId) {
    const m = remoteReads.get(feedId);
    if (!m) return;
    const changed = [];
    for (const it of api.getItems().values()) {
      if (it.feedId !== feedId) continue;
      const r = m[hash(it.id || it.link)];
      if (!r || Math.abs(r) <= (it.readAt || 0)) continue;
      it.readAt = Math.abs(r);
      if (it.read !== r > 0) { it.read = r > 0; changed.push(it); }
      else changed.push(it);
    }
    if (changed.length) { applying = true; try { api.itemsUpdated(changed); } finally { applying = false; } }
  }

  // ---------- Writing ----------

  // Send only what changed since the account was last seen: each feed and setting is its own field
  function writeState(now) {
    if (!user) return Promise.resolve();
    clearTimeout(writeTimer);
    writeQueued = true;
    const go = async () => {
      writeQueued = false;
      const upd = {}, nextFeeds = new Map(synced.feeds), nextSettings = new Map(synced.settings);
      const local = new Map(api.getFeeds().map(f => [f.id, cleanFeed(f)]));
      for (const [id, f] of local) { const j = JSON.stringify(f); if (synced.feeds.get(id) !== j) { upd["feedMap." + id] = f; nextFeeds.set(id, j); } }
      const gone = [...synced.feeds.keys()].filter(id => !local.has(id));
      for (const id of gone) { upd["feedMap." + id] = fb.deleteField(); nextFeeds.delete(id); }
      const st = cleanSettings(api.getSettings());
      for (const [k, v] of Object.entries(st)) { const j = JSON.stringify(v); if (synced.settings.get(k) !== j) { upd["settings." + k] = v; nextSettings.set(k, j); } }
      for (const k of synced.settings.keys()) if (!(k in st)) { upd["settings." + k] = fb.deleteField(); nextSettings.delete(k); }
      if (!Object.keys(upd).length) {
        // Nothing of ours to send, so no fresh snapshot is coming: apply the one held back meanwhile
        if (heldRemote) { const d = heldRemote; heldRemote = null; applyState(d); }
        return;
      }
      // (When we do write, the snapshot that follows our write carries everyone's latest changes)
      heldRemote = null;
      setStatus("syncing");
      try {
        try { await fb.updateDoc(stateDoc(), { ...upd, updatedAt: Date.now() }); }
        catch (e) {
          if (e.code !== "not-found") throw e;
          // First write for this account
          await fb.setDoc(stateDoc(), { feedMap: Object.fromEntries(local), settings: st, updatedAt: Date.now() });
        }
        synced.feeds = nextFeeds;
        synced.settings = nextSettings;
        // An unsubscribed feed takes its starred posts and read marks with it (as on this device)
        for (const id of gone) forgetFeed(id).catch(() => {});
        setStatus("synced");
      } catch (e) { console.error(e); setStatus("error"); }
    };
    if (now) return go();
    writeTimer = setTimeout(go, 50);
    return Promise.resolve();
  }

  async function forgetFeed(feedId) {
    const stars = await fb.getDocs(fb.query(fb.collection(db, "users", user.uid, "stars"), fb.where("feedId", "==", feedId)));
    await Promise.all([...stars.docs.map(d => fb.deleteDoc(d.ref)), fb.deleteDoc(fb.doc(db, "users", user.uid, "reads", feedId))]);
    remoteReads.delete(feedId);
  }

  function writeStar(it) {
    const ref = fb.doc(db, "users", user.uid, "stars", starId(it.key));
    if (!it.star) return fb.deleteDoc(ref);
    // The post's content travels with it (capped, Firestore documents hold up to 1 MB)
    const data = { key: it.key, feedId: it.feedId, id: it.id || "", title: it.title || "", link: it.link || "", date: it.date || 0, author: it.author || "",
      html: (it.html || "").slice(0, 200000), image: it.image || "", video: it.video || null, starredAt: Date.now() };
    return fb.setDoc(ref, data);
  }

  // A feed's read marks: merged into the account's map; pruned to this feed's current posts when it grows large
  async function writeReads(feedId) {
    if (!user) return;
    const m = {};
    for (const it of api.getItems().values()) if (it.feedId === feedId && it.readAt) m[hash(it.id || it.link)] = it.read ? it.readAt : -it.readAt;
    const remote = remoteReads.get(feedId) || {};
    const ref = fb.doc(db, "users", user.uid, "reads", feedId);
    if (Object.keys(remote).length > 1500) {
      // Keep only marks for posts still around (newer of local / account for each)
      const keep = {};
      for (const [k, v] of Object.entries(m)) keep[k] = Math.abs(remote[k] || 0) > Math.abs(v) ? remote[k] : v;
      remoteReads.set(feedId, keep);
      return fb.setDoc(ref, { m: keep });
    }
    if (!Object.keys(m).length) return;
    remoteReads.set(feedId, { ...remote, ...m });
    return fb.setDoc(ref, { m }, { merge: true });
  }

  function queueReads(feedId) {
    clearTimeout(readTimers.get(feedId));
    readTimers.set(feedId, setTimeout(() => { readTimers.delete(feedId); writeReads(feedId).catch(() => setStatus("error")); }, 2000));
  }

  async function flush() {
    if (!user) return;
    clearTimeout(writeTimer);
    await writeState(true);
    const pending = [...readTimers.keys()];
    readTimers.forEach(t => clearTimeout(t));
    readTimers.clear();
    await Promise.all(pending.map(writeReads));
  }

  // ---------- Hooks called by app.js ----------

  function changed(what) {
    if (!user || applying) return;
    if (what === "feeds" || what === "settings") writeState();
  }

  function itemChanged(it, what) {
    if (!user || applying || !it) return;
    if (what === "star") writeStar(it).catch(() => setStatus("error"));
    else queueReads(it.feedId);
  }

  // New posts arrived from a refresh: apply read marks other devices made on them
  function itemsAdded(feedId) { if (user) applyReads(feedId); }

  // ---------- Dialog ----------

  function render() {
    const btn = $("account-btn");
    if (!btn || !enabled()) return;
    const label = btn.querySelector(".acc-label"), sub = btn.querySelector(".acc-sub");
    if (user) {
      label.textContent = user.email;
      sub.textContent = { syncing: "Syncing…", synced: "Synced", offline: "Offline · will sync later", error: "Sync problem · tap for details", off: "" }[status] || "";
    } else {
      label.textContent = "Sign in";
      sub.textContent = "Sync your feeds across devices";
    }
    btn.classList.toggle("signed-in", !!user);
    btn.classList.toggle("problem", status === "error");
    // Redraw the dialog only when someone signs in or out (not while they're typing); otherwise just its status line
    if ($("account-dialog").open) {
      if ((user ? user.uid : null) !== dialogFor) renderDialog();
      else if (user) { const st = $("acc-body").querySelector(".acc-state"); if (st) st.textContent = stateText(); }
    }
  }

  const stateText = () => ({ syncing: "Syncing…", synced: "Your feeds, groups, filters, settings, stars and read posts are in sync on every device you sign in on.", offline: "Offline: changes will sync when you're back online.", error: "Something went wrong syncing. It'll try again on the next change.", off: "" }[status] || "");
  let dialogFor = null;

  let mode = "signin";   // signin | create | reset | delete
  function openDialog() {
    api.closeDrawer();
    mode = "signin";
    renderDialog();
    $("account-dialog").showModal();
    load().catch(() => showError("Can't reach the sign-in service. Check your connection."));
  }

  function showError(msg) { const e = $("acc-error"); e.textContent = msg || ""; e.hidden = !msg; }

  function renderDialog() {
    const box = $("acc-body");
    box.textContent = "";
    dialogFor = user ? user.uid : null;
    const el = api.el;
    showError("");
    if (user && mode !== "delete") {
      box.append(el("h2", null, "Your account"), el("p", null, "Signed in as " + user.email + (user.emailVerified ? "" : " (email not verified yet)")),
        el("p", "acc-state", stateText()));
      const row = el("div", "actions");
      const del = el("button", "btn danger", "Delete account"); del.type = "button"; del.onclick = () => { mode = "delete"; renderDialog(); };
      const out = el("button", "btn", "Sign out"); out.type = "button"; out.onclick = async () => { await signOut(); $("account-dialog").close(); };
      const done = el("button", "btn primary", "Done"); done.type = "button"; done.onclick = () => $("account-dialog").close();
      row.append(del, el("span", "grow"), out, done);
      box.append(row);
      return;
    }
    if (mode === "delete") {
      box.append(el("h2", null, "Delete your account?"), el("p", null, "This removes your synced feeds, settings, stars and read posts from the account, and the account itself. This device keeps its own copy. Enter your password to confirm."));
      const pw = input("password", "Password", "current-password");
      box.append(pw);
      const row = el("div", "actions");
      const back = el("button", "btn", "Cancel"); back.type = "button"; back.onclick = () => { mode = "signin"; renderDialog(); };
      const go = el("button", "btn danger", "Delete account"); go.type = "submit";
      row.append(el("span", "grow"), back, go);
      box.append(row);
      submitHandler = async () => { await deleteAccount(pw.querySelector("input").value); mode = "signin"; $("account-dialog").close(); };
      return;
    }
    const titles = { signin: "Sign in", create: "Create an account", reset: "Reset your password" };
    box.append(el("h2", null, titles[mode]));
    box.append(el("p", null, mode === "reset" ? "We'll email you a link to choose a new password." : "Sync your feeds, groups, filters, settings, stars and read posts across your devices. BT Feeder still works without an account."));
    const email = input("email", "Email", "email");
    box.append(email);
    let pw = null;
    if (mode !== "reset") { pw = input("password", "Password", mode === "create" ? "new-password" : "current-password"); box.append(pw); }
    const row = el("div", "actions acc-actions");
    const links = el("div", "acc-links");
    const link = (text, m) => { const b = el("button", "link", text); b.type = "button"; b.onclick = () => { const v = email.querySelector("input").value; mode = m; renderDialog(); $("acc-body").querySelector('input[type="email"]').value = v; }; return b; };
    if (mode === "signin") links.append(link("Create an account", "create"), link("Forgot password?", "reset"));
    else links.append(link("I have an account", "signin"));
    const go = el("button", "btn primary", mode === "signin" ? "Sign in" : mode === "create" ? "Create account" : "Send link");
    go.type = "submit";
    row.append(links, el("span", "grow"), go);
    box.append(row);
    submitHandler = async () => {
      const e = email.querySelector("input").value.trim();
      if (mode === "reset") { await resetPassword(e); box.querySelector("p").textContent = "Check your inbox: a reset link is on its way to " + e + "."; return; }
      const creating = mode === "create";
      await signIn(e, pw.querySelector("input").value, creating);
      mode = "signin";
      $("account-dialog").close();
      api.toast(creating ? "Account created. Your feeds are syncing." : "Signed in. Syncing your feeds…");
    };
    setTimeout(() => email.querySelector("input").focus(), 0);
  }

  function input(type, label, autocomplete) {
    const l = api.el("label", null, label + " ");
    const i = api.el("input");
    i.type = type; i.required = true; i.autocomplete = autocomplete;
    if (type === "password") i.minLength = 6;
    l.append(i);
    return l;
  }

  let submitHandler = null;
  function bindDialog() {
    $("acc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!submitHandler) return;
      const btn = $("acc-form").querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      showError("");
      try { await submitHandler(); } catch (err) { showError(message(err)); }
      finally { if (btn) btn.disabled = false; }
    });
    $("acc-close").onclick = () => $("account-dialog").close();
  }
  document.addEventListener("DOMContentLoaded", bindDialog);
  if (document.readyState !== "loading") bindDialog();

  return { init, changed, itemChanged, itemsAdded, get signedIn() { return !!user; } };
})();
