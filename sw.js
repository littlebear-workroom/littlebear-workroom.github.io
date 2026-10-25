// 小熊工作室 service worker: shows phone notifications and opens the app when one is tapped.
// Shared by the teacher app (/) and the admin app (/office-…html); a notification with `url` belongs to the admin app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "小熊工作室", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || undefined, data: { view: d.view || "home", url: d.url || "" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {}, adminUrl = data.url || "";
  const url = adminUrl || "/?view=" + encodeURIComponent(data.view || "home");
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const isAdmin = (c) => /\/office-[^/]*\.html/.test(new URL(c.url).pathname);
    for (const c of all) {
      if (adminUrl ? !isAdmin(c) : isAdmin(c)) continue;
      if ("focus" in c) { if (!adminUrl) c.postMessage({ type: "open-view", view: data.view }); else c.postMessage({ type: "admin-refresh" }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
