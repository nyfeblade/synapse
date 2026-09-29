import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/main/box-provider";
import { boxSteps, type BoxStepDeps } from "../../src/main/setup/box-steps";
import { BoxProvisioner } from "../../src/main/setup/provisioner";
import { adoptable, boxMachineName, detectOrb, listMachines, machineMarks, machineSize, startOrbStack } from "../../src/main/setup/orb";
import { WRONG_HOST_MESSAGE } from "@synapse/shared";

const ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orb";
const IMAGE = "0123456789abcdef";
const HOST = "fedcba9876543210";

/** A fake OrbStack: one machine table, the markers inside each machine, and a log of every call. */
function fakeOrb(init: { machines?: Array<{ name: string; state: string; isolated?: boolean; image?: string | null; provisioned?: string | null; created?: boolean; host?: string | null; gateway?: boolean }> } = {}) {
  const machines = new Map((init.machines ?? []).map((m) => [m.name, { isolated: true, image: null, provisioned: null, created: false, host: null, gateway: false, ...m }]));
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "list") return { code: 0, stdout: JSON.stringify([...machines.values()].map((m) => ({ name: m.name, state: m.state, config: { isolated: m.isolated } }))), stderr: "" };
    if (args[0] === "create") {
      const name = args.at(-1)!;
      machines.set(name, { name, state: "running", isolated: args.includes("--isolated"), image: null, provisioned: null, created: false, host: null, gateway: false });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "start") { const m = machines.get(args[1]!); if (m) m.state = "running"; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "-m") {
      const m = machines.get(args[1]!)!;
      const script = args.at(-1)!;
      if (script.includes("created-by-synapse") && script.startsWith("install")) { m.created = true; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: `${m.image ?? ""}\n|\n${m.provisioned ?? ""}\n|\n${m.created ? "yes" : ""}\n|\n${m.host ?? ""}\n|\n${m.gateway ? "yes" : ""}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, machines, calls };
}

function deps(f: ReturnType<typeof fakeOrb>, o: Partial<BoxStepDeps> & { scripts?: string[]; envs?: Record<string, string>[]; failProvision?: string } = {}): BoxStepDeps {
  let connected = false;
  const scripts = o.scripts ?? [];
  const envs = o.envs ?? [];
  return {
    exec: f.exec, orb: () => ORB, machine: "synapse-box", boxDir: "/App/Resources/box",
    imageVersion: () => IMAGE, hostBuild: () => HOST,
    reconnect: async () => { connected = !!f.machines.get("synapse-box")?.gateway; },
    connected: () => connected,
    forgetPin: () => scripts.push("forget-pin"),
    mac: { cpus: 10, totalMemBytes: 32 * 1024 ** 3 },
    run: async (_cmd, args, r) => {
      const script = args[0]!.split("/").at(-1)!;
      scripts.push(`${script} ${r.env.BOX_MACHINE}`);
      envs.push(r.env);
      r.ctx.line("::step 3/10 Node.js");
      const m = f.machines.get(r.env.BOX_MACHINE!)!;
      if (script === "provision-from-mac.sh") {
        if (o.failProvision) { const e = o.failProvision; o.failProvision = undefined; throw new Error(e); }
        m.image = IMAGE; m.provisioned = IMAGE;
      }
      if (script === "deploy.sh") { m.host = HOST; m.gateway = true; }
    },
    ...o,
  };
}

describe("first run on a new Mac", () => {
  it("creates an isolated arm64 machine sized to this Mac, marks it, provisions, deploys and connects", async () => {
    const f = fakeOrb();
    const scripts: string[] = [];
    const end = await new BoxProvisioner({ steps: boxSteps(deps(f, { scripts })), publish: () => {} }).start();
    expect(end.phase).toBe("ready");
    const create = f.calls.find((c) => c[1] === "create")!;
    expect(create).toEqual([ORB, "create", "--isolated", "-a", "arm64", "--cpus", "4", "--memory", "8192", "--disk", "64G", "-u", "synapse-admin", "debian:bookworm", "synapse-box"]);
    expect(f.machines.get("synapse-box")!.created).toBe(true);
    expect(scripts).toEqual(["forget-pin", "provision-from-mac.sh synapse-box", "deploy.sh synapse-box"]);
  });

  it("hands this Mac user's own ports to provision and deploy (two accounts on one Mac)", async () => {
    const f = fakeOrb();
    const envs: Record<string, string>[] = [];
    await new BoxProvisioner({ steps: boxSteps(deps(f, { envs, uid: 502 })), publish: () => {} }).start();
    expect(envs).toHaveLength(2);
    for (const e of envs) expect(e).toMatchObject({ SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_WEBHOOK_PORT: "47901", SYNAPSE_AUTH_PROXY_PORT: "47902" });
  });

  it("the deploy counts as done only when the host is on this user's port", async () => {
    const seen: string[] = [];
    await machineMarks(async (_c, args) => { seen.push(args.at(-1)!); return { code: 0, stdout: "", stderr: "" }; }, ORB, "synapse-box", 47900);
    expect(seen[0]).toContain("47900");
  });

  it("one wrong-host answer is retried (a stale token after the machine was recreated) before setup gives up", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "running", image: IMAGE, provisioned: IMAGE, created: true, host: HOST, gateway: true }] });
    let tries = 0;
    let connected = false;
    const end = await new BoxProvisioner({
      steps: boxSteps(deps(f, { reconnect: async () => { tries++; connected = tries >= 2; }, connected: () => connected, connectError: () => (connected ? null : WRONG_HOST_MESSAGE) })),
      publish: () => {},
    }).start();
    expect(end.phase).toBe("ready");
    expect(tries).toBe(2);
  });

  it("a port answered by another account's host fails the connection plainly, not as \"didn't start\"", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "running", image: IMAGE, provisioned: IMAGE, created: true, host: HOST, gateway: true }] });
    const end = await new BoxProvisioner({
      steps: boxSteps(deps(f, { reconnect: async () => {}, connected: () => false, connectError: () => WRONG_HOST_MESSAGE })),
      publish: () => {},
    }).start();
    expect(end.phase).toBe("failed");
    expect(end.error).toBe(WRONG_HOST_MESSAGE);
  });

  it("resumes after a failed provision: the machine is not created twice, and provision runs again", async () => {
    const f = fakeOrb();
    const scripts: string[] = [];
    const p = new BoxProvisioner({ steps: boxSteps(deps(f, { scripts, failProvision: "E: Could not resolve host deb.debian.org" })), publish: () => {} });
    const failed = await p.start();
    expect(failed.phase).toBe("failed");
    expect(failed.step).toBe("provision");
    expect(failed.error).toMatch(/internet/i);
    const ok = await p.start();
    expect(ok.phase).toBe("ready");
    expect(f.calls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(scripts.filter((s) => s.startsWith("provision"))).toHaveLength(2);
  });

  it("an already set-up machine (a relaunch after setup) runs nothing but the connection", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "running", image: IMAGE, provisioned: IMAGE, created: true, host: HOST, gateway: true }] });
    const scripts: string[] = [];
    const end = await new BoxProvisioner({ steps: boxSteps(deps(f, { scripts })), publish: () => {} }).start();
    expect(end.phase).toBe("ready");
    expect(scripts).toEqual([]);
    expect(f.calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("a stopped machine is started, not recreated", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "stopped", image: IMAGE, provisioned: IMAGE, created: true, host: HOST, gateway: true }] });
    await new BoxProvisioner({ steps: boxSteps(deps(f)), publish: () => {} }).start();
    expect(f.calls.some((c) => c[1] === "start" && c[2] === "synapse-box")).toBe(true);
    expect(f.calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("never provisions a machine of the same name that Synapse didn't make", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "running" }] });
    const scripts: string[] = [];
    const end = await new BoxProvisioner({ steps: boxSteps(deps(f, { scripts })), publish: () => {} }).start();
    expect(end.phase).toBe("failed");
    expect(end.error).toMatch(/wasn't made by Synapse/);
    expect(scripts).toEqual([]);
    // Not isolated either way: refused.
    expect(adoptable({ name: "x", state: "running", isolated: false }, { image: IMAGE, provisioned: null, created: true })).toBe(false);
  });

  it("an older machine re-provisions when the bundle's box files changed", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "running", image: "aaaaaaaaaaaaaaaa", created: true, host: HOST, gateway: true }] });
    const scripts: string[] = [];
    await new BoxProvisioner({ steps: boxSteps(deps(f, { scripts })), publish: () => {} }).start();
    expect(scripts).toEqual(["provision-from-mac.sh synapse-box"]);
  });
});

// Fix round 1: OrbStack's very first launch shows its own window (licence, helper install); only once it has
// been set up does Synapse start it in the background.
describe("starting OrbStack", () => {
  it("opens OrbStack's window the first time, and starts it in the background after that", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
    await startOrbStack(exec, { home: "/Users/x", exists: () => false });
    await startOrbStack(exec, { home: "/Users/x", exists: (p) => p === "/Users/x/.orbstack" });
    expect(calls).toEqual([["/usr/bin/open", "-a", "OrbStack"], ["/usr/bin/open", "-g", "-a", "OrbStack"]]);
  });
});

describe("OrbStack and the machine name", () => {
  it("a profile that already pinned a box keeps 'box'; a new one gets 'synapse-box'; a setting wins", () => {
    expect(boxMachineName({ userData: "/p", exists: (p) => p === "/p/box-pin.json" })).toBe("box");
    expect(boxMachineName({ userData: "/p", exists: () => false })).toBe("synapse-box");
    expect(boxMachineName({ userData: "/p", exists: () => true, setting: "synapse-box" })).toBe("synapse-box");
    expect(boxMachineName({ userData: "/p", exists: () => false, setting: "../evil name" })).toBe("synapse-box");
  });

  it("reads OrbStack's status the way its CLI reports it", async () => {
    const at = (code: number): Exec => async (_c, a) => (a[0] === "status" ? { code, stdout: ["Running", "Stopped", "Starting"][code] ?? "", stderr: "" } : { code: 0, stdout: "Version: 2.2.3 (2020300)", stderr: "" });
    const base = { home: "/Users/x", exists: (p: string) => p === "/Applications/OrbStack.app", isExec: (p: string) => p === ORB };
    expect(await detectOrb({ ...base, exec: at(0) })).toMatchObject({ app: true, cli: true, status: "running", version: "2.2.3" });
    expect(await detectOrb({ ...base, exec: at(1) })).toMatchObject({ status: "stopped" });
    expect(await detectOrb({ ...base, exec: at(2) })).toMatchObject({ status: "starting" });
    expect(await detectOrb({ home: "/Users/x", exec: at(0), exists: () => false, isExec: () => false })).toMatchObject({ app: false, cli: false });
  });

  it("parses `orb list -f json` and survives OrbStack being down", async () => {
    const f = fakeOrb({ machines: [{ name: "box", state: "running" }] });
    expect(await listMachines(f.exec, ORB)).toEqual([{ name: "box", state: "running", isolated: true }]);
    expect(await listMachines(async () => ({ code: 1, stdout: "", stderr: "not running" }), ORB)).toEqual([]);
  });

  it("sizes the machine to the Mac: at most 4 CPUs and 8 GiB, never more than half the memory", () => {
    expect(machineSize({ cpus: 10, totalMemBytes: 32 * 1024 ** 3 })).toEqual({ cpus: 4, memoryMib: 8192, disk: "64G" });
    expect(machineSize({ cpus: 8, totalMemBytes: 8 * 1024 ** 3 })).toEqual({ cpus: 4, memoryMib: 4096, disk: "64G" });
  });
});
