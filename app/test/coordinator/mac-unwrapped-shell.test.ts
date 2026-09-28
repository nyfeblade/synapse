/**
 * mac-unwrapped-shell (bug 234, review of bug 233): an unwrapped run must not pick up anything a sandboxed Bot could
 * have planted — a poisoned PATH entry or a function in a shell startup file.
 *  (a) `open <http(s) URL>` spawns /usr/bin/open directly with the URLs (no shell, no PATH).
 *  (b) Approved hand-offs and exempt one-shots run `/bin/zsh -f` (no startup files) with PATH=/usr/bin:/bin:/usr/sbin:
 *      /sbin plus only the exempt tool's own resolved directory; the card names the resolved binary.
 *  (c) The sandbox denies writes to shell startup files (so a Bot can't plant code the user's Terminal runs later);
 *      a plain edit of one is a hand-off, and its approved card runs it unwrapped.
 *  Minor: shortcuts and automator always ask.
 * HOME points at a temp dir for every test: the user's real startup files are never read or written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor, SYSTEM_OPEN, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

let home: string;
let userData: string;
let bin: string;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mus-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  bin = path.join(home, "poison-bin");
  fs.mkdirSync(bin);
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const script = (p: string, body: string) => fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const exec = (o: { openBinary?: string } = {}) => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, ...o });
async function sh(ex: LocalExecutor, command: string, approvalId: string | null = null): Promise<string> {
  const chunks: string[] = [];
  await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return chunks.join("");
}

describe("minor: shortcuts and automator always ask", () => {
  it.each(["shortcuts run 'Do Thing'", "shortcuts list", "/usr/bin/shortcuts run X -i in.txt", "automator job.workflow", "/usr/bin/automator -i x w.workflow", "open My.workflow"])(
    "%s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull());
});

describe("(c) startup files: a write is a hand-off", () => {
  it.each([
    "echo 'alias x=y' >> ~/.zshrc", "printf x > ~/.zshenv", "cp evil ~/.zprofile", "tee -a ~/.bashrc < x", "sed -i '' s/a/b/ ~/.profile",
    "echo x > ~/.config/fish/config.fish", "echo x > ~/.ssh/rc", `python3 -c "open('/x/.zshrc','a').write('x')"`,
  ])("%s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull());
  it("the profile denies writes to each (both spellings, escaped)", () => {
    const p = ownDataSandboxProfile(userData, home);
    for (const f of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bash_profile", ".bashrc", ".profile", ".ssh/rc"]) expect(p).toContain(`(literal "${home}/${f}")`);
    expect(p).toContain(`(subpath "${home}/.config/fish")`);
    for (const b of ["/usr/bin/shortcuts", "/usr/bin/automator"]) expect(p).toContain(`(literal "${b}")`);
  });
});

describe("the card names the resolved binary", () => {
  it("swift → <its resolved path>", () => {
    script(path.join(bin, "swift"), "echo FAKE");
    process.env.PATH = `${bin}:${saved.PATH}`;
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 1), { home: () => home, userData: () => userData });
    p.setBotMode("b1", "full-auto");
    const v = p.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: "swift build", cwd: home });
    expect(v.ok).toBe(false);
    const reason = (v as { reason: string }).reason;
    expect(reason.startsWith(LOCAL_NEEDS_APPROVAL)).toBe(true);
    expect(reason).toContain(`swift → ${path.join(bin, "swift")}`);
  });
});

describe.runIf(process.platform === "darwin")("live (HOME is a temp dir)", () => {
  it("(a) a poisoned PATH `open` is never run: the URL goes straight to the open binary, no shell", async () => {
    script(path.join(bin, "open"), `echo POISONED > "${home}/poison.txt"`);
    process.env.PATH = `${bin}:${saved.PATH}`;
    fs.writeFileSync(path.join(home, ".zshenv"), `open() { echo POISONED-FN > "${home}/poison-fn.txt"; }\n`);
    const recorder = path.join(home, "recorder");
    script(recorder, `echo "$@" > "${home}/opened.txt"`);
    await sh(exec({ openBinary: recorder }), "open https://example.invalid/a");
    expect(fs.readFileSync(path.join(home, "opened.txt"), "utf8").trim()).toBe("https://example.invalid/a");
    expect(fs.existsSync(path.join(home, "poison.txt"))).toBe(false);
    expect(fs.existsSync(path.join(home, "poison-fn.txt"))).toBe(false);
    expect(SYSTEM_OPEN).toBe("/usr/bin/open");
  });

  it("(b) an approved hand-off doesn't source a .zshenv/.zprofile function, and gets the fixed PATH", async () => {
    for (const f of [".zshenv", ".zprofile", ".zshrc"]) fs.writeFileSync(path.join(home, f), `launchctl() { echo POISONED-${f}; }\nexport PATH="${bin}:$PATH"\n`);
    script(path.join(bin, "launchctl"), "echo POISONED-BIN");
    const out = await sh(exec(), `launchctl list >/dev/null && echo "DONE:$PATH"`, "approved");
    expect(out).not.toContain("POISONED");
    expect(out).toContain("DONE:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("(b) an exempt one-shot runs the resolved tool with the fixed PATH, no startup files", async () => {
    const tools = path.join(home, "tools");
    fs.mkdirSync(tools);
    script(path.join(tools, "swift"), `echo "REAL-SWIFT PATH=$PATH"`);
    process.env.PATH = `${tools}:${saved.PATH}`;
    fs.writeFileSync(path.join(home, ".zshenv"), `swift() { echo POISONED-FN; }\n`);
    const out = await sh(exec(), "swift build");
    expect(out).not.toContain("POISONED");
    expect(out).toContain("REAL-SWIFT PATH=/usr/bin:/bin:/usr/sbin:/sbin\n"); // bug 235: the fixed PATH only (a /bin/sh script adds no interpreter dir)
  });

  it("(c) under the wrapper, python can't write a startup file (direct or by rename)", async () => {
    fs.mkdirSync(path.join(home, ".config", "fish"), { recursive: true });
    fs.mkdirSync(path.join(home, ".ssh"));
    const targets = [".zshrc", ".zshenv", ".bash_profile", ".config/fish/config.fish", ".ssh/rc"];
    for (const t of targets) {
      const f = path.join(home, t);
      await sh(exec(), `python3 -c "open('${f}','a').write('echo PLANTED\\n')" 2>&1; python3 -c "import os; open('${home}/tmp.x','w').write('echo PLANTED'); os.replace('${home}/tmp.x','${f}')" 2>&1`);
      expect(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", t).not.toContain("PLANTED");
    }
  });

  it("(c) an approved edit of a startup file runs unwrapped for that call; without approval it is denied", async () => {
    const f = path.join(home, ".zshrc");
    fs.writeFileSync(f, "# mine\n");
    await sh(exec(), `echo 'alias ll="ls -l"' >> ${f}`);
    expect(fs.readFileSync(f, "utf8")).not.toContain("alias ll");
    await sh(exec(), `echo 'alias ll="ls -l"' >> ${f}`, "approved");
    expect(fs.readFileSync(f, "utf8")).toContain("alias ll");
  });
});
