import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Wake word ("Hey <Bot name>"): the helper's `--mode wake` runs the same buffer path as dictation, but
 * nothing it hears leaves the process except a detection — no partial, final or speech-start events,
 * and no transcript in its log. Audio files stand in for the microphone (`--file`), as in the other
 * native tests. RUN_NATIVE=1 opts in; needs Speech Recognition access and the built helper.
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
type Ev = { type: string; name?: string; confidence?: number; ok?: boolean; failures?: string[]; code?: string; text?: string };

let dir = "";
function sayFile(name: string, text: string): string {
  const f = path.join(dir, `${name}.aiff`);
  execFileSync("say", ["-o", f, text]);
  return f;
}

function run(args: string[], o: { stdin?: (write: (l: string) => void, events: Ev[]) => void } = {}): Promise<{ events: Ev[]; code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const events: Ev[] = [];
    let buf = "";
    let stderr = "";
    const kill = setTimeout(() => { c.kill("SIGKILL"); reject(new Error(`helper timed out; events=${JSON.stringify(events)}\n${stderr}`)); }, 60_000);
    c.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { events.push(JSON.parse(line) as Ev); } catch { /* not an event */ }
        o.stdin?.((l) => c.stdin.write(`${l}\n`), events);
      }
    });
    c.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    // A file source plays to the end, then the helper stops once stdin is closed.
    if (!o.stdin) c.stdin.end();
    c.on("close", (code) => { clearTimeout(kill); resolve({ events, code, stderr }); });
  });
}
const types = (e: Ev[]) => e.map((x) => x.type);

describe("wake-word matcher self-test (no Speech access needed)", () => {
  it.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("--self-test-wake passes", () => {
    const out = execFileSync(bin, ["--self-test-wake"]).toString().trim().split("\n").at(-1)!;
    const r = JSON.parse(out) as Ev;
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("wake mode (Hey <Bot name>)", () => {
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-")); });

  it("\"Hey Nova\" fires one wake for Nova, with a confidence, and never reports what it heard", async () => {
    const f = sayFile("hey-nova", "[[slnc 600]] Hey Nova, are you there?");
    const { events, code, stderr } = await run(["--mode", "wake", "--names", "Nova,Atlas", "--locale", "en-US", "--file", f]);
    expect(code, stderr).toBe(0);
    const wakes = events.filter((e) => e.type === "wake");
    expect(wakes, stderr).toHaveLength(1);
    expect(wakes[0]!.name).toBe("Nova");
    expect(wakes[0]!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(types(events)).not.toContain("partial");
    expect(types(events)).not.toContain("final");
    expect(types(events)).not.toContain("speech-start");
    // Nothing transcribed is written anywhere: the log never carries the words.
    expect(stderr.toLowerCase()).not.toContain("are you there");
  }, 90_000);

  it("the name without \"hey\" in front of it, or another word before it, does not fire", async () => {
    const f = sayFile("no-hey", "[[slnc 600]] Nova is a nice name. [[slnc 1500]] Hello Nova. [[slnc 1500]] Hey there.");
    const { events, code, stderr } = await run(["--mode", "wake", "--names", "Nova", "--locale", "en-US", "--file", f]);
    expect(code, stderr).toBe(0);
    expect(types(events)).not.toContain("wake");
  }, 90_000);

  it("a name that isn't a Bot's does not fire", async () => {
    const f = sayFile("other", "[[slnc 600]] Hey Atlas, what's up?");
    const { events, code } = await run(["--mode", "wake", "--names", "Nova", "--locale", "en-US", "--file", f]);
    expect(code).toBe(0);
    expect(types(events)).not.toContain("wake");
  }, 90_000);

  it("the names can change while listening (a Bot was added or renamed)", async () => {
    const f = sayFile("renamed", "[[slnc 1500]] Hey Atlas, are you there?");
    let sent = false;
    let stopped = false;
    const { events, code, stderr } = await run(["--mode", "wake", "--names", "Nova", "--locale", "en-US", "--file", f], {
      stdin: (write, evs) => {
        if (!sent && evs.some((e) => e.type === "ready")) { sent = true; write(`names ${JSON.stringify({ names: ["Atlas"] })}`); }
        if (!stopped && evs.some((e) => e.type === "wake")) { stopped = true; write("stop"); }
      },
    });
    expect(code, stderr).toBe(0);
    expect(events.find((e) => e.type === "wake")?.name).toBe("Atlas");
  }, 90_000);
});
