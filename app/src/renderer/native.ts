import { GatewayCallError } from "@synapse/shared";

export async function nativeCall<T>(name: string, args: unknown = {}): Promise<T> {
  const r = await window.synapse.native.invoke(name, args);
  if (!r.ok) throw new GatewayCallError(r.error.code, r.error.message);
  return r.result as T;
}

export function onNative<T>(channel: string, cb: (p: T) => void): () => void {
  return window.synapse.native.on(channel, (p) => cb(p as T));
}
