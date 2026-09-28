import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import type { GatewayError } from "../../gateway/errors";
import { BotStore } from "../../store/bot-store";
import { HostSettingsStore } from "../../store/host-settings";
import { agentsDir, botDir, initLayout } from "../../store/layout";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bots-store-"));

describe("layout", () => {
  it("creates agent-data and the 0700 host-private dir with default files", () => {
    const d = tmp();
    const cfg = loadConfig({ DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host") });
    initLayout(cfg);
    expect(fs.existsSync(agentsDir(cfg))).toBe(true);
    expect(fs.statSync(cfg.hostPrivate).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(cfg.dataRoot, "agents", "active-agent.json"), "utf8"))).toEqual({ activeAgentId: null });
    expect(JSON.parse(fs.readFileSync(path.join(cfg.dataRoot, "settings.json"), "utf8")).autoReviewEnabled).toBe(true);
  });

  it("rejects unsafe bot ids and accepts a valid uuid v4", () => {
    const d = tmp();
    const cfg = loadConfig({ DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host") });
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
        return "";
      } catch (e) {
        return (e as GatewayError).code;
      }
    };
    expect(codeOf(() => botDir(cfg, "../etc"))).toBe("INVALID_BOT_ID");
    expect(codeOf(() => botDir(cfg, ".."))).toBe("INVALID_BOT_ID");
    expect(codeOf(() => botDir(cfg, ""))).toBe("INVALID_BOT_ID");
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(botDir(cfg, id)).toBe(path.join(agentsDir(cfg), id));
  });
});

describe("BotStore", () => {
  it("keeps kv and an ordered transcript in WAL mode", () => {
    const file = path.join(tmp(), "store.db");
    const s = new BotStore(file);
    s.setKv("brain", { sessionId: "abc" });
    expect(s.getKv("brain", null)).toEqual({ sessionId: "abc" });
    expect(s.getKv("missing", 7)).toBe(7);
    s.append({ kind: "message", id: "t1u", role: "user", content: "hi", createdAt: 1 });
    s.append({ kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 2, message: { type: "text", content: "hello" } });
    s.update({ kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 2, message: { type: "text", content: "hello!" } });
    expect(s.tail(10).map((e) => e.id)).toEqual(["t1u", "t1s1"]);
    expect((s.get("t1s1") as any).message.content).toBe("hello!");
    expect(s.tail(1).map((e) => e.id)).toEqual(["t1s1"]);
    s.deleteKv("brain");
    expect(s.getKv("brain", null)).toBeNull();
    s.close();
    expect(fs.existsSync(`${file}-wal`) || fs.existsSync(file)).toBe(true);
  });
});

describe("HostSettingsStore (SET-05, SET-06, APR-08, APR-12)", () => {
  it("validates rules, dedupes, keeps the newest 20 on Always allow, and versions the rules", () => {
    const file = path.join(tmp(), "settings.json");
    const views: unknown[] = [];
    const st = new HostSettingsStore(file, (v) => views.push(v));
    const v0 = st.rulesVersion();
    st.update({ allowInstructions: ["  Use the Shell tool to run npm test  ", "Use the Shell tool to run npm test"] });
    expect(st.view().allowInstructions).toEqual(["Use the Shell tool to run npm test"]);
    expect(st.rulesVersion()).not.toBe(v0);
    expect(() => st.update({ blockInstructions: ["x".repeat(1001)] })).toThrow(/1,000/);
    expect(() => st.update({ blockInstructions: Array.from({ length: 21 }, (_, i) => `rule ${i}`) })).toThrow(/20/);
    for (let i = 0; i < 25; i++) st.addAllowRule(`Use the Shell tool to run job ${i}`);
    const allow = st.view().allowInstructions;
    expect(allow).toHaveLength(20);
    expect(allow[19]).toBe("Use the Shell tool to run job 24");
    expect(st.addAllowRule("Use the Shell tool to run job 24").added).toBe(false);
    expect(views.length).toBeGreaterThan(0);
  });

  it("pins and unpins Bots in order and drops deleted Bots", () => {
    const st = new HostSettingsStore(path.join(tmp(), "settings.json"));
    st.setPinned("a", true);
    st.setPinned("b", true);
    st.setPinned("a", true);
    expect(st.view().pinnedAgentIds).toEqual(["a", "b"]);
    st.setPinned("a", false);
    st.removeBot("b");
    expect(st.view().pinnedAgentIds).toEqual([]);
  });
});
