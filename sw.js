// 缓存页面和数据：网络优先（最多等几秒），取不到就用上次缓存的，离线也能打开。
// v2：页面和 engine.js 改为网络优先，并且按不带参数的地址存，更新后不会再用到旧程序。
const CACHE = "a-stock-v2";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./engine.js"])).catch(() => {}));
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
  const key = u.origin + u.pathname;              // 忽略 ?v=… 之类的参数，同一个文件只存一份
  const wait = u.pathname.includes("/data/") ? 6000 : 5000;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await Promise.race([
        fetch(e.request, { cache: "no-cache" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), wait)),
      ]);
      if (r.ok) c.put(key, r.clone());
      return r;
    } catch (err) {
      const m = await c.match(key);
      if (m) return m;
      throw err;
    }
  })());
});
