import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConnectorHealthView, SseEvent, TranscriptEntry, Tray } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { demoScriptFor } from "../../brain/demo-script";
import { FakeBrain } from "../../brain/fake-brain";
import { messageText } from "../../brain/types";
import { tmpConfig } from "../helpers";

let app: HostApp | null = null;
let root: string | null = null;
afterEach(async () => { await app?.close(); app = null; if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });
const fuzz0 = process.env.FUZZ;
beforeAll(() => { process.env.FUZZ = "1"; });
afterAll(() => { if (fuzz0 === undefined) delete process.env.FUZZ; else process.env.FUZZ = fuzz0; });
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

/**
 * 4.4 end to end on a real host (fake brain, fake Google): a Google sign-in expires mid-task; the host lists it,
 * raises one tray with Fix and one notification, and the Bot's NEXT turn is told, once. Reconnecting clears it all
 * and the Bot hears it works again. The owner's finished task publishes one work-finished event.
 */
describe("connector health through the host", () => {
  it("a break: one tray, one alert, the Bot told in its next turn; recovery: all clear, the Bot told it's back", async () => {
    const cfg = tmpConfig();
    root = path.dirname(cfg.workspace);
    const brains = new Map<string, FakeBrain>();
    app = await createHostApp(cfg, {
      brainFactory: (botId, d) => {
        const b = new FakeBrain(botId, d.wiring, demoScriptFor(cfg.workspace), {
          sessionId: d.getSessionId(),
          toolRunner: async (name, input) => (await app!.services.phase5.runFakeTool(botId, name, input)) ?? `(fake) ${name} ok`,
        });
        brains.set(botId, b);
        return b;
      },
    });
    const { port } = await app.listen();
    const events: SseEvent[] = [];
    app.hub.subscribe((e) => events.push(e));
    const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result as T;
    };
    const connect = async () => {
      await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret" });
      const { authorizationUrl } = await api<{ authorizationUrl: string }>("startGoogleAuth");
      await api("completeMcpOAuth", { state: new URL(authorizationUrl).searchParams.get("state")!, code: "fuzz" });
    };
    const texts = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries.flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
    const health = async () => (await api<{ connectors: ConnectorHealthView[] }>("getConnectorHealth")).connectors;
    const lastPrompt = (id: string) => brains.get(id)!.inputs.at(-1)!.prompt.map(messageText).join("\n");
    const google = app.services.phase5.google;

    const { id } = await api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false });
    await connect();
    await api("setAgentGoogle", { id, enabled: true });
    expect((await health()).find((c) => c.id.startsWith("google:"))).toMatchObject({ state: "ok", name: "Google" });

    // The sign-in expires; the Bot's Google call finds out.
    google.fake!.state.refreshInvalid = true;
    google.fake!.state.accessTokens.clear();
    await api("sendPrompt", { id, text: "gmail: deck", clientNonce: "n1" });
    await until(async () => (await texts(id)).some((t) => t.includes("sign-in expired")));
    expect((await health()).find((c) => c.id.startsWith("google:"))).toMatchObject({ state: "needs-sign-in", fix: { kind: "google" } });
    const trays = (await api<{ trays: Tray[] }>("getTrays")).trays.filter((t) => t.dedupeKey?.startsWith("health:google:"));
    expect(trays).toHaveLength(1);
    expect(trays[0]!.title).toBe("Google needs you to sign in again");
    await until(() => events.some((e) => e.channel === "connector-alert"), 4000);
    expect(events.filter((e) => e.channel === "connector-alert")).toHaveLength(1);

    // The next turn is told, once.
    await api("sendPrompt", { id, text: "hello again", clientNonce: "n2" });
    await until(() => brains.get(id)!.inputs.length >= 2 && lastPrompt(id).includes("hello again"));
    expect(lastPrompt(id)).toContain("Google needs the user to sign in again.");
    await until(async () => !(await api<{ agent: { running: boolean } }>("openAgent", { id })).agent.running);
    await api("sendPrompt", { id, text: "third", clientNonce: "n3" });
    await until(() => lastPrompt(id).includes("third"));
    expect(lastPrompt(id)).not.toContain("connector-status");

    // The owner signs in again: the tray goes, and the Bot hears it's back.
    google.fake!.state.refreshInvalid = false;
    await connect();
    expect((await health()).find((c) => c.id.startsWith("google:"))!.state).toBe("ok");
    expect((await api<{ trays: Tray[] }>("getTrays")).trays.filter((t) => t.dedupeKey?.startsWith("health:google:"))).toHaveLength(0);
    await until(async () => !(await api<{ agent: { running: boolean } }>("openAgent", { id })).agent.running);
    const before = brains.get(id)!.inputs.length;
    await api("sendPrompt", { id, text: "fourth", clientNonce: "n4" });
    await until(() => brains.get(id)!.inputs.length > before && brains.get(id)!.inputs.some((i) => i.prompt.map(messageText).join("\n").includes("Google is working again.")));
    expect(events.filter((e) => e.channel === "connector-alert")).toHaveLength(1);

    // The owner's task finished: one work-finished event (Settings → Work finished is On by default).
    await until(() => events.some((e) => e.channel === "work-finished"), 8000);
    const wf = events.filter((e): e is Extract<SseEvent, { channel: "work-finished" }> => e.channel === "work-finished");
    expect(wf[0]!.payload).toMatchObject({ botId: id, name: "Scout", telegram: false });
    expect(wf[0]!.payload.summary.length).toBeGreaterThan(0);
  }, 30_000);
});
