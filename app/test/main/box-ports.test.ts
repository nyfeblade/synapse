import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { helloMessage, userPorts, WRONG_HOST_MESSAGE } from "@synapse/shared";

// Two macOS accounts on one Mac: the box scripts compute and apply each Mac user's own ports (shared/src/user-ports.ts).
// Nothing here runs orb: ORB points at a fake, and the in-box step runs against a temp root with fake systemctl/nft.
const box = path.resolve(__dirname, "../../../box");
const read = (f: string) => fs.readFileSync(path.join(box, f), "utf8");
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "box-ports-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const sh = (script: string, env: Record<string, string> = {}, input?: string) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8", input, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ORB: "/usr/bin/false", ...env } });

describe("box/orb.sh: this Mac user's ports", () => {
  it.each([501, 502, 503, 626, 627, 1000, 0])("uid %i gets the same ports as the app computes", (uid) => {
    const r = sh(`source '${box}/orb.sh'; echo "$SYNAPSE_GATEWAY_PORT $SYNAPSE_WEBHOOK_PORT $SYNAPSE_AUTH_PROXY_PORT"`, { SYNAPSE_UID: String(uid) });
    expect(r.status, r.stderr).toBe(0);
    const p = userPorts(uid);
    expect(r.stdout.trim()).toBe(`${p.gateway} ${p.webhook} ${p.authProxy}`);
  });

  it("ports the app passes win over the computed ones", () => {
    const r = sh(`source '${box}/orb.sh'; echo "$SYNAPSE_GATEWAY_PORT $SYNAPSE_WEBHOOK_PORT $SYNAPSE_AUTH_PROXY_PORT"`,
      { SYNAPSE_UID: "501", SYNAPSE_GATEWAY_PORT: "48000", SYNAPSE_WEBHOOK_PORT: "48001", SYNAPSE_AUTH_PROXY_PORT: "48002" });
    expect(r.stdout.trim()).toBe("48000 48001 48002");
  });
});

