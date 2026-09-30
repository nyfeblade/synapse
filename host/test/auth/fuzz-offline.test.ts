import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeysView, ModelCatalogView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";

/**
 * FUZZ / the fake brain (0.1.7): keys for every provider, their Test key and a Bot turn on a provider model all work
 * offline with made-up keys, and the host never dials anything but loopback — no request can reach a real provider.
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; vi.restoreAllMocks(); });
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };
const made = (p: string) => ["sk", p, "madeup", "x".repeat(24)].join("-");

describe("FUZZ never dials a real provider", () => {
  it("adds, tests and runs every provider offline; every socket the host opens is loopback", async () => {
    const dialed: string[] = [];
    const real = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const o = args[0];
      const host = typeof o === "object" && o !== null ? String((o as { host?: string }).host ?? "localhost") : typeof args[1] === "string" ? args[1] : "localhost";
      if (typeof o === "object" && o !== null && "path" in (o as object) && (o as { path?: string }).path) return (real as (...a: unknown[]) => net.Socket).apply(this, args); // unix sockets
      dialed.push(host);
      return (real as (...a: unknown[]) => net.Socket).apply(this, args);
    });
    app = await createHostApp(tmpConfig());
    const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
    const pk = ((await h.getKeys!({})) as KeysView).boxPublicKey;
    for (const p of ["openai", "openrouter", "gemini", "mistral", "deepseek", "ollama"]) await h.consentProvider!({ provider: p, textVersion: 1 });
    const keys: Record<string, string> = { openai: made("proj"), openrouter: made("or"), gemini: "AIza" + "y".repeat(35), mistral: "m".repeat(32), deepseek: made("ds"), anthropic: ["sk", "ant", "api03", "Q".repeat(28)].join("-") };
    for (const [p, k] of Object.entries(keys)) {
      const v = (await h.addKey!({ provider: p, sealed: await sealTo(pk, k), label: "Preview" })) as KeysView;
      const id = v.rings.find((r) => r.provider === p)!.keys[0]!.id;
      expect(await h.testKey!({ provider: p, keyId: id }), p).toMatchObject({ ok: true });
    }
    // Local providers show a made-up model list.
    const cat = (await h.getModelCatalog!({})) as ModelCatalogView;
    expect(cat.groups.find((g) => g.provider === "ollama")?.models.map((m) => m.ref)).toContain("ollama:qwen3:4b");
    // A Bot turn on OpenAI and one on Gemini answer offline.
    for (const model of ["openai:gpt-6.1-sol", "gemini:gemini-3.5-flash"]) {
      const { id } = (await h.createAgent!({ name: `Preview ${model.split(":")[0]}`, isKickstartRequested: false })) as { id: string };
      await h.updateAgent!({ id, model });
      await h.sendPrompt!({ id, text: "Hello?", clientNonce: `n-${model}` });
      const texts = () => app!.services.bots.tail(id, 100).flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
      await until(() => texts().some((t) => t.includes("stand-in reply")));
    }
    expect(dialed.length).toBeGreaterThan(0); // the spy sees the proxy's own loopback calls
    expect(dialed.filter((h) => !["127.0.0.1", "localhost", "::1"].includes(h))).toEqual([]);
  }, 60_000);
});
