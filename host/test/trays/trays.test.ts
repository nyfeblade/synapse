import { describe, expect, it } from "vitest";
import { SseHub } from "../../gateway/sse-hub";
import { TrayService } from "../../trays/trays";

describe("TrayService (NTF-03)", () => {
  it("dedupes with a count, caps at 20, clears per Bot, and publishes", () => {
    const hub = new SseHub();
    const seen: number[] = [];
    hub.subscribe((e) => { if (e.channel === "tray") seen.push(e.payload.trays.length); });
    const t = new TrayService(hub);
    const a = t.add({ botId: "b", title: "Bot failed to respond", dedupeKey: "b:x", retry: true });
    t.add({ botId: "b", title: "Bot failed to respond", dedupeKey: "b:x", retry: true });
    expect(t.list()).toHaveLength(1);
    expect(t.get(a.id)).toMatchObject({ count: 2, buttons: [{ label: "Retry", action: "retry" }] });
    for (let i = 0; i < 25; i++) t.add({ botId: `x${i}`, title: "The model service is busy" });
    expect(t.list()).toHaveLength(20);
    t.clearForBot("x24");
    expect(t.list().some((x) => x.botId === "x24")).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
  });
});
