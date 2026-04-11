// Web Push subscription helper. Run from a user gesture (button click) so
// the permission prompt actually appears on iOS.

const VAPID_PUBLIC_KEY_URL = "/api/push/vapid";

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
}

export async function getStatus(): Promise<PushStatus> {
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (!supported) {
    return { supported: false, permission: "denied", subscribed: false };
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return {
    supported: true,
    permission: Notification.permission,
    subscribed: !!sub,
  };
}

export async function subscribe(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push not supported in this browser");
  }
  // Wait for SW to be ready (vite-plugin-pwa registers it on page load).
  const reg = await navigator.serviceWorker.ready;

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(`Notification permission: ${perm}`);
  }

  // Get VAPID public key from the server.
  const r = await fetch(VAPID_PUBLIC_KEY_URL);
  if (!r.ok) throw new Error("Failed to fetch VAPID public key");
  const { publicKey } = (await r.json()) as { publicKey: string };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const subJson = sub.toJSON() as {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  };

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subJson,
      deviceLabel: navigator.userAgent.slice(0, 80),
    }),
  });
}

export async function unsubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
}

export async function sendTest(): Promise<void> {
  const r = await fetch("/api/push/test", { method: "POST" });
  if (!r.ok) throw new Error(`test push failed: HTTP ${r.status}`);
}

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
