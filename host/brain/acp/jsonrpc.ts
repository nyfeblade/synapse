import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over newline-delimited JSON (ACP's stdio transport: one message per line, no embedded newlines).
 * Both sides send requests: the client calls initialize / session/new / session/prompt, the agent calls
 * session/request_permission, fs/* and terminal/*. An incoming request is answered with whatever its handler returns,
 * or with the RpcError it throws; any other throw becomes an internal error with no detail (nothing of ours leaks).
 */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = "RpcError"; }
}
/** JSON-RPC's own codes, and ACP's "authentication required". */
export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, authRequired: -32000 } as const;

/** One line may not pass this (a runaway or hostile agent can't make the host buffer without end). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface RpcHandlers {
  request(method: string, params: unknown): Promise<unknown>;
  notification(method: string, params: unknown): void;
}

type Id = number | string;
interface Pending { resolve(v: unknown): void; reject(e: Error): void }

export class JsonRpcPeer {
  private seq = 0;
  private pending = new Map<Id, Pending>();
  private buf = "";
  private closedWith: Error | null = null;
  private closeListeners = new Set<(e: Error) => void>();

  constructor(private input: Readable, private output: Writable, private handlers: RpcHandlers) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.close(new Error("the agent closed its output")));
    input.on("error", (e: Error) => this.close(e));
    output.on("error", (e: Error) => this.close(e));
  }

  get closed(): boolean { return this.closedWith !== null; }
  onClose(cb: (e: Error) => void): () => void {
    if (this.closedWith) { cb(this.closedWith); return () => {}; }
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = () => { if (timer) clearTimeout(timer); this.pending.delete(id); };
      this.pending.set(id, { resolve: (v) => { done(); resolve(v as T); }, reject: (e) => { done(); reject(e); } });
      if (timeoutMs) timer = setTimeout(() => this.pending.get(id)?.reject(new RpcError(RPC.internal, `${method} timed out`)), timeoutMs);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedWith) this.send({ jsonrpc: "2.0", method, params });
  }

  close(reason: Error = new Error("closed")): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    for (const p of [...this.pending.values()]) p.reject(reason);
    this.pending.clear();
    for (const l of this.closeListeners) l(reason);
    this.closeListeners.clear();
  }

  private send(msg: unknown): void {
    try { this.output.write(`${JSON.stringify(msg)}\n`); } catch (e) { this.close(e instanceof Error ? e : new Error(String(e))); }
  }

  private onData(chunk: string): void {
    if (this.closedWith) return;
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      if (this.closedWith) return;
    }
    if (Buffer.byteLength(this.buf) > MAX_LINE_BYTES) this.close(new Error("the agent sent a message over the size limit"));
  }

  private onLine(line: string): void {
    let msg: { id?: Id | null; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try { msg = JSON.parse(line); } catch { this.send({ jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: "Parse error" } }); return; }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      const hasId = msg.id !== undefined && msg.id !== null;
      if (!hasId) { try { this.handlers.notification(msg.method, msg.params); } catch { /* a bad notification is dropped */ } return; }
      const id = msg.id as Id;
      void this.handlers.request(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (e: unknown) => this.send({ jsonrpc: "2.0", id, error: e instanceof RpcError ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } : { code: RPC.internal, message: "Internal error" } }),
      );
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new RpcError(typeof msg.error.code === "number" ? msg.error.code : RPC.internal, typeof msg.error.message === "string" ? msg.error.message : "error", msg.error.data));
    else p.resolve(msg.result);
  }
}
