/**
 * Bug 198: a QR code for the Phone access URL, made on this Mac (no network, no library). Byte mode,
 * error correction level M, versions 1-10 (up to 213 bytes — a tailnet URL is ~45). The construction
 * follows ISO/IEC 18004 as laid out in Project Nayuki's reference generator: function patterns, the
 * data + Reed-Solomon codewords in their zigzag, then the mask with the lowest penalty.
 */

/** Level M, versions 1..10: error-correction codewords per block, and the number of blocks. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0;

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver - 1]! * BLOCKS[ver - 1]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((c, i) => { r[i]! ^= gfMul(c, f); });
  }
  return r;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, d: boolean): void { this.dark[y]![x] = d; this.fixed[y]![x] = true; }

  functionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = alignmentPositions(this.ver);
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.format(0);
    if (this.ver >= 7) {
      let rem = this.ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const b = ((bits >>> i) & 1) !== 0;
        const a = s - 11 + (i % 3), c = Math.floor(i / 3);
        this.set(a, c, b);
        this.set(c, a, b);
      }
    }
  }

  format(mask: number): void {
    const data = (FORMAT_BITS_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }

  codewords(data: number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.fixed[y]![x] && i < data.length * 8) {
            this.dark[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  mask(m: number): void {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (this.fixed[y]![x]) continue;
      let inv: boolean;
      switch (m) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (inv) this.dark[y]![x] = !this.dark[y]![x];
    }
  }

  /** The standard's four penalty rules (runs, 2×2 blocks, finder look-alikes, dark balance). */
  penalty(): number {
    const s = this.size, g = this.dark;
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
      const pat = [true, false, true, true, true, false, true];
      for (let i = 0; i + 7 <= s; i++) {
        if (!pat.every((v, k) => get(i + k) === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
        const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= s || !get(i + 7 + k));
        if (lightBefore || lightAfter) p += 40;
      }
    };
    for (let y = 0; y < s; y++) line((i) => g[y]![i]!);
    for (let x = 0; x < s; x++) line((i) => g[i]![x]!);
    for (let y = 0; y + 1 < s; y++) for (let x = 0; x + 1 < s; x++) {
      const c = g[y]![x];
      if (c === g[y]![x + 1] && c === g[y + 1]![x] && c === g[y + 1]![x + 1]) p += 3;
    }
    let dark = 0;
    for (const row of g) for (const d of row) if (d) dark++;
    const total = s * s;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return p;
  }
}

/** The QR matrix for `text` (true = dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, "utf8")];
  let ver = 1;
  for (; ver <= 10; ver++) {
    const bits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(ver) * 8) break;
  }
  if (ver > 10) throw new Error("That text is too long for a QR code here.");
  const cap = dataCodewords(ver);
  const bits: number[] = [];
  const push = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add each block's error correction, interleave.
  const nBlocks = BLOCKS[ver - 1]!, ecLen = ECC_PER_BLOCK[ver - 1]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(ecLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= nShort) out.push(b[i]!); });

  let best: Grid | null = null, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = new Grid(ver);
    g.functionPatterns();
    g.codewords(out);
    g.mask(m);
    g.format(m);
    const p = g.penalty();
    if (p < bestP) { bestP = p; best = g; }
  }
  return best!.dark;
}

/** One SVG path of the dark modules, with a 4-module quiet zone: viewBox `0 0 n n`. */
export function qrSvg(text: string): { size: number; path: string } {
  const m = qrMatrix(text);
  const q = 4, n = m.length + q * 2;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return { size: n, path: d };
}
