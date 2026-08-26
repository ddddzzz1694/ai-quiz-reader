/* ============================================================
 * Service Worker - 离线能力
 * 首次访问后把页面资源缓存到本地，之后断网也能打开和刷题。
 * ============================================================ */
const CACHE = "quiz-app-v2";
const CORE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // API 请求不缓存（实时读服务器）
  if (url.pathname.includes("/api/")) return;

  // 导航请求（页面）：network-first——在线时永远拿最新页面，离线时用缓存兜底
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // 静态资源：cache-first，离线时用缓存兜底
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
