import { deflateSync } from "node:zlib";

/** Bug 198: a minimal PNG writer (RGBA, 8-bit) for the phone app's icons and the QR self-check. */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A QR matrix as a PNG (black on white, `scale` px a module, 4-module quiet zone). */
export function qrPng(matrix: boolean[][], scale = 8): Buffer {
  const n = matrix.length + 8, w = n * scale;
  const px = new Uint8Array(w * w * 4).fill(255);
  matrix.forEach((row, y) => row.forEach((d, x) => {
    if (!d) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + 4) * scale + dy) * w + (x + 4) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return encodePng(w, w, px);
}

/**
 * The Home Screen icon: a white Synapse face (a superellipse with two upright black eyes) on black,
 * full bleed — iOS and Android cut their own corners. 4×4 supersampled for smooth edges.
 */
export function iconPng(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  const c = size / 2, a = size * 0.33, b = size * 0.3, n = 3.2;
  const eye = (x: number, y: number, cx: number) => {
    const w = size * 0.075, h = size * 0.16, r = w / 2, cy = c - size * 0.02;
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    if (dx > w / 2 || dy > h / 2) return false;
    const ey = dy - (h / 2 - r);
    return ey <= 0 || dx * dx + ey * ey <= r * r;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let white = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const X = x + (sx + 0.5) / ss, Y = y + (sy + 0.5) / ss;
      const inBody = Math.abs((X - c) / a) ** n + Math.abs((Y - c - size * 0.02) / b) ** n <= 1;
      if (inBody && !eye(X, Y, c - size * 0.11) && !eye(X, Y, c + size * 0.11)) white++;
    }
    const v = Math.round((white / (ss * ss)) * 255);
    const i = (y * size + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  return encodePng(size, size, px);
}
