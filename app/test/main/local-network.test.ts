import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalNetwork } from "../../src/main/local-network";

/** 0.1.4 Settings → Local network: a fake box whose bots-ports answers like the real one. */
function box(o: { failOn?: boolean; failOff?: boolean; unreachable?: boolean } = {}) {
  const s = { loaded: false, conf: false, wanted: false, runs: [] as string[][], logs: [] as string[], pauses: [] as boolean[] };
  const ln = new LocalNetwork({
    run: async (args) => {
      s.runs.push(args);
      if (o.unreachable) throw new Error("orb: machine not running");
      if (args[1] === "status") return { code: 0, stdout: s.loaded ? "on\n" : "off\n" };
      if (args[1] === "state") return { code: 0, stdout: `${s.loaded ? "on" : "off"} ${s.conf ? "on" : "off"}\n` };
      if (args[1] === "on" && o.failOn) { s.conf = false; return { code: 1, stdout: s.loaded ? "on\n" : "off\n" }; } // back to blocking
      if (args[1] === "off" && o.failOff) { s.conf = false; return { code: 1, stdout: s.loaded ? "on\n" : "off\n" }; } // reload failed
      s.loaded = args[1] === "on";
      s.conf = s.loaded;
      return { code: 0, stdout: `${args[1]}\n` };
    },
    wanted: () => s.wanted,
    setWanted: (on) => { s.wanted = on; },
    log: (l) => s.logs.push(l),
  });
  ln.setPauseHost(async (on) => { s.pauses.push(on); });
  return { s, ln };
}

describe("LocalNetwork (main process, owner only)", () => {
  it("reads the box's loaded firewall, and applies on/off live through bots-ports local-network", async () => {
    const { s, ln } = box();
    expect(await ln.get()).toEqual({ on: false });
    expect(await ln.set(true)).toEqual({ on: true });
    expect(s.wanted).toBe(true);
    expect(s.runs).toContainEqual(["local-network", "on"]);
    expect(await ln.set(false)).toEqual({ on: false });
    expect(s.wanted).toBe(false);
  });

  it("fail closed: a turn-on the box refused reads back off and isn't remembered as on", async () => {
    const { s, ln } = box({ failOn: true });
    expect(await ln.set(true)).toEqual({ on: false });
    expect(s.wanted).toBe(false);
    expect(s.loaded).toBe(false);
  });

  it("a box that can't be asked is an error, never a guessed value", async () => {
    const { ln } = box({ unreachable: true });
    await expect(ln.get()).rejects.toThrow();
    await expect(ln.set(true)).rejects.toThrow();
  });

  it("reconcile puts the owner's choice back after the box was recreated (Update, Reset), and nothing else", async () => {
    const { s, ln } = box();
    await ln.reconcile();
    expect(s.runs).toEqual([["local-network", "status"]]); // off and wanted off: nothing to do
    s.wanted = true;
    await ln.reconcile();
    expect(s.loaded).toBe(true);
    s.runs.length = 0;
    await ln.reconcile();
    expect(s.runs).toEqual([["local-network", "status"]]);
    s.wanted = false;
    await ln.reconcile();
    expect(s.loaded).toBe(false);
  });

  it("reconcile that can't reopen it logs and leaves it off", async () => {
    const { s, ln } = box({ failOn: true });
    s.wanted = true;
    await ln.reconcile();
    expect(s.loaded).toBe(false);
    expect(s.logs.join("\n")).toMatch(/couldn't reopen/);
  });

  // 0.1.4 tamper check, on every watcher tick.
  it("verify: loaded state and config both match the owner's choice, nothing happens", async () => {
    const { s, ln } = box();
    expect(await ln.verify()).toBe("ok");
    expect(s.pauses).toEqual([]);
    expect(s.runs).toEqual([["local-network", "state"]]);
  });

  it("verify: the box opened behind the owner's back is paused, closed again and unpaused", async () => {
    const { s, ln } = box();
    s.loaded = true; s.conf = true; // root in the box turned it on
    expect(await ln.verify()).toBe("fixed");
    expect(s.pauses).toEqual([true, false]);
    expect(s.loaded).toBe(false);
    expect(s.runs).toContainEqual(["local-network", "off"]);
    expect(s.logs.join("\n")).toMatch(/owner chose off/);
  });

  it("verify: a config edited but not loaded (or loaded but not saved) is a mismatch too", async () => {
    const { s, ln } = box();
    s.conf = true;
    expect(await ln.verify()).toBe("fixed");
    expect(s.conf).toBe(false);
    s.wanted = true; s.loaded = true; s.conf = true;
    s.loaded = false; // loaded closed, config open
    expect(await ln.verify()).toBe("fixed");
    expect(s.loaded && s.conf).toBe(true);
  });

  it("verify: the owner's on that can't be applied again fails closed (off, remembered off) and unpauses once safe", async () => {
    const { s, ln } = box({ failOn: true });
    s.wanted = true; // owner chose on; the box was reset to blocked, and turning on fails
    expect(await ln.verify()).toBe("fixed");
    expect(s.wanted).toBe(false);
    expect(s.loaded).toBe(false);
    expect(s.pauses).toEqual([true, false]);
  });

  it("verify: a box that stays open against the owner's off stays paused until it matches", async () => {
    const { s, ln } = box({ failOff: true });
    s.loaded = true; s.conf = true;
    expect(await ln.verify()).toBe("mismatch");
    expect(s.pauses).toEqual([true]);
    expect(await ln.verify()).toBe("mismatch");
    s.loaded = false; s.conf = false; // fixed (a reload went through)
    expect(await ln.verify()).toBe("ok");
    expect(s.pauses.at(-1)).toBe(false);
  });

  it("verify: a box that can't be asked changes nothing; a host that can't be told is retried", async () => {
    const { s, ln } = box({ unreachable: true });
    expect(await ln.verify()).toBe("unknown");
    expect(s.pauses).toEqual([]);
    const b = box({ failOff: true });
    let hostUp = false;
    b.ln.setPauseHost(async (on) => { if (!hostUp) throw new Error("down"); b.s.pauses.push(on); });
    b.s.loaded = true; b.s.conf = true;
    await b.ln.verify();
    expect(b.s.pauses).toEqual([]);
    hostUp = true;
    await b.ln.verify();
    expect(b.s.pauses).toEqual([true]);
  });

  it("the Settings handlers are the only caller: nothing in the host or shared code runs it", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync("git grep -lE '\"local-network\", \"(on|off)\"|bots-ports.*local-network|localNetwork\\.set' -- host shared ':!*.md' ':!host/test' ':!shared/test' || true", { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
});
