import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { mirrorPath, mirrorRecord, startTranscriptMirror } from "../../context/transcript-mirror";
import { SseHub } from "../../gateway/sse-hub";
import { tmpConfig } from "../helpers";

describe("transcript mirror (CTX-04)", () => {
  it("appends Claude-style records for visible entries and finished tool calls, and deletes with the Bot", () => {
    const cfg = tmpConfig();
    const hub = new SseHub();
    const stop = startTranscriptMirror({ hub, dataRoot: cfg.dataRoot });
    const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: { kind: "message", id: "t1u", role: "user", content: "hi", createdAt: 1 } } });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: { kind: "tool-call", id: "t1a1", requestId: "r", segmentId: "s", hidden: false, name: "Bash", step: "Ran ls", icon: "terminal", metric: null, status: "running", startedAt: 2 } } });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "update", entry: { kind: "tool-call", id: "t1a1", requestId: "r", segmentId: "s", hidden: false, name: "Bash", step: "Ran ls", icon: "terminal", metric: null, status: "done", startedAt: 2, endedAt: 3 } } });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 4, message: { type: "text", content: "hello" } } } });
    const lines = fs.readFileSync(mirrorPath(cfg.dataRoot, B), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.type, l.uuid])).toEqual([["user", "t1u"], ["assistant", "t1a1"], ["assistant", "t1s1"]]);
    expect(lines[2].message.content[0]).toEqual({ type: "text", text: "hello" });
    hub.publish({ channel: "agents", payload: { removedId: B, activeAgentId: null } });
    expect(fs.existsSync(mirrorPath(cfg.dataRoot, B))).toBe(false);
    stop();
  });
  it("skips running tool calls and typing events", () => {
    expect(mirrorRecord({ kind: "tool-call", id: "t1a1", requestId: "r", segmentId: "s", hidden: false, name: "Bash", step: "x", icon: "terminal", metric: null, status: "running", startedAt: 1 })).toBeNull();
  });
});
