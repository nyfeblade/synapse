import type { ComposioStatusView } from "@synapse/shared";
import type { Call } from "../gateway-call";

/**
 * Settings → Connected accounts → Composio → Paste key. The clipboard is read HERE, in the main process, only when
 * the user clicks Paste, and the key goes straight to the host (setComposioKey), which checks it with Composio and
 * seals it. The renderer never holds the key, and nothing here logs it or returns it.
 */
export async function pasteComposioKey(o: { readClipboard(): string | Promise<string>; call(): Call | null }): Promise<ComposioStatusView> {
  const call = o.call();
  if (!call) throw new Error("Synapse isn't connected to its host yet.");
  const key = await o.readClipboard();
  return call("setComposioKey", { key });
}

export function registerComposioPaste(o: { reg(name: string, fn: (a: unknown) => unknown): void; readClipboard(): string | Promise<string>; call(): Call | null }): void {
  o.reg("composio.pasteKey", () => pasteComposioKey(o));
}