// The in-box step is one script, box/files/bots-ports: deploy streams it (`apply`), provision installs it, and the
// auth proxy's firewall service runs it at every boot (`load`), so the loaded rule always follows the drop-in's port.
describe("box/files/bots-ports: the host's ports and the auth proxy's firewall rule", () => {
  const DROPIN = "etc/systemd/system/bothost.service.d/20-ports.conf";
  /** layout "old": a box provisioned before this change (only the rendered rule); "new": the shipped template too. */
  const root = (layout: "old" | "new" = "new") => {
    const r = tmp();
    fs.mkdirSync(path.join(r, "etc/bots"), { recursive: true });
    fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft"));
    if (layout === "new") fs.copyFileSync(path.join(box, "files/bots-auth-proxy.nft"), path.join(r, "etc/bots/auth-proxy.nft.in"));
    return r;
  };
  const run = (r: string, args: string[], o: { nftFails?: boolean } = {}) => {
    const log = path.join(r, "calls.log");
    const res = spawnSync("bash", [path.join(box, "files/bots-ports"), ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, R: r, SYSTEMCTL: `echo systemctl >> '${log}'; true`, NFT: o.nftFails ? `echo nft >> '${log}'; false` : `echo nft >> '${log}'; true` },
    });
    return { ...res, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const rule = (r: string) => fs.readFileSync(path.join(r, "etc/bots/auth-proxy.nft"), "utf8");

  it.each(["old", "new"] as const)("apply (%s box): the rule moves with the proxy port and loads BEFORE the host's drop-in is written", (layout) => {
    const r = root(layout);
    const res = run(r, ["apply", "47900", "47901", "47902"]);
    expect(res.status, res.stderr).toBe(0);
    const dropin = fs.readFileSync(path.join(r, DROPIN), "utf8");
    expect(dropin).toContain("Environment=HOST_PORT=47900");
    expect(dropin).toContain("Environment=WEBHOOK_PORT=47901");
    expect(dropin).toContain("Environment=SYNAPSE_AUTH_PROXY_PORT=47902");
    // The old port stays covered too, so a host still on it before its restart is never left open.
    expect(rule(r)).toContain("tcp dport { 47802, 47902 } meta skuid");
    expect(rule(r)).toMatch(/ip6 daddr ::1 tcp dport \{ 47802, 47902 \} counter reject/);
    expect(res.calls).toEqual(["nft", "systemctl"]);
  });

  it("a rule that fails to load never moves the host: no drop-in is written", () => {
    const r = root();
    const res = run(r, ["apply", "47900", "47901", "47902"], { nftFails: true });
    expect(res.status).not.toBe(0);
    expect(fs.existsSync(path.join(r, DROPIN))).toBe(false);
  });

  it("every run loads the rule and reloads systemd, even when the files already say so (a failed load before is fixed)", () => {
    const r = root();
    run(r, ["apply", "47900", "47901", "47902"], { nftFails: true });
    fs.rmSync(path.join(r, "calls.log"));
    expect(run(r, ["apply", "47900", "47901", "47902"]).calls).toEqual(["nft", "systemctl"]);
    fs.rmSync(path.join(r, "calls.log"));
    expect(run(r, ["apply", "47900", "47901", "47902"]).calls).toEqual(["nft", "systemctl"]);
  });

  it("a missing firewall rule fails loudly instead of moving the host unguarded", () => {
    const r = tmp();
    const res = run(r, ["apply", "47900", "47901", "47902"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/firewall rule is missing/);
    expect(fs.existsSync(path.join(r, DROPIN))).toBe(false);
  });

  it("load (every boot, and provision): renders the rule for the drop-in's port and loads it", () => {
    const r = root();
    fs.mkdirSync(path.dirname(path.join(r, DROPIN)), { recursive: true });
    fs.writeFileSync(path.join(r, DROPIN), "[Service]\nEnvironment=HOST_PORT=47910\nEnvironment=WEBHOOK_PORT=47911\nEnvironment=SYNAPSE_AUTH_PROXY_PORT=47912\n");
    const res = run(r, ["load"]);
    expect(res.status, res.stderr).toBe(0);
    expect(rule(r)).toContain("tcp dport { 47802, 47912 } meta skuid");
    expect(res.calls).toEqual(["nft"]);
  });

  it("load with no drop-in (the account on 47800, or a box before its first deploy) is the shipped rule byte for byte", () => {
    const r = root();
    fs.writeFileSync(path.join(r, "etc/bots/auth-proxy.nft"), "stale");
    expect(run(r, ["load"]).status).toBe(0);
    expect(rule(r)).toBe(read("files/bots-auth-proxy.nft"));
    const r2 = root();
    run(r2, ["apply", "47800", "47801", "47802"]);
    expect(rule(r2)).toBe(read("files/bots-auth-proxy.nft"));
  });

  it("refuses a port that isn't a number", () => {
    expect(run(root(), ["apply", "47900", "x;rm", "47902"]).status).not.toBe(0);
  });

  it("orb.sh streams this same script to the box", () => {
    const r = sh(`source '${box}/orb.sh'; box_ports_script`);
    expect(r.stdout).toBe(read("files/bots-ports"));
    expect(sh(`source '${box}/orb.sh'; type box_apply_ports`).stdout).toMatch(/bash -s -- apply/);
  });
});

describe("provision installs the rule from the drop-in's port, and a reboot keeps it", () => {
  const prov = read("provision.sh");
  it("provision.sh installs the shipped rule as the template and renders it with bots-ports load", () => {
    expect(prov).toContain('"$HERE/files/bots-auth-proxy.nft" /etc/bots/auth-proxy.nft.in');
    expect(prov).not.toMatch(/"\$HERE\/files\/bots-auth-proxy\.nft" \/etc\/bots\/auth-proxy\.nft\s*$/m);
    expect(prov).toMatch(/install -m 0755 -o root -g root "\$HERE\/files\/bots-ports" \/usr\/local\/lib\/bots\/bots-ports\n\/usr\/local\/lib\/bots\/bots-ports load/);
  });
  it("the firewall service loads the rule through bots-ports at every boot", () => {
    expect(read("files/bots-auth-proxy.service")).toContain("ExecStart=/usr/local/lib/bots/bots-ports load");
  });
});

describe("the box scripts pass the ports at provision and deploy time", () => {
  it("deploy.sh applies them before it restarts the host", () => {
    const d = read("deploy.sh");
    expect(d).toMatch(/box_apply_ports[\s\S]*systemctl restart bothost/);
  });
  it("provision-from-mac.sh applies them after provision.sh (which reinstalls the shipped firewall rule)", () => {
    expect(read("provision-from-mac.sh")).toMatch(/provision\.sh[\s\S]*box_apply_ports/);
  });
  it("verify-box.sh checks the auth proxy on this user's port", () => {
    const v = read("verify-box.sh");
    expect(v).toContain("$SYNAPSE_AUTH_PROXY_PORT");
    expect(v).not.toMatch(/127\.0\.0\.1:47802/);
  });
});

describe("check-gateway.sh (deploy's last step)", () => {
  const run = (info: string, curlCode: string) => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "orb"), `#!/bin/sh\necho '${info}'\n`, { mode: 0o755 });
    // Like curl: -w prints the status; -sf fails (22) on anything but 2xx.
    fs.writeFileSync(path.join(d, "curl"), `#!/bin/sh\ncase "$*" in *"-K -"*) cat >/dev/null;; esac\ncase "$*" in *http_code*) echo ${curlCode}; exit 0;; esac\n[ ${curlCode} = 200 ] && { echo '{"ok":true}'; exit 0; }\nexit 22\n`, { mode: 0o755 });
    return spawnSync("bash", [path.join(box, "check-gateway.sh")], {
      encoding: "utf8",
      env: { PATH: `${d}:${process.env.PATH}`, HOME: process.env.HOME!, ORB: path.join(d, "orb"), BOX_MACHINE: "synapse-box", SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_CHECK_TRIES: "2" },
    });
  };
  it("a port answered by another account's host fails plainly instead of passing or timing out", () => {
    const r = run('{"port":47900,"token":"t"}', "401");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(WRONG_HOST_MESSAGE);
  });
  // Final review: right after a restart the script sent the token to whatever answered the port. With `hello: 1` in
  // gateway.json it now checks the host's /hello proof (HMAC-SHA256 of its nonce, keyed with the token) first.
  const helloRun = (hostKey: string) => {
    const d = tmp();
    const log = path.join(d, "curl.log");
    fs.writeFileSync(path.join(d, "orb"), `#!/bin/sh\necho '{"port":47900,"token":"tok","hello":1}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(d, "curl"), [
      "#!/bin/bash", `echo "$*" >> '${log}'`,
      `case "$*" in *"-K -"*) cat >> '${log}.stdin';; esac`,
      'for a in "$@"; do case "$a" in *"/hello?nonce="*) n="${a##*nonce=}"; p="$(printf \'synapse-hello:%s\' "$n" | openssl dgst -sha256 -hmac \'' + hostKey + '\' | awk \'{print $NF}\')"; echo "{\\"ok\\":true,\\"proof\\":\\"$p\\"}"; exit 0;; esac; done',
      'case "$*" in *Origin*) echo 403; exit 0;; *http_code*) echo 200; exit 0;; esac',
      "echo '{\"ok\":true}'",
    ].join("\n") + "\n", { mode: 0o755 });
    const r = spawnSync("bash", [path.join(box, "check-gateway.sh")], {
      encoding: "utf8",
      env: { PATH: `${d}:${process.env.PATH}`, HOME: process.env.HOME!, ORB: path.join(d, "orb"), BOX_MACHINE: "synapse-box", SYNAPSE_GATEWAY_PORT: "47900", SYNAPSE_CHECK_TRIES: "2" },
    });
    return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [], stdin: fs.existsSync(`${log}.stdin`) ? fs.readFileSync(`${log}.stdin`, "utf8") : "" };
  };
  it("a host that answers /hello proves itself before the token is sent", () => {
    const r = helloRun("tok");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PASS gateway /health");
    expect(r.calls[0]).toMatch(/\/hello\?nonce=[0-9a-f]{32}/);
    expect(r.calls[0]).not.toMatch(/Authorization/);
    // The token goes to curl on stdin, never in its arguments.
    expect(r.calls.some((c) => /tok/.test(c.replace(/nonce=[0-9a-f]+/, "")))).toBe(false);
    expect(r.stdin).toContain('header = "Authorization: Bearer tok"');
  });
  it("a wrong proof is another account's host, and the token is never sent", () => {
    const r = helloRun("someone-elses");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(WRONG_HOST_MESSAGE);
    expect(r.calls.some((c) => /Authorization/.test(c))).toBe(false);
    expect(r.stdin).toBe("");
  });
  it("waits for the host to come up on this user's port, not a stale gateway.json", () => {
    const r = run('{"port":47800,"token":"t"}', "200");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/47900/);
  });
});

// Re-review: check-gateway.sh runs on the Mac (deploy.sh calls it there; curl and openssl are Mac processes), and
// another macOS account can read any process's arguments with ps. So the host token never goes into an external
// command's arguments: curl gets its Authorization header on stdin (-K -), and the /hello HMAC is computed from the
// token held in a shell variable (orb.sh synapse_hello_hmac), with only the data piped to openssl.
describe("the host token never appears in a process's arguments", () => {
  const scripts = { "check-gateway.sh": read("check-gateway.sh"), "orb.sh": read("orb.sh") };
  it("every line that uses the token passes it only to printf (a builtin) or the HMAC shell function", () => {
    const bad: string[] = [];
    for (const [name, src] of Object.entries(scripts)) {
      src.split("\n").forEach((line, i) => {
        if (/^\s*#/.test(line) || !/\$\{?(TOKEN|key)\b/.test(line) || /^\s*TOKEN="\$\(printf '%s' "\$INFO" \| plutil/.test(line)) return;
        const segs = line.split(/\|(?!\|)|\$\(|;|&&/).filter((seg) => /\$\{?(TOKEN|key)\b/.test(seg));
        for (const seg of segs) {
          const cmd = seg.trim().replace(/^[a-z_]+\(\)\s*/, "").replace(/^[{(]\s*/, "").replace(/^(local|if|then|elif|!)\s+/, "");
          if (!/^(printf|synapse_hello_hmac|local\s|[a-z_]+=|\[)/.test(cmd)) bad.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it.each([64, 32, 100])("synapse_hello_hmac matches the host's HMAC for a %i-character token", (len) => {
    const token = "ab12".repeat(40).slice(0, len);
    const nonce = "0123456789abcdef0123456789abcdef";
    const r = sh(`source '${box}/orb.sh'; TOKEN='${token}'; synapse_hello_hmac '${nonce}'`, { SYNAPSE_UID: "501" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(createHmac("sha256", token).update(helloMessage(nonce)).digest("hex"));
  });
});
