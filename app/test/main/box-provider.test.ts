import { describe, expect, it } from "vitest";
import { OrbBoxProvider, type Exec } from "../../src/main/box-provider";

function fakeExec(script: Record<string, { code?: number; stdout?: string; stderr?: string }[]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const key = [cmd.split("/").pop(), ...args].join(" ");
    calls.push(key);
    const next = script[key]?.shift() ?? { code: 1, stderr: `unexpected ${key}` };
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { exec, calls };
}

describe("OrbBoxProvider", () => {
  it("starts a stopped machine, reads gateway.json, and builds the base URL per route", async () => {
    const { exec, calls } = fakeExec({
      "orb list": [{ stdout: "box  stopped  debian  bookworm  arm64\n" }],
      "orb start box": [{}],
      "orb -m box -u root cat /home/box/.host/gateway.json": [{ code: 1 }, { stdout: '{"port":47800,"token":"abc"}' }],
    });
    const p = new OrbBoxProvider(exec, { machine: "box", route: "orb-hostname", gatewayHost: "box.orb.local", pollMs: 1 });
    await p.ensureRunning();
    expect(await p.readGatewayInfo(1000)).toEqual({ port: 47800, token: "abc" });
    expect((await p.connect(47800)).baseUrl).toBe("http://box.orb.local:47800");
    expect(calls).toEqual(["orb list", "orb start box", "orb -m box -u root cat /home/box/.host/gateway.json", "orb -m box -u root cat /home/box/.host/gateway.json"]);
  });

  it("fails clearly when the machine does not exist", async () => {
    const { exec } = fakeExec({ "orb list": [{ stdout: "other running\n" }] });
    await expect(new OrbBoxProvider(exec, { machine: "box", route: "localhost" }).ensureRunning()).rejects.toThrow(/not found/);
  });

  it("stops a running machine and is a no-op when it is already down", async () => {
    const running = fakeExec({
      "orb list": [{ stdout: "box  running  debian  bookworm  arm64\n" }],
      "orb stop box": [{}],
    });
    await new OrbBoxProvider(running.exec, { machine: "box", route: "localhost" }).stop();
    expect(running.calls).toEqual(["orb list", "orb stop box"]);

    const stopped = fakeExec({ "orb list": [{ stdout: "box  stopped  debian  bookworm  arm64\n" }] });
    await new OrbBoxProvider(stopped.exec, { machine: "box", route: "localhost" }).stop();
    expect(stopped.calls).toEqual(["orb list"]);
  });

  it("uses an ssh tunnel for the ssh-tunnel route", async () => {
    const closed: number[] = [];
    const p = new OrbBoxProvider(fakeExec({}).exec, {
      machine: "box", route: "ssh-tunnel", spawnTunnel: (l) => ({ close: () => closed.push(l) }),
    });
    const c = await p.connect(47800);
    expect(c.baseUrl).toBe("http://127.0.0.1:47800");
    c.close();
    expect(closed).toEqual([47800]);
  });
});
