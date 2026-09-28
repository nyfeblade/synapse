import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);

export type RawXEvent = { kind: "press" | "release"; device: "button" | "key"; detail: number };

/** Reads `xinput test-xi2 --root` blocks: "EVENT type 15 (RawButtonPress)" … "    detail: 1". */
export class XinputParser {
  private pending: Omit<RawXEvent, "detail"> | null = null;

  push(line: string): RawXEvent | null {
    const head = /^EVENT type \d+ \(Raw(Button|Key)(Press|Release)\)/.exec(line.trim());
    if (head) {
      this.pending = { device: head[1] === "Button" ? "button" : "key", kind: head[2] === "Press" ? "press" : "release" };
      return null;
    }
    if (/^EVENT type/.test(line.trim())) {
      this.pending = null;
      return null;
    }
    const detail = /^detail:\s*(\d+)/.exec(line.trim());
    if (detail && this.pending) {
      const ev = { ...this.pending, detail: Number(detail[1]) };
      this.pending = null;
      return ev;
    }
    return null;
  }
}

export function parseXmodmap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^keycode\s+(\d+)\s*=\s*(\S+)/.exec(line);
    if (m) map.set(Number(m[1]), m[2]!);
  }
  return map;
}

export interface XInputLike {
  lines: AsyncIterable<string>;
  keysym(keycode: number): string | null;
  pointer(): Promise<{ x: number; y: number }>;
  activeWindow(): Promise<{ title: string; class: string }>;
  close(): void;
}

/** The real reader on the Bot's display (Debian box: xinput, x11-xserver-utils, xdotool, x11-utils are provisioned with the desktop stack, CMP-*). */
export async function spawnXInput(display: string, displayEnv: Record<string, string> = {}): Promise<XInputLike> {
  // Only what an X client needs: never the host's own environment.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...displayEnv, DISPLAY: display };
  const keys = parseXmodmap((await run("xmodmap", ["-pke"], { env })).stdout);
  const child = spawn("xinput", ["test-xi2", "--root"], { env, stdio: ["ignore", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: child.stdout! });
  return {
    lines: rl,
    keysym: (k) => keys.get(k) ?? null,
    pointer: async () => {
      const out = (await run("xdotool", ["getmouselocation", "--shell"], { env })).stdout;
      return { x: Number(/X=(\d+)/.exec(out)?.[1] ?? 0), y: Number(/Y=(\d+)/.exec(out)?.[1] ?? 0) };
    },
    activeWindow: async () => {
      try {
        const id = (await run("xdotool", ["getactivewindow"], { env })).stdout.trim();
        const title = (await run("xdotool", ["getwindowname", id], { env })).stdout.trim();
        const cls = /"([^"]*)"\s*$/.exec((await run("xprop", ["-id", id, "WM_CLASS"], { env })).stdout)?.[1] ?? "";
        return { title, class: cls.toLowerCase() };
      } catch {
        return { title: "", class: "" };
      }
    },
    close: () => {
      rl.close();
      child.kill("SIGTERM");
    },
  };
}
