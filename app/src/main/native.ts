import type { BrowserWindow, IpcMain } from "electron";
import { sendToRenderer } from "./to-renderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NativeHandler = (args: any) => unknown | Promise<unknown>;
const handlers = new Map<string, NativeHandler>();
let windowOf: () => BrowserWindow | null = () => null;

export function registerNative(name: string, fn: NativeHandler): void {
  handlers.set(name, fn);
}

const taps: ((channel: string, payload: unknown) => void)[] = [];
/** Crash reporting watches native events (a dictation helper that exited abnormally) without the modules knowing. */
export function tapNative(fn: (channel: string, payload: unknown) => void): void {
  taps.push(fn);
}

export function emitNative(channel: string, payload: unknown): void {
  for (const t of taps) { try { t(channel, payload); } catch { /* a tap never breaks an event */ } }
  sendToRenderer(windowOf(), "native-event", { channel, payload });
}

export function installNativeIpc(ipc: Pick<IpcMain, "handle">, getWin: () => BrowserWindow | null): void {
  windowOf = getWin;
  ipc.handle("native", async (_e, msg: { name: string; args: unknown }) => {
    const fn = handlers.get(msg?.name);
    if (!fn) return { ok: false, error: { code: "UNKNOWN_NATIVE", message: `Unknown native call ${String(msg?.name)}` } };
    try {
      return { ok: true, result: (await fn(msg.args ?? {})) ?? null };
    } catch (e) {
      return { ok: false, error: { code: "NATIVE_ERROR", message: (e as Error).message } };
    }
  });
}
