// Service worker. vite-plugin-pwa's `injectManifest` strategy compiles this
// file and injects the precache manifest at `self.__WB_MANIFEST`. We use
// Workbox for precaching but our own `push` and `notificationclick` handlers.

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare let self: ServiceWorkerGlobalScope;

// Precache the build manifest. (vite-plugin-pwa replaces this at build time.)
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Take control of open clients ASAP so updates roll out without a refresh.
self.skipWaiting();
clientsClaim();

interface PushPayload {
  title?: string;
  body?: string;
  sessionId?: string;
  hostId?: string;
  timestamp?: number;
}

self.addEventListener("push", (event: PushEvent) => {
  let data: PushPayload = {};
  if (event.data) {
    try {
      data = event.data.json() as PushPayload;
    } catch {
      data = { body: event.data.text() };
    }
  }
  const title = data.title || "skybase";
  const body = data.body || "";
  const sessionId = data.sessionId;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: sessionId, // collapses repeats for the same session
      data: { sessionId, hostId: data.hostId },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as {
    sessionId?: string;
  };
  const target = data.sessionId
    ? `/session/${encodeURIComponent(data.sessionId)}`
    : "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await (client as WindowClient).navigate(target);
            } catch {
              // cross-origin or detached; ignore
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
