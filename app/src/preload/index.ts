import { contextBridge, ipcRenderer, webUtils } from "electron";

// Start-up timing mark (renderer/launch/trace.ts): when the preload ran, in ms since the page began.
try { console.info(`[launch] preload ${Math.round(performance.now())}`); } catch { /* no console */ }

// P5 review minor: a real drop registers its files' paths with the main process (readDroppedFile reads only those).
// webUtils.getPathForFile returns "" for a File the page built itself, so page script can't forge a path.
window.addEventListener("drop", (e) => {
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    const p = webUtils.getPathForFile(f);
    if (p) ipcRenderer.send("native:dropped-path", p);
  }
}, true);

let port: MessagePort | null = null;
let seq = 0;
let lastConnection: unknown = { kind: "starting" };
let vnc: { port: number; ticket: string } | null = null;
const outbox: unknown[] = [];
const pending = new Map<number, (r: unknown) => void>();
const eventSubs = new Set<(e: unknown) => void>();
const connSubs = new Set<(s: unknown) => void>();

function onMessage(d: { id?: number; response?: unknown; event?: unknown; connection?: unknown; vnc?: { port: number; ticket: string } }): void {
  if (d.id !== undefined) {
    pending.get(d.id)?.(d.response);
    pending.delete(d.id);
  } else if (d.vnc) {
    vnc = d.vnc;
  } else if (d.event) for (const s of eventSubs) s(d.event);
  else if (d.connection) {
    lastConnection = d.connection;
    for (const s of connSubs) s(d.connection);
  }
}

ipcRenderer.on("coordinator-port", (e) => {
  // A fresh port means main re-forked the coordinator: nothing will ever answer the calls that were
  // in flight, so they are settled here instead of leaving their callers pending for good.
  for (const resolve of pending.values()) resolve({ ok: false, error: { code: "NOT_CONNECTED", message: "The connection restarted. Try again." } });
  pending.clear();
  port = e.ports[0] ?? null;
  if (!port) return;
  port.onmessage = (m) => onMessage(m.data);
  port.start();
  for (const m of outbox.splice(0)) port.postMessage(m);
});

const nativeSubs = new Map<string, Set<(p: unknown) => void>>();
ipcRenderer.on("native-event", (_e, m: { channel: string; payload: unknown }) => {
  for (const cb of nativeSubs.get(m.channel) ?? []) cb(m.payload);
});

contextBridge.exposeInMainWorld("synapse", {
  call: (cmd: string, args: unknown) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      const msg = { id, cmd, args };
      if (port) port.postMessage(msg);
      else outbox.push(msg);
    }),
  onEvent: (cb: (e: unknown) => void) => {
    eventSubs.add(cb);
    return () => eventSubs.delete(cb);
  },
  onConnection: (cb: (s: unknown) => void) => {
    connSubs.add(cb);
    cb(lastConnection);
    return () => connSubs.delete(cb);
  },
  retry: () => ipcRenderer.send("retry-connection"),
  appInfo: () => ipcRenderer.invoke("app-info"),
  vncUrl: (botId: string) => (vnc ? `ws://127.0.0.1:${vnc.port}/vnc/${encodeURIComponent(botId)}?t=${vnc.ticket}` : null),
  secrets: {
    list: (botId: string) => ipcRenderer.invoke("secrets:list", botId),
    save: (botId: string, name: string, description: string, value: string) => ipcRenderer.invoke("secrets:save", botId, name, description, value),
    remove: (botId: string, name: string) => ipcRenderer.invoke("secrets:remove", botId, name),
    keepOnBox: (botId: string, names: string[]) => ipcRenderer.invoke("secrets:keep-on-box", botId, names),
    rename: (botId: string, from: string, to: string) => ipcRenderer.invoke("secrets:rename", botId, from, to),
    submitRequest: (botId: string, entryId: string, value: string, meta: unknown) => ipcRenderer.invoke("secrets:submit-request", botId, entryId, value, meta),
    submitForm: (botId: string, entryId: string, answers: unknown, secrets: unknown) => ipcRenderer.invoke("secrets:submit-form", botId, entryId, answers, secrets),
  },
  // Settings → Account: the key goes to main, which seals it to the box; nothing sends it back.
  auth: {
    saveKey: (value: string) => ipcRenderer.invoke("auth:save-key", value),
    testKey: (value: string) => ipcRenderer.invoke("auth:test-key", value),
    removeKey: () => ipcRenderer.invoke("auth:remove-key"),
    hasMacKey: () => ipcRenderer.invoke("auth:has-mac-key"),
    pinChanged: () => ipcRenderer.invoke("auth:pin-changed"),
    trustComputer: () => ipcRenderer.invoke("auth:trust-computer"),
  },
  providers: {
    saveKey: (provider: string, value: string) => ipcRenderer.invoke("providers:save-key", provider, value),
    testKey: (provider: string, value: string) => ipcRenderer.invoke("providers:test-key", provider, value),
  },
  box: {
    update: (force: boolean) => ipcRenderer.invoke("box:update", force),
    recover: () => ipcRenderer.invoke("box:recover"),
    reset: (alsoBots: boolean) => ipcRenderer.invoke("box:reset", alsoBots),
    info: () => ipcRenderer.invoke("box:info"),
    onLifecycle: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("box-lifecycle", h);
      return () => ipcRenderer.off("box-lifecycle", h);
    },
  },
  saveFile: (req: { path: string; name: string }) => ipcRenderer.invoke("save-file", req),
  onOpenBot: (cb: (botId: string) => void) => {
    const h = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on("open-bot", h);
    return () => ipcRenderer.removeListener("open-bot", h);
  },
  setNativeTheme: (pref: string) => ipcRenderer.send("native-theme", pref),
  native: {
    invoke: (name: string, args: unknown) => ipcRenderer.invoke("native", { name, args }),
    on: (channel: string, cb: (p: unknown) => void) => {
      const set = nativeSubs.get(channel) ?? new Set();
      set.add(cb);
      nativeSubs.set(channel, set);
      return () => set.delete(cb);
    },
  },
});
