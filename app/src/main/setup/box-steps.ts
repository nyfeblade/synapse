import { spawn } from "node:child_process";
import readline from "node:readline";
import { boxPortEnv, userPorts, WRONG_HOST_MESSAGE } from "@synapse/shared";
import { macNetsEnv } from "../mac-nets";
import type { Exec } from "../box-provider";
import { ORB_LIMITS, SCRIPT_LIMITS, orbCall } from "../orb-exec";
import type { BoxStep, StepContext } from "./provisioner";
import { adoptable, CREATED_MARKER, listMachines, machineMarks, machineSize, type MachineInfo, type MachineMarks } from "./orb";

/** Runs a box script with its output streamed line by line; `::step n/N label` lines move the bar. */
export type RunStreamed = (cmd: string, args: string[], o: { env: Record<string, string>; ctx: StepContext; timeoutMs: number }) => Promise<void>;

export const runStreamed: RunStreamed = (cmd, args, o) => new Promise((resolve, reject) => {
  // Bug 435: its own process group, so a stop reaches the script's `orb` children too (a stuck one held the pipes).
  const c = spawn(cmd, args, { env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let tail = "";
  const onLine = (l: string) => {
    const m = /^::step (\d+)\/(\d+)\s*(.*)$/.exec(l.trim());
    if (m) {
      const n = Number(m[1]);
      const total = Math.max(1, Number(m[2]));
      o.ctx.progress((n - 1) / total);
      o.ctx.line(`${m[3] || `step ${n}`} (${n}/${total})`);
      return;
    }
    tail = `${tail}\n${l}`.slice(-4000);
    o.ctx.line(l);
  };
  readline.createInterface({ input: c.stdout! }).on("line", onLine);
  readline.createInterface({ input: c.stderr! }).on("line", onLine);
  const group = (sig: NodeJS.Signals) => { try { if (c.pid) process.kill(-c.pid, sig); else c.kill(sig); } catch { try { c.kill(sig); } catch { /* gone */ } } };
  let hard: NodeJS.Timeout | null = null;
  const kill = () => { group("SIGTERM"); hard ??= setTimeout(() => group("SIGKILL"), 5_000); };
  const t = setTimeout(() => { kill(); }, o.timeoutMs);
  o.ctx.signal.addEventListener("abort", kill, { once: true });
  c.on("error", (e) => { clearTimeout(t); reject(e); });
  c.on("close", (code, signal) => {
    clearTimeout(t);
    if (hard) clearTimeout(hard);
    o.ctx.signal.removeEventListener("abort", kill);
    if (code === 0) resolve();
    else reject(new Error(`${signal ? `stopped (${signal})` : `exit ${code}`}${tail ? `:${tail.slice(-1500)}` : ""}`));
  });
});

export interface BoxStepDeps {
  exec: Exec;
  orb(): string;
  machine: string;
  /** The bundled box/ folder (provision-from-mac.sh, deploy.sh, …). */
  boxDir: string;
  /** What the bundle provisions (bundledImageVersion) and deploys (the host build id); null = unknown. */
  imageVersion(): string | null;
  hostBuild(): string | null;
  /** Reconnect the app to the host; resolves once it tried. `connected()` says whether it worked. */
  reconnect(): Promise<void>;
  connected(): boolean;
  /** Why the last reconnect failed, when it's something the user must hear as it is (another account's host). */
  connectError?(): string | null;
  /** This Mac user's uid: the box gets this user's own ports (two accounts on one Mac, user-ports.ts). */
  uid?: number;
  /** The app created (or recreated) the machine: its box key is new, so the old pin must go. */
  forgetPin(): void;
  /** This Mac, for sizing the machine. */
  mac: { cpus: number; totalMemBytes: number };
  run?: RunStreamed;
}

/** The five steps of "Set up the Bots' computer", each idempotent. */
export function boxSteps(d: BoxStepDeps): BoxStep[] {
  const run = d.run ?? runStreamed;
  const uid = d.uid ?? process.getuid?.() ?? 501;
  // Bug 365: the Mac's own networks go to the box firewall at provision and deploy.
  const env = () => ({ ORB: d.orb(), BOX_MACHINE: d.machine, ...boxPortEnv(uid), ...macNetsEnv() });
  let listed: MachineInfo[] | null = null;
  let marks: MachineMarks | null = null;
  const machine = async (): Promise<MachineInfo | undefined> => {
    listed = await listMachines(d.exec, d.orb());
    return listed.find((m) => m.name === d.machine);
  };
  const readMarks = async (): Promise<MachineMarks> => (marks = await machineMarks(d.exec, d.orb(), d.machine, userPorts(uid).gateway));
  const orb = async (args: string[], timeoutMs: number, what: string, idempotent: boolean) => {
    const r = await orbCall(d.exec, d.orb(), args, { timeoutMs, idempotent });
    if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    return r;
  };

  return [
    {
      id: "create", label: "Creating the Bots' computer", weight: 6,
      // Exists at all: whether it is OURS is checked before anything changes inside it (provision).
      done: async () => !!(await machine()),
      run: async (ctx) => {
        if (await machine()) return;
        const size = machineSize(d.mac);
        ctx.line(`orb create ${d.machine} (Debian 12, ${size.cpus} CPUs, ${size.memoryMib} MiB, ${size.disk})`);
        ctx.progress(0.1);
        await orb(["create", "--isolated", "-a", "arm64", "--cpus", String(size.cpus), "--memory", String(size.memoryMib), "--disk", size.disk, "-u", "synapse-admin", "debian:bookworm", d.machine], ORB_LIMITS.create, "OrbStack couldn't create the machine", false);
        // Marked the moment it exists, so a retry after any later failure adopts it instead of refusing it.
        await orb(["-m", d.machine, "-u", "root", "sh", "-c", `install -d -m 0755 /etc/bots && date -u +%FT%TZ > ${CREATED_MARKER}`], ORB_LIMITS.inBox, "Couldn't mark the new machine", true);
        d.forgetPin();
        ctx.progress(1);
      },
    },
    {
      id: "start", label: "Starting the Bots' computer", weight: 2,
      done: async () => (await machine())?.state === "running",
      run: async () => { await orb(["start", d.machine], ORB_LIMITS.start, "The machine didn't start", true); },
    },
    {
      id: "provision", label: "Installing the system software", weight: 70,
      done: async () => {
        const want = d.imageVersion();
        const m = await readMarks();
        if (!adoptable(await machine(), m)) return false;
        return want !== null && (m.provisioned ?? m.image) === want;
      },
      run: async (ctx) => {
        // A user's own machine that shares the name is never provisioned (or reset, or deleted).
        if (!adoptable(await machine(), marks ?? (await readMarks()))) {
          throw new Error(`A machine called "${d.machine}" already exists in OrbStack and wasn't made by Synapse. Synapse won't touch it. Rename or delete it in OrbStack, then retry.`);
        }
        await run("/bin/bash", [`${d.boxDir}/provision-from-mac.sh`], { env: env(), ctx, timeoutMs: SCRIPT_LIMITS.provision });
        marks = null;
      },
    },
    {
      id: "deploy", label: "Installing the Bots' software", weight: 17,
      done: async () => {
        const want = d.hostBuild();
        const m = marks ?? (await readMarks());
        return want !== null && m.hostBuild === want && m.gateway;
      },
      run: async (ctx) => {
        await run("/bin/bash", [`${d.boxDir}/deploy.sh`], { env: env(), ctx, timeoutMs: SCRIPT_LIMITS.deploy });
      },
    },
    {
      id: "connect", label: "Connecting", weight: 5,
      done: async () => d.connected(),
      run: async (ctx) => {
        let wrongHost = 0;
        for (let i = 0; i < 3 && !d.connected(); i++) {
          ctx.progress(i / 3);
          await d.reconnect();
          // Another account's host holds the port: said twice in a row (a stale token gets one more go, and the
          // reconnect re-reads gateway.json), waiting won't change it, and the user must be told as it is.
          wrongHost = !d.connected() && d.connectError?.() === WRONG_HOST_MESSAGE ? wrongHost + 1 : 0;
          if (wrongHost >= 2) throw new Error(WRONG_HOST_MESSAGE);
          if (!d.connected()) await new Promise((r) => setTimeout(r, 2_000));
        }
        if (!d.connected() && wrongHost > 0) throw new Error(WRONG_HOST_MESSAGE);
        if (!d.connected()) throw new Error("The host did not start (no gateway connection).");
      },
    },
  ];
}
