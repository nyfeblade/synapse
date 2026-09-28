import { describe, expect, it } from "vitest";
import { fakeVncSocket } from "../../computer/fuzz-fakes";

/**
 * Task 30 fuzz (high): in FUZZ mode there is no x11vnc, so the preview's noVNC connection closed at once and noVNC
 * logged "Failed when connecting: Connection closed (code: 1005)". The FUZZ host answers /vnc with a tiny RFB 3.8
 * server (no auth, one solid 1280×800 frame) so the preview and takeover view connect like the real thing.
 */
describe("fakeVncSocket (FUZZ-mode RFB server)", () => {
  it("does the RFB 3.8 handshake and answers the first update request with one solid rectangle", async () => {
    const s = fakeVncSocket();
    const got: Buffer[] = [];
    s.on("data", (d: Buffer) => got.push(d));
    const next = async () => { await new Promise((r) => setTimeout(r, 5)); return Buffer.concat(got.splice(0)); };
    expect((await next()).toString()).toBe("RFB 003.008\n");
    s.write(Buffer.from("RFB 003.008\n"));
    expect([...(await next())]).toEqual([1, 1]); // one security type: None
    s.write(Buffer.from([1]));
    expect([...(await next())]).toEqual([0, 0, 0, 0]); // SecurityResult OK
    s.write(Buffer.from([1])); // ClientInit (shared)
    const init = await next();
    expect(init.readUInt16BE(0)).toBe(1280);
    expect(init.readUInt16BE(2)).toBe(800);
    expect(init[4]).toBe(32); // bits per pixel
    const nameLen = init.readUInt32BE(20);
    expect(init.subarray(24, 24 + nameLen).toString()).toMatch(/Bots/);
    // SetEncodings (2 encodings) + a non-incremental FramebufferUpdateRequest, in one write.
    const enc = Buffer.alloc(4 + 8); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(0, 4); enc.writeInt32BE(2, 8);
    const req = Buffer.alloc(10); req[0] = 3; req[1] = 0; req.writeUInt16BE(1280, 6); req.writeUInt16BE(800, 8);
    s.write(Buffer.concat([enc, req]));
    const upd = await next();
    expect(upd[0]).toBe(0); // FramebufferUpdate
    expect(upd.readUInt16BE(2)).toBe(1); // one rectangle
    expect(upd.readUInt16BE(8)).toBe(1280);
    expect(upd.readUInt16BE(10)).toBe(800);
    expect(upd.readInt32BE(12)).toBe(2); // RRE
    expect(upd.readUInt32BE(16)).toBe(0); // no subrectangles: a solid fill
    s.destroy();
  });
});
