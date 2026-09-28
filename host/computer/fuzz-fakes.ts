import { createHash } from "node:crypto";
import fs from "node:fs";
import type { SnapshotInfo } from "@synapse/shared";
import path from "node:path";
import { Duplex } from "node:stream";
import type { DisplayControl } from "./display-control";
import type { SnapshotControl } from "./snapshots";
import type { Exec } from "./x-exec";

/** A valid 1×1 WebP so FUZZ screenshots and cards look real without X. */
export const TINY_WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

export class FakeDisplayControl implements DisplayControl {
  private on = new Set<number>();
  async start(i: number) { this.on.add(i); return "ok" as const; }
  async stop(i: number) { this.on.delete(i); }
  async status(i: number) { return this.on.has(i) ? ("running" as const) : ("stopped" as const); }
  async restartChrome() {}
}

/** xdotool succeeds, getmouselocation reports the centre, ffmpeg returns TINY_WEBP. */
export const fakeXExec: Exec = async (file, args) => {
  if (file === "xdotool" && args[0] === "getmouselocation") return { code: 0, stdout: Buffer.from("X=640\nY=400\nSCREEN=0\nWINDOW=1\n"), stderr: "" };
  if (file === "ffmpeg" || file === "sh") return { code: 0, stdout: TINY_WEBP, stderr: "" };
  return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
};

export class FakeSnapshotControl implements SnapshotControl {
  constructor(private dir: string) {}
  async create(id: string, _parts: SnapshotInfo["parts"]) {
    const buf = Buffer.from(`fuzz snapshot ${id}`);
    fs.writeFileSync(path.join(this.dir, `${id}.tar.zst`), buf, { mode: 0o600 });
    return createHash("sha256").update(buf).digest("hex");
  }
  async restore() {}
  async remove(id: string) { fs.rmSync(path.join(this.dir, `${id}.tar.zst`), { force: true }); }
}

/**
 * Task 30 fuzz: FUZZ mode has no x11vnc. This is a tiny RFB 3.8 server (security None, 1280×800, one RRE solid
 * rectangle per full update request) that the /vnc route dials instead, so noVNC connects like on the real box.
 */
export function fakeVncSocket(o: { width?: number; height?: number; name?: string } = {}): Duplex {
  const w = o.width ?? 1280;
  const h = o.height ?? 800;
  const name = Buffer.from(o.name ?? "Bots' Computer (FUZZ)");
  let stage: "version" | "security" | "init" | "normal" = "version";
  let buf = Buffer.alloc(0);
  const sock = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === "version") {
          if (buf.length < 12) break;
          buf = buf.subarray(12);
          stage = "security";
          sock.push(Buffer.from([1, 1]));
        } else if (stage === "security") {
          if (buf.length < 1) break;
          buf = buf.subarray(1);
          stage = "init";
          sock.push(Buffer.from([0, 0, 0, 0]));
        } else if (stage === "init") {
          if (buf.length < 1) break;
          buf = buf.subarray(1);
          stage = "normal";
          const init = Buffer.alloc(24);
          init.writeUInt16BE(w, 0); init.writeUInt16BE(h, 2);
          init[4] = 32; init[5] = 24; init[6] = 0; init[7] = 1; // bpp, depth, big-endian, true-colour
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
          init[14] = 16; init[15] = 8; init[16] = 0;
          init.writeUInt32BE(name.length, 20);
          sock.push(Buffer.concat([init, name]));
        } else {
          const t = buf[0];
          if (t === undefined) break;
          const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6
            : t === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : t === 150 ? 10 : t === 250 ? 4 : t === 251 ? (buf.length >= 8 ? 8 + 16 * buf[6]! : Infinity) : -1;
          if (need === -1) { buf = Buffer.alloc(0); break; } // a message this fake doesn't model: drop it
          if (buf.length < need) break;
          const msg = buf.subarray(0, need);
          buf = buf.subarray(need);
          if (t === 3 && msg[1] === 0) {
            const upd = Buffer.alloc(24);
            upd[0] = 0; upd.writeUInt16BE(1, 2);
            upd.writeUInt16BE(0, 4); upd.writeUInt16BE(0, 6); upd.writeUInt16BE(w, 8); upd.writeUInt16BE(h, 10);
            upd.writeInt32BE(2, 12); // RRE
            upd.writeUInt32BE(0, 16); // no subrectangles
            upd.writeUInt32BE(0x2b3a4a, 20); // background pixel
            sock.push(upd);
          }
        }
      }
      done();
    },
  });
  setImmediate(() => { sock.emit("connect"); sock.push(Buffer.from("RFB 003.008\n")); }); // like a net.Socket
  return sock;
}
