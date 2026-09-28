import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactField, scrubSecrets, type RawField } from "../../teach/redact";
import { startSidecar, type SidecarEvent } from "../../teach/sidecar";
import type { CdpLike } from "../../teach/cdp";
import { parseXmodmap, XinputParser, type XInputLike } from "../../teach/xinput";

const field = (p: Partial<RawField>): RawField => ({ role: "textbox", name: "amount", inputType: "text", autocomplete: "", label: "Amount", value: "42.10", ...p });

describe("redactField (ORIG-08 §08.1 redaction at capture time)", () => {
  it("keeps ordinary values", () => expect(redactField(field({}))).toBe("42.10"));
  it.each([
    [{ inputType: "password" }], [{ autocomplete: "current-password" }], [{ autocomplete: "new-password" }], [{ autocomplete: "one-time-code" }],
    [{ autocomplete: "cc-number" }], [{ name: "user_pin" }], [{ label: "CVV" }], [{ name: "ssn" }], [{ label: "Verification code" }],
    [{ name: "api_token" }], [{ label: "Client secret" }], [{ name: "otp" }], [{ value: "x".repeat(201) }],
  ])("redacts %o", (p) => expect(redactField(field(p as Partial<RawField>))).toBe("[redacted]"));
});

describe("XinputParser and keysyms", () => {
  it("parses raw button and key events", () => {
    const p = new XinputParser();
    const out = ["EVENT type 15 (RawButtonPress)", "    device: 11 (11)", "    detail: 1", "EVENT type 13 (RawKeyPress)", "    device: 3 (3)", "    detail: 36", "EVENT type 16 (RawButtonRelease)", "    detail: 1", "EVENT type 17 (RawMotion)", "    detail: 0"].map((l) => p.push(l)).filter(Boolean);
    expect(out).toEqual([{ kind: "press", device: "button", detail: 1 }, { kind: "press", device: "key", detail: 36 }, { kind: "release", device: "button", detail: 1 }]);
  });
  it("reads xmodmap -pke", () => {
    expect(parseXmodmap("keycode  36 = Return NoSymbol Return\nkeycode  38 = a A a A\nkeycode 200 =\n")).toEqual(new Map([[36, "Return"], [38, "a"]]));
  });
});

class FakeX implements XInputLike {
  private q: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  keys = new Map([[36, "Return"], [23, "Tab"], [37, "Control_L"], [39, "s"], [43, "h"], [26, "e"], [46, "l"], [32, "o"], [65, "space"]]);
  emit(...lines: string[]) { this.q.push(...lines); this.wake?.(); }
  press(dev: "Button" | "Key", detail: number) { this.emit(`EVENT type 0 (Raw${dev}Press)`, `    detail: ${detail}`); }
  release(dev: "Button" | "Key", detail: number) { this.emit(`EVENT type 0 (Raw${dev}Release)`, `    detail: ${detail}`); }
  lines = { [Symbol.asyncIterator]: () => ({ next: async (): Promise<IteratorResult<string>> => {
    while (!this.q.length && !this.closed) await new Promise<void>((r) => { this.wake = r; });
    return this.q.length ? { value: this.q.shift()!, done: false } : { value: undefined, done: true };
  } }) };
  keysym(k: number) { return this.keys.get(k) ?? null; }
  async pointer() { return { x: 640, y: 400 }; }
  async activeWindow() { return { title: "Expenses — Chromium", class: "chromium" }; }
  close() { this.closed = true; this.wake?.(); }
}

class FakeCdp implements CdpLike {
  nav: ((e: { url: string; title: string; tabId: string }) => void) | null = null;
  fieldCb: ((f: RawField) => void) | null = null;
  snaps = 0;
  onNavigate(cb: (e: { url: string; title: string; tabId: string }) => void) { this.nav = cb; }
  onField(cb: (f: RawField) => void) { this.fieldCb = cb; }
  async targetAt() { return { role: "button", name: "Submit report", url: "https://expenses.example/new", bbox: [600, 380, 80, 30] as [number, number, number, number] }; }
  async snapshot() { this.snaps++; return { url: "https://expenses.example/new", nodes: [{ role: "button", name: "Submit report", depth: 1 }] }; }
  async close() {}
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("startSidecar", () => {
  function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
    const x = new FakeX();
    const cdp = new FakeCdp();
    let t = 1000;
    const h = startSidecar({ sessionDir: dir, startedAtMs: 1000, xinput: x, cdp, now: () => (t += 100) });
    const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as SidecarEvent);
    return { dir, x, cdp, h, events };
  }

