// 缓存页面和数据：再次打开时先显示上次的内容，同时在后台取最新数据。
const CACHE = "a-stock-v1";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./"])).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.includes("/data/")) {
    // 数据：优先取网络（最多等 6 秒），取不到就用上次缓存的
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const key = u.origin + u.pathname;
      try {
        const r = await Promise.race([
          fetch(e.request),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
        ]);
        if (r.ok) c.put(key, r.clone());
        return r;
      } catch (err) {
        const m = await c.match(key);
        if (m) return m;
        throw err;
      }
    })());
    return;
  }
  // 页面：先给缓存（秒开），后台更新缓存，下次打开就是新的
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const m = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => m);
    return m || net;
  })());
});
