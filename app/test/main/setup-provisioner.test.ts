import { describe, expect, it, vi } from "vitest";
import { BoxProvisioner, plainError, type BoxStep, type ProvisionState } from "../../src/main/setup/provisioner";

// Portable install: "Set up the Bots' computer" is idempotent and resumable. Every step checks whether it
// is already done before it runs, so a retry after a failure (or a relaunch mid-way) picks up where it
// stopped and never recreates what is already there.
function fakeSteps(o: { done?: Partial<Record<string, boolean>>; fail?: Record<string, string> } = {}) {
  const ran: string[] = [];
  const done = { create: false, start: false, provision: false, deploy: false, connect: false, ...(o.done ?? {}) } as Record<string, boolean>;
  const fail = { ...(o.fail ?? {}) };
  const step = (id: BoxStep["id"], weight: number): BoxStep => ({
    id, label: id, weight,
    done: async () => done[id]!,
    run: async (ctx) => {
      ran.push(id);
      ctx.line(`${id}: working`);
      ctx.progress(0.5);
      if (fail[id]) { const m = fail[id]!; delete fail[id]; throw new Error(m); }
      done[id] = true;
    },
  });
  const steps = [step("create", 5), step("start", 2), step("provision", 70), step("deploy", 18), step("connect", 5)];
  return { steps, ran, done };
}

describe("setting up the Bots' computer", () => {
  it("runs every step in order and ends ready at 100 %, the bar never going backwards", async () => {
    const f = fakeSteps();
    const seen: ProvisionState[] = [];
    const p = new BoxProvisioner({ steps: f.steps, publish: (s) => seen.push(s) });
    const end = await p.start();
    expect(f.ran).toEqual(["create", "start", "provision", "deploy", "connect"]);
    expect(end.phase).toBe("ready");
    expect(end.progress).toBe(1);
    const bars = seen.map((s) => s.progress);
    for (let i = 1; i < bars.length; i++) expect(bars[i]!).toBeGreaterThanOrEqual(bars[i - 1]!);
    expect(end.log.join("\n")).toMatch(/provision: working/);
  });

  it("skips what is already done (an existing machine is never created again)", async () => {
    const f = fakeSteps({ done: { create: true, start: true } });
    await new BoxProvisioner({ steps: f.steps, publish: () => {} }).start();
    expect(f.ran).toEqual(["provision", "deploy", "connect"]);
  });

  it("an existing, fully set-up computer is ready without running anything", async () => {
    const f = fakeSteps({ done: { create: true, start: true, provision: true, deploy: true, connect: true } });
    const end = await new BoxProvisioner({ steps: f.steps, publish: () => {} }).start();
    expect(f.ran).toEqual([]);
    expect(end.phase).toBe("ready");
  });

  it("a failure stops on that step with a plain error; Retry resumes there", async () => {
    const f = fakeSteps({ fail: { provision: "E: Failed to fetch http://deb.debian.org/... Temporary failure resolving 'deb.debian.org'" } });
    const p = new BoxProvisioner({ steps: f.steps, publish: () => {} });
    const failed = await p.start();
    expect(failed.phase).toBe("failed");
    expect(failed.step).toBe("provision");
    expect(failed.error).toMatch(/internet/i);
    expect(failed.progress).toBeGreaterThan(0);
    expect(failed.progress).toBeLessThan(1);
    const ok = await p.start();
    expect(ok.phase).toBe("ready");
    expect(f.ran).toEqual(["create", "start", "provision", "provision", "deploy", "connect"]);
  });

  it("a second Start while one is running joins it rather than starting another", async () => {
    const f = fakeSteps();
    const p = new BoxProvisioner({ steps: f.steps, publish: () => {} });
    const [a, b] = await Promise.all([p.start(), p.start()]);
    expect(a).toEqual(b);
    expect(f.ran.filter((s) => s === "create")).toHaveLength(1);
  });

  it("cancel stops before the next step and says so", async () => {
    const f = fakeSteps();
    let p!: BoxProvisioner;
    f.steps[1]!.run = vi.fn(async () => { p.cancel(); });
    p = new BoxProvisioner({ steps: f.steps, publish: () => {} });
    const end = await p.start();
    expect(end.phase).toBe("cancelled");
    expect(f.ran).toEqual(["create"]);
  });

  it("keeps only the tail of a long log", async () => {
    const f = fakeSteps();
    f.steps[2]!.run = async (ctx) => { for (let i = 0; i < 2000; i++) ctx.line(`line ${i}`); };
    const end = await new BoxProvisioner({ steps: f.steps, publish: () => {} }).start();
    expect(end.log.length).toBeLessThanOrEqual(400);
    expect(end.log.at(-1)).not.toBe(undefined);
  });
});

describe("plain-language errors", () => {
  it.each([
    ["curl: (6) Could not resolve host: nodejs.org", /internet/i],
    ["Temporary failure resolving 'deb.debian.org'", /internet/i],
    ["write /var/lib/x: No space left on device", /space/i],
    ["spawn orb ENOENT", /OrbStack/],
    ["Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (apt-get)", /busy|another/i],
    ["FAIL gateway /health via localhost (http://127.0.0.1:47801)", /didn.t start|start/i],
    ["FAIL http://127.0.0.1:47900: Synapse is running in another account on this Mac and is using this account's connection. Quit Synapse there, then retry.", /^Synapse is running in another account on this Mac/],
  ])("%s", (raw, want) => {
    expect(plainError(raw, "provision")).toMatch(want);
  });

  it("falls back to naming the step, with the detail kept short", () => {
    const m = plainError(`something odd ${"x".repeat(900)}`, "deploy");
    expect(m).toMatch(/installing the Bots' software|deploy/i);
    expect(m.length).toBeLessThan(400);
  });
});