  it("counts printable keys without storing characters; records shortcuts and non-printable keys by name", async () => {
    const s = run();
    for (const k of [43, 26, 46, 46, 32]) { s.x.press("Key", k); s.x.release("Key", k); }
    s.x.press("Key", 36);
    s.x.press("Key", 37); s.x.press("Key", 39); s.x.release("Key", 39); s.x.release("Key", 37);
    await tick();
    await s.h.stop();
    const ev = s.events();
    expect(ev.filter((e) => e.type !== "snapshot")).toEqual([
      { t: expect.any(Number), type: "text", chars: 5 },
      { t: expect.any(Number), type: "key", key: "Return" },
      { t: expect.any(Number), type: "key", key: "ctrl+s" },
    ]);
    expect(fs.readFileSync(path.join(s.dir, "events.jsonl"), "utf8")).not.toMatch(/"(h|e|l|o)"/);
  });

  it("records pointer down/up with the window, the element under the click, a snapshot, navigations and redacted fields", async () => {
    const s = run();
    s.x.press("Button", 1);
    await tick();
    s.x.release("Button", 1);
    s.x.press("Button", 5);
    s.cdp.nav!({ url: "https://expenses.example/done", title: "Done", tabId: "T1" });
    s.cdp.fieldCb!(field({}));
    s.cdp.fieldCb!(field({ name: "password", inputType: "password", value: "hunter2hunter2" }));
    await tick(700);
    await s.h.stop();
    const ev = s.events();
    expect(ev).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "pointer", action: "down", x: 640, y: 400, button: 1, window: { title: "Expenses — Chromium", class: "chromium" } }),
      expect.objectContaining({ type: "target", role: "button", name: "Submit report", url: "https://expenses.example/new" }),
      expect.objectContaining({ type: "pointer", action: "up", button: 1 }),
      expect.objectContaining({ type: "pointer", action: "scroll", button: 5 }),
      expect.objectContaining({ type: "nav", url: "https://expenses.example/done", title: "Done", tabId: "T1" }),
      expect.objectContaining({ type: "field", name: "amount", value: "42.10" }),
      expect.objectContaining({ type: "field", name: "password", value: "[redacted]" }),
      expect.objectContaining({ type: "snapshot", file: "snapshots/0001.json" }),
    ]));
    expect(fs.existsSync(path.join(s.dir, "snapshots", "0001.json"))).toBe(true);
    expect(fs.readFileSync(path.join(s.dir, "events.jsonl"), "utf8")).not.toContain("hunter2");
  });

  it("stop is idempotent", async () => {
    const s = run();
    await s.h.stop();
    await s.h.stop();
  });

  it("a second start on the same session appends events instead of wiping them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
    const first = startSidecar({
      sessionDir: dir, startedAtMs: 1000, xinput: new FakeX(), cdp: null, now: () => 1100,
    });
    fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ t: 100, type: "key", key: "Return" })}\n`);
    await first.stop();
    const x = new FakeX();
    const second = startSidecar({
      sessionDir: dir, startedAtMs: 1000, xinput: x, cdp: null, now: () => 2000,
    });
    x.press("Key", 36);
    await tick();
    await second.stop();
    const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines[0]).toContain("Return");
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("scrubSecrets", () => {
  it("replaces every secret value of the Bot in events.jsonl and snapshots/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
    fs.mkdirSync(path.join(dir, "snapshots"));
    fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ t: 1, type: "field", value: "acct-9f8e7d" }) + "\n");
    fs.writeFileSync(path.join(dir, "snapshots", "0001.json"), JSON.stringify({ nodes: [{ name: "token acct-9f8e7d here" }] }));
    expect(scrubSecrets(dir, ["acct-9f8e7d", "abc"])).toBe(2);
    expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).not.toContain("acct-9f8e7d");
    expect(fs.readFileSync(path.join(dir, "snapshots", "0001.json"), "utf8")).toContain("[redacted]");
  });
});
