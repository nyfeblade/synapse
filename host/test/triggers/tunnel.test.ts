import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebhookTunnel } from "../../triggers/tunnel";

function fakeSpawn() {
  const calls: { cmd: string; args: string[] }[] = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; (this as unknown as EventEmitter).emit("exit", 0); return true; } });
  const spawn = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return child; }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, child, calls };
}

describe("WebhookTunnel (RTN-11 optional public URL)", () => {
  it("starts a cloudflared quick tunnel and reports its URL, then null on exit", () => {
    const f = fakeSpawn();
    const urls: (string | null)[] = [];
    const t = new WebhookTunnel({ spawn: f.spawn, port: 47801, onUrl: (u) => urls.push(u) });
    t.start();
    expect(f.calls[0]).toEqual({ cmd: "cloudflared", args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:47801"] });
    f.child.stderr.emit("data", Buffer.from("2026-09-19T10:00:00Z INF |  https://calm-river-42.trycloudflare.com  |\n"));
    f.child.stderr.emit("data", Buffer.from("again https://calm-river-42.trycloudflare.com\n"));
    t.stop();
    expect(urls).toEqual(["https://calm-river-42.trycloudflare.com", null]);
    expect(f.child.killed).toBe(true);
  });
});
