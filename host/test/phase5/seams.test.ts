import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UserMessageEntry } from "@synapse/shared";
import { collectUserTurn } from "../../runner/prompt-collector";
import { notifySettled, type SettledTurn, type TurnObserver } from "../../runner/observers";
import { HostSettingsStore } from "../../store/host-settings";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { loadConfig } from "../../config";
import { createGateway } from "../../gateway/server";
import { SseHub } from "../../gateway/sse-hub";
import { NORMAL_LADDER } from "../../phase5/types";
import { slugify, withSourceMetadata } from "../../util/text";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "p5-seams-"));

describe("HostSettingsStore extras", () => {
  it("persists unknown keys without touching Phase 1 fields", () => {
    const file = path.join(tmp(), "settings.json");
    const s = new HostSettingsStore(file);
    expect(s.extra("memoryMode", "standard")).toBe("standard");
    s.setExtra("memoryMode", "dreaming");
    const again = new HostSettingsStore(file);
    expect(again.extra("memoryMode", "standard")).toBe("dreaming");
    expect(again.get().autoReviewEnabled).toBe(true);
    again.update({ autoReviewEnabled: false });
    expect(new HostSettingsStore(file).extra("memoryMode", "standard")).toBe("dreaming");
  });
});

describe("collectUserTurn voice and hints (CHAT-08, PLG-06)", () => {
  it("tags voice messages and renders hints as reminders", () => {
    const entry: UserMessageEntry = {
      kind: "message", id: "t1u", role: "user", content: "check my calendar", createdAt: 1,
      voice: { durationMs: 91_000 }, hints: ["The user wants you to use Linear for this"],
    };
    const out = collectUserTurn({ messages: [{ entry, before: [], after: [] }], profileUpdate: null, blocks: [] }) as { text: string }[];
    expect(out[0]!.text).toBe("[t1u] [voice] check my calendar");
    expect(out[1]!.text).toBe("<system_reminder>The user wants you to use Linear for this</system_reminder>");
  });
});

describe("observers", () => {
  it("isolates observer failures", () => {
    const seen: string[] = [];
    const obs: TurnObserver[] = [{ onSettled: () => { throw new Error("boom"); } }, { onSettled: (t) => seen.push(t.requestId) }];
    notifySettled(obs, { requestId: "req_1" } as SettledTurn);
    expect(seen).toEqual(["req_1"]);
  });
});

describe("spawn options", () => {
  it("adds extra disallowed tools", () => {
    const cfg = loadConfig({ BOX_HOME: tmp() } as NodeJS.ProcessEnv);
    const o = buildBotQueryOptions({
      cfg, flags: DEFAULT_FLAGS, resumeSessionId: null, newSessionId: null, systemAppend: "", model: "claude-sonnet-5", env: {},
      mcpServers: {}, botToolNames: [], hooks: {}, canUseTool: async () => ({ behavior: "allow", updatedInput: {} }), abortController: new AbortController(),
      extraDisallowed: ["mcp__claude_ai_Gmail__send_email"],
    });
    expect(o.disallowedTools).toContain("mcp__claude_ai_Gmail__send_email");
    expect(o.disallowedTools).toContain("SendMessage");
  });
});

describe("gateway body limits", () => {
  it("allows a larger body for commands that declare one", async () => {
    const hub = new SseHub();
    const server = createGateway({
      token: "t", hub, health: () => ({ ok: true }),
      handlers: { previewTemplateImport: (a) => ({ token: String((a.bytesBase64 ?? "").length), name: "", description: "", facts: [], playbooks: [], jobs: [], apps: [], thirdParty: false }) },
      bodyLimits: { previewTemplateImport: 4 * 1024 * 1024 },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const big = "A".repeat(2 * 1024 * 1024);
    const res = await fetch(`http://127.0.0.1:${port}/api/previewTemplateImport`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ bytesBase64: big }) });
    expect(res.status).toBe(200);
    server.close();
  });
});

describe("text utils", () => {
  it("slugs names and adds skill source metadata", () => {
    expect(slugify("Google Calendar")).toBe("google-calendar");
    expect(slugify("bot")).toBe("bot-server");
    expect(withSourceMetadata("---\nname: a\n---\nbody", "plugin:x")).toBe("---\nname: a\nmetadata:\n  source: plugin:x\n---\nbody");
  });

  it("replaces an existing metadata.source instead of duplicating the key (reinstall/update)", () => {
    const md = "---\nname: a\nmetadata:\n  source: old-source\n---\nbody";
    expect(withSourceMetadata(md, "new-source")).toBe(
      "---\nname: a\nmetadata:\n  source: new-source\n---\nbody",
    );
  });
});

describe("ladder default", () => {
  it("NORMAL_LADDER allows everything", () => {
    expect(NORMAL_LADDER.level()).toBe("L0");
    expect(NORMAL_LADDER.allowsBackground("dreaming")).toBe(true);
  });
});
