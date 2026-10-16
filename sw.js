// 奄美 運航情報 — 通知を受け取るための Service Worker
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = { title: "奄美 運航情報", body: "運航状況が変わりました。", url: "./" };
  try { msg = { ...msg, ...event.data.json() }; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { url: msg.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) { c.navigate(url); return c.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
