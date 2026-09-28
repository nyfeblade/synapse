/**
 * Bug 198: the phone app's service worker — only for call alerts. A push from the Mac (encrypted
 * end to end; the browser vendor's push service only relays it) shows "<Bot> is calling"; a tap
 * opens the app on that call.
 */

interface PushData { title?: string; body?: string; botId?: string; tag?: string }
interface Clientish { url: string; focus(): Promise<unknown>; postMessage(m: unknown): void }
interface SwScope {
  addEventListener(t: "install" | "activate", f: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "push", f: (e: { data: { json(): unknown } | null; waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(t: "notificationclick", f: (e: { notification: { data: unknown; close(): void }; waitUntil(p: Promise<unknown>): void }) => void): void;
  skipWaiting(): Promise<void>;
  registration: { showNotification(title: string, o: Record<string, unknown>): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(o: Record<string, unknown>): Promise<Clientish[]>; openWindow(url: string): Promise<unknown> };
}

const sw = self as unknown as SwScope;

sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("push", (e) => {
  let d: PushData = {};
  try { d = (e.data?.json() ?? {}) as PushData; } catch { /* a push with no JSON still rings */ }
  e.waitUntil(sw.registration.showNotification(d.title || "Synapse", {
    body: d.body ?? "", tag: d.tag ?? "call", icon: "/icon-192.png", badge: "/icon-192.png",
    data: { botId: typeof d.botId === "string" ? d.botId : null }, requireInteraction: true, renotify: true,
  }));
});

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const botId = (e.notification.data as { botId?: string | null } | null)?.botId ?? null;
  e.waitUntil(sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    const open = list[0];
    if (open) { await open.focus(); if (botId) open.postMessage({ type: "call", botId }); return; }
    await sw.clients.openWindow(botId ? `/?call=${encodeURIComponent(botId)}` : "/");
  }));
});
