import { describe, expect, it } from "vitest";
import WebSocket from "ws";

describe.runIf(process.env.RUN_BOX === "1")("gateway VNC route on the real box", () => {
  it("returns the RFB banner for the primary Bot screen through 127.0.0.1:47800", async () => {
    const token = process.env.GATEWAY_TOKEN!;
    const botId = process.env.BOX_TEST_BOT_ID!;
    const ws = new WebSocket(`ws://127.0.0.1:47800/vnc/${botId}`, { headers: { authorization: `Bearer ${token}` } });
    const banner = await new Promise<string>((res, rej) => { ws.once("message", (d) => res(d.toString())); ws.once("error", rej); });
    expect(banner).toMatch(/^RFB 003\.00[38]\n$/);
    ws.close();
  }, 60_000);
});
