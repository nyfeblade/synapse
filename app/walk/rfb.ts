import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import WebSocket from "ws";

/**
 * A minimal RFB 3.8 client, enough to read frames and send input over the gateway's /vnc/<botId>.
 * Security None only; encodings Raw and RRE; 32bpp little-endian true colour (r<<16|g<<8|b).
 *
 * NOTE: dialing /vnc/<botId> makes the host ensure() a screen for that Bot (vnc-bridge.ts). Only
 * dial after the display is supposed to exist, or the dial itself becomes the thing under test.
 */
export interface Transport { write(b: Buffer): void; onData(cb: (b: Buffer) => void): void; onClose(cb: (why: string) => void): void; close(): void }

export function wsTransport(baseUrl: string, auth: string, botId: string): Promise<Transport> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/vnc/${encodeURIComponent(botId)}`, { headers: { authorization: auth }, perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`/vnc upgrade refused: HTTP ${res.statusCode}`)));
    ws.once("open", () => resolve({
      write: (b) => ws.send(b, { binary: true }),
      onData: (cb) => ws.on("message", (d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer))),
      onClose: (cb) => { ws.on("close", (c) => cb(`ws close ${c}`)); ws.on("error", (e) => cb(`ws error ${e.message}`)); },
      close: () => ws.close(),
    }));
  });
}

export function duplexTransport(d: Duplex): Transport {
  return { write: (b) => d.write(b), onData: (cb) => d.on("data", cb), onClose: (cb) => d.on("close", () => cb("closed")), close: () => d.destroy() };
}

export interface FrameStats { width: number; height: number; distinctColors: number; dominantFraction: number; hash: string }

/** Pure: stats over RGBA/BGRX bytes (4 per pixel, 4th byte ignored). Exported so the instrument can be tested. */
export function frameStats(px: Uint8Array | Uint8ClampedArray, width: number, height: number): FrameStats {
  const counts = new Map<number, number>();
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const c = (px[o]! << 16) | (px[o + 1]! << 8) | px[o + 2]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let top = 0;
  for (const v of counts.values()) if (v > top) top = v;
  const h = createHash("sha256");
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = px[i * 4]!; rgb[i * 3 + 1] = px[i * 4 + 1]!; rgb[i * 3 + 2] = px[i * 4 + 2]!; }
  h.update(rgb);
  return { width, height, distinctColors: counts.size, dominantFraction: n ? top / n : 1, hash: h.digest("hex").slice(0, 16) };
}

/** "Non-uniform" = more than one colour AND at least 1% of pixels differ from the dominant one. */
export const isNonUniform = (s: FrameStats): boolean => s.distinctColors > 1 && s.dominantFraction < 0.99;

export class RfbClient {
  width = 0;
  height = 0;
  name = "";
  fb = new Uint8Array(0);
  private buf = Buffer.alloc(0);
  private want: { n: number; resolve(b: Buffer): void; reject(e: Error): void } | null = null;
  private closedWhy: string | null = null;
  private inflight: Promise<void> | null = null;

  private constructor(private t: Transport) {
    t.onData((b) => { this.buf = Buffer.concat([this.buf, b]); this.pump(); });
    t.onClose((why) => { this.closedWhy ??= why; this.want?.reject(new Error(`RFB transport ${why}`)); this.want = null; });
  }

  private pump(): void {
    if (this.want && this.buf.length >= this.want.n) {
      const w = this.want; this.want = null;
      const out = this.buf.subarray(0, w.n); this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }

  private read(n: number): Promise<Buffer> {
    if (this.closedWhy && this.buf.length < n) return Promise.reject(new Error(`RFB transport ${this.closedWhy}`));
    return new Promise((resolve, reject) => { this.want = { n, resolve, reject }; this.pump(); });
  }

  static async connect(t: Transport): Promise<RfbClient> {
    const c = new RfbClient(t);
    const ver = (await c.read(12)).toString("latin1");
    if (!/^RFB 003\.00[378]\n$/.test(ver)) throw new Error(`RFB: unexpected version ${JSON.stringify(ver)}`);
    t.write(Buffer.from("RFB 003.008\n"));
    const nTypes = (await c.read(1))[0]!;
    if (nTypes === 0) { const len = (await c.read(4)).readUInt32BE(0); throw new Error(`RFB refused: ${(await c.read(len)).toString()}`); }
    const types = [...(await c.read(nTypes))];
    if (!types.includes(1)) throw new Error(`RFB: no security type None offered (${types.join(",")})`);
    t.write(Buffer.from([1]));
    const res = (await c.read(4)).readUInt32BE(0);
    if (res !== 0) { const len = (await c.read(4)).readUInt32BE(0); throw new Error(`RFB security failed: ${(await c.read(len)).toString()}`); }
    t.write(Buffer.from([1])); // ClientInit shared=1: never kick the renderer's own viewer off
    const init = await c.read(24);
    c.width = init.readUInt16BE(0); c.height = init.readUInt16BE(2);
    c.name = (await c.read(init.readUInt32BE(20))).toString();
    c.fb = new Uint8Array(c.width * c.height * 4);
    const pf = Buffer.alloc(20);
    pf[0] = 0; pf[4] = 32; pf[5] = 24; pf[6] = 0; pf[7] = 1;
    pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12);
    pf[14] = 16; pf[15] = 8; pf[16] = 0;
    t.write(pf);
    const enc = Buffer.alloc(4 + 8); enc[0] = 2; enc.writeUInt16BE(2, 2); enc.writeInt32BE(0, 4); enc.writeInt32BE(2, 8);
    t.write(enc);
    return c;
  }

  private request(incremental: boolean): void {
    const b = Buffer.alloc(10); b[0] = 3; b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(this.width, 6); b.writeUInt16BE(this.height, 8);
    this.t.write(b);
  }

  private put(x: number, y: number, w: number, h: number, pixel: Buffer): void {
    // pixel is little-endian 32bpp: bytes b,g,r,x. Stored as r,g,b,0.
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const o = (yy * this.width + xx) * 4;
      this.fb[o] = pixel[2]!; this.fb[o + 1] = pixel[1]!; this.fb[o + 2] = pixel[0]!; this.fb[o + 3] = 0;
    }
  }

  /** Reads server messages until one FramebufferUpdate has been applied. */
  private async readUpdate(): Promise<void> {
    for (;;) {
      const type = (await this.read(1))[0]!;
      if (type === 0) {
        const n = (await this.read(3)).readUInt16BE(1);
        for (let r = 0; r < n; r++) {
          const h = await this.read(12);
          const x = h.readUInt16BE(0), y = h.readUInt16BE(2), w = h.readUInt16BE(4), hh = h.readUInt16BE(6), e = h.readInt32BE(8);
          if (e === 0) {
            const raw = await this.read(w * hh * 4);
            for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) {
              const s = (yy * w + xx) * 4, o = ((y + yy) * this.width + x + xx) * 4;
              this.fb[o] = raw[s + 2]!; this.fb[o + 1] = raw[s + 1]!; this.fb[o + 2] = raw[s]!; this.fb[o + 3] = 0;
            }
          } else if (e === 2) {
            const sub = (await this.read(4)).readUInt32BE(0);
            this.put(x, y, w, hh, await this.read(4));
            for (let i = 0; i < sub; i++) { const s = await this.read(12); this.put(x + s.readUInt16BE(4), y + s.readUInt16BE(6), s.readUInt16BE(8), s.readUInt16BE(10), s.subarray(0, 4)); }
          } else throw new Error(`RFB: unrequested encoding ${e}`);
        }
        return;
      } else if (type === 1) { const h = await this.read(5); await this.read(h.readUInt16BE(3) * 6); }
      else if (type === 2) { /* bell */ }
      else if (type === 3) { const h = await this.read(7); await this.read(h.readUInt32BE(3)); }
      else throw new Error(`RFB: unknown server message ${type}`);
    }
  }

  /** A full (non-incremental) frame. */
  async frame(): Promise<FrameStats> {
    if (this.inflight) await this.inflight;
    this.request(false);
    await this.readUpdate();
    return frameStats(this.fb, this.width, this.height);
  }

  /** Incremental updates until the hash differs from `baseline`, or the deadline passes (resolves null). */
  async waitForChange(baseline: string, timeoutMs: number): Promise<FrameStats | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      // One update in flight at a time: a read left pending by a previous timeout is reused, never orphaned.
      if (!this.inflight) { this.request(true); this.inflight = this.readUpdate().finally(() => { this.inflight = null; }); }
      let t: NodeJS.Timeout | undefined;
      const got = await Promise.race([this.inflight.then(() => true), new Promise<false>((r) => { t = setTimeout(() => r(false), Math.max(0, until - Date.now())); })]);
      clearTimeout(t);
      if (!got) break;
      const s = frameStats(this.fb, this.width, this.height);
      if (s.hash !== baseline) return s;
    }
    return null;
  }

  pointer(x: number, y: number, mask: number): void {
    const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); this.t.write(b);
  }
  key(keysym: number, down: boolean): void {
    const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4); this.t.write(b);
  }
  close(): void { this.t.close(); }
}
