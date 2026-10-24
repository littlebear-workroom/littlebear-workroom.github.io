// 小熊工作室 service worker: shows phone notifications and opens the app when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "小熊工作室", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || undefined, data: { view: d.view || "home" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = "/?view=" + encodeURIComponent((e.notification.data && e.notification.data.view) || "home");
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { c.postMessage({ type: "open-view", view: e.notification.data && e.notification.data.view }); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
