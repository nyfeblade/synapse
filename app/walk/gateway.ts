import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayCommands, SseEvent } from "@synapse/shared";
import { SseParser } from "../src/coordinator/sse-parser";

const boxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "box");

/** Same resolution order as box/orb.sh and app/src/main/orb-path.ts. */
export function resolveOrb(): string {
  if (process.env.ORB) return process.env.ORB;
  for (const p of ["/Applications/OrbStack.app/Contents/MacOS/bin/orb", "/usr/local/bin/orb"]) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return "orb";
}

export function orbExec(args: string[], timeoutMs = 20_000): string {
  return execFileSync(resolveOrb(), args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
}

/** gateway.json, read the way box/check-gateway.sh reads it, on the route route.env names. */
export function readGateway(): { baseUrl: string; token: string } {
  const env = Object.fromEntries(
    fs.readFileSync(path.join(boxDir, "route.env"), "utf8").split("\n").map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], m![2]]),
  ) as Record<string, string>;
  if (env.GATEWAY_ROUTE === "ssh-tunnel") throw new Error("walk: ssh-tunnel route is not supported by the walk client");
  const info = JSON.parse(orbExec(["-m", "box", "-u", "root", "cat", "/home/box/.host/gateway.json"])) as { port: number; token: string };
  const host = env.GATEWAY_ROUTE === "orb-hostname" ? (env.GATEWAY_HOST || "box.orb.local") : (env.GATEWAY_HOST || "127.0.0.1");
  return { baseUrl: `http://${host}:${info.port}`, token: info.token };
}

export class GatewayError extends Error { constructor(readonly code: string, msg: string) { super(msg); } }

type Rec = { at: number; ev: SseEvent };

export class Gateway {
  private ac = new AbortController();
  private log: Rec[] = [];
  private waiters = new Set<() => void>();
  private opened: Promise<void> | null = null;

  constructor(readonly baseUrl: string, private token: string) {}
  static fromBox(): Gateway { const g = readGateway(); return new Gateway(g.baseUrl, g.token); }

  get auth(): string { return `Bearer ${this.token}`; }

  async call<K extends keyof GatewayCommands>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
    const r = await fetch(`${this.baseUrl}/api/${String(cmd)}`, { method: "POST", headers: { authorization: this.auth, "content-type": "application/json" }, body: JSON.stringify(args ?? {}) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new GatewayError(j.error?.code ?? "unknown", `${String(cmd)}: ${j.error?.message ?? r.status}`);
    return j.result as GatewayCommands[K]["result"];
  }

  /** Subscribe to /events. Resolves once the stream is open, so nothing after this call is missed. */
  events(): Promise<void> {
    this.opened ??= (async () => {
      const res = await fetch(`${this.baseUrl}/events`, { headers: { authorization: this.auth, accept: "text/event-stream" }, signal: this.ac.signal });
      if (!res.ok || !res.body) throw new Error(`/events returned ${res.status}`);
      const parser = new SseParser((data) => {
        try { this.log.push({ at: Date.now(), ev: JSON.parse(data) as SseEvent }); } catch { return; }
        for (const w of [...this.waiters]) w();
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      void (async () => {
        try { for (;;) { const { value, done } = await reader.read(); if (done) break; parser.feed(value); } } catch { /* aborted */ }
      })();
    })();
    return this.opened;
  }

  mark(): number { return this.log.length; }
  since(mark: number): SseEvent[] { return this.log.slice(mark).map((r) => r.ev); }

  /** Waits on the SSE stream (never polls). Checks events from `mark` on, then every new one. */
  waitFor<T>(pick: (ev: SseEvent) => T | undefined | null | false, o: { from?: number; timeoutMs: number; label: string }): Promise<T> {
    let i = o.from ?? this.log.length;
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        for (; i < this.log.length; i++) {
          const v = pick(this.log[i]!.ev);
          if (v !== undefined && v !== null && v !== false) { done(); resolve(v as T); return; }
        }
      };
      const t = setTimeout(() => { done(); reject(new Error(`TIMEOUT (${o.timeoutMs} ms) waiting on /events: ${o.label}`)); }, o.timeoutMs);
      const done = () => { clearTimeout(t); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  close(): void { this.ac.abort(); }
}
