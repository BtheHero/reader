// Everything the reader remembers lives in this browser's IndexedDB: subscriptions, articles,
// read/starred state and settings. Nothing is sent to a server except the feed URLs being refreshed.

const Store = (() => {
  const DB_NAME = "rss-reader", VERSION = 1;
  let dbp = null;

  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
        if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "key" }).createIndex("feedId", "feedId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    get: (key) => tx("kv", "readonly", s => reqP(s.get(key))),
    set: (key, val) => tx("kv", "readwrite", s => { s.put(val, key); }),
    allItems: () => tx("items", "readonly", s => reqP(s.getAll())),
    putItems: (items) => items.length ? tx("items", "readwrite", s => { for (const it of items) s.put(it); }) : Promise.resolve(),
    deleteItems: (keys) => keys.length ? tx("items", "readwrite", s => { for (const k of keys) s.delete(k); }) : Promise.resolve()
  };
})();
