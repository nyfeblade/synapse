import { describe, expect, it } from "vitest";
import { macAutoRunEligible, macOpaque, type MacAutoRunContext } from "../src";

// Final secfix round 2, ruling A: a Mac "Always" auto-runs a call only when it is on the read-only allowlist,
// printable ASCII, free of shell syntax, and every path (and the cwd) lies inside an auto-run root the user added.
const H = "/Users/me";
const ctx = (o: Partial<MacAutoRunContext> = {}): MacAutoRunContext => ({ home: H, root: H, roots: [`${H}/Projects`], userData: `${H}/Library/Application Support/Synapse`, ...o });
const run = (command: string, cwd?: string) => ({ op: "run-command", command, ...(cwd !== undefined ? { cwd } : {}) });
const read = (p: string) => ({ op: "read-file", path: p });
const P = `${H}/Projects`;

describe("ruling A: macAutoRunEligible is an allowlist by location", () => {
  it("with no auto-run roots nothing auto-runs, not even pwd", () => {
    expect(macAutoRunEligible(run("pwd", P), ctx({ roots: [] }))).toBe(false);
    expect(macAutoRunEligible(read(`${P}/a.txt`), ctx({ roots: [] }))).toBe(false);
  });

  it("plain read-only commands inside a root auto-run", () => {
    for (const c of ["ls", "ls -la src", "cat notes/a.txt", "wc -l notes/a.txt", "head -n 5 a.txt", "pwd", "grep -n TODO src", "date", "date +%Y-%m-%d"]) {
      expect(macAutoRunEligible(run(c, P), ctx()), c).toBe(true);
    }
    expect(macAutoRunEligible(run(`cat ${P}/a.txt`, P), ctx())).toBe(true);
    expect(macAutoRunEligible(run("cat ~/Projects/a.txt", P), ctx())).toBe(true);
    expect(macAutoRunEligible(read(`${P}/a.txt`), ctx())).toBe(true);
    expect(macAutoRunEligible(read("Projects/a.txt"), ctx())).toBe(true);
    expect(macAutoRunEligible({ op: "list-directory", path: P }, ctx())).toBe(true);
    // Final secfix round 3 (ruling 3): recursive modes and find never auto-run.
    for (const c of ["grep -rn TODO src", "find . -name x"]) expect(macAutoRunEligible(run(c, P), ctx()), c).toBe(false);
  });

  it("the cwd (default: the local root) must be inside a root too", () => {
    expect(macAutoRunEligible(run("ls"), ctx())).toBe(false); // cwd defaults to ~ which is not inside ~/Projects
    expect(macAutoRunEligible(run("ls", "~/Projects"), ctx())).toBe(true);
    expect(macAutoRunEligible(run("ls", `${H}/Documents`), ctx())).toBe(false);
    expect(macAutoRunEligible(run("cat ../Documents/tax.pdf", P), ctx())).toBe(false);
    expect(macAutoRunEligible(run("cat /etc/hosts", P), ctx())).toBe(false);
    expect(macAutoRunEligible(run(`cat ${H}/ProjectsEvil/a`, P), ctx())).toBe(false);
  });

  it("the review's bypass probes all go to a card", () => {
    const root = ctx({ roots: [H] }); // even with the whole home as a root
    const probes: [string, { op: string; command?: string; path?: string; cwd?: string }][] = [
      ["U+017F long s in .ssh", run("cat ~/.ſsh/id_rsa", H)],
      ["Kelvin sign in Keychains", run("ls ~/Library/Keychains", H)],
      ["Library//Keychains", run("ls ~/Library//Keychains", H)],
      ["Library/./Keychains", run("ls ~/Library/./Keychains", H)],
      ["cwd ~/Library/ + Keychains/", run("ls Keychains/login.keychain-db", "~/Library/")],
      ["/U*/…/.s?h", run("cat /U*/me/.s?h/id_rsa", H)],
      ["$PWD/.s?h", run("cat $PWD/.s?h/id_rsa", H)],
      ["quoted \".s\"?h", run("cat \".s\"?h/id_rsa", H)],
      ["~/.aws/credentials", run("cat ~/.aws/credentials", H)],
      ["~/.netrc", run("cat ~/.netrc", H)],
      ["~/.config/gh/hosts.yml", run("cat ~/.config/gh/hosts.yml", H)],
      ["~/.docker/config.json", run("cat .docker/config.json", H)],
      ["~/.gnupg", run("ls ~/.gnupg", H)],
      ["~/.kube/config", read("~/.kube/config")],
      ["~/.zsh_history", run("cat ~/.zsh_history", H)],
      ["~/.bash_history", run("cat ~/.bash_history", H)],
      ["~/.profile", read(`${H}/.profile`)],
      ["dot-dir inside a root", run("cat .git/config", H)],
      ["LaunchAgents", run("ls ~/Library/LaunchAgents", H)],
      ["LaunchDaemons", run("ls /Library/LaunchDaemons", H)],
      ["~/Library at all", run("ls ~/Library/Mail", H)],
      ["app userData", read(`${H}/Library/Application Support/Synapse/x`)],
      ["date with a set-time argument", run("date 010112002030", H)],
      ["date with two args", run("date -u +%Y", H)],
      ["~user", run("cat ~root/x", H)],
      ["tab", run("cat\ta.txt", H)],
      ["newline", run("ls\nrm -rf ~", H)],
      ["redirect", run("cat a > b", H)],
      ["pipe", run("cat a | sh", H)],
      ["semicolon", run("ls; rm x", H)],
      ["brace", run("cat {a,b}", H)],
      ["backtick", run("cat `x`", H)],
      ["not on the list", run("rm a", H)],
      ["find -delete", run("find . -delete", H)],
      ["find -L follows links", run("find -L . -name id_rsa", H)],
      ["grep -R follows links", run("grep -R key .", H)],
      ["write op", { op: "write-file", path: `${H}/a` }],
      ["copy op", { op: "copy-to-box", path: `${H}/a` }],
      ["non-ASCII cwd", run("ls", `${H}/Pröjects`)],
    ];
    for (const [label, req] of probes) expect(macAutoRunEligible(req, root), label).toBe(false);
  });

  it("a root that is / never counts", () => {
    expect(macAutoRunEligible(run("cat /etc/hosts", "/"), ctx({ roots: ["/"] }))).toBe(false);
  });

  it("paths are folded (APFS is case-insensitive) and realpath'd when the Mac supplies realpath", () => {
    expect(macAutoRunEligible(run("cat ~/LIBRARY/keychains/x", H), ctx({ roots: [H] }))).toBe(false);
    expect(macAutoRunEligible(run("cat a.txt", `${H}/projects`), ctx())).toBe(true);
    // a symlink inside the root that points at ~/.ssh
    const realpath = (p: string) => (p.toLowerCase().startsWith(`${P}/link`.toLowerCase()) ? `${H}/.ssh${p.slice(`${P}/link`.length)}` : p);
    expect(macAutoRunEligible(run("cat link/id_rsa", P), ctx({ realpath }))).toBe(false);
    expect(macAutoRunEligible(read(`${P}/link/id_rsa`), ctx({ realpath }))).toBe(false);
    expect(macAutoRunEligible(run("cat a.txt", P), ctx({ realpath }))).toBe(true);
  });
});

describe("ruling A: macOpaque treats non-ASCII letters and quote+glob as zsh-opaque", () => {
  it("flags them", () => {
    expect(macOpaque("cat ~/.ſsh/id_rsa")).toBe(true);
    expect(macOpaque("ls ~/Library/Keychains", { command: false })).toBe(true);
    expect(macOpaque("cat \".s\"?h/id_rsa")).toBe(true);
    expect(macOpaque("cat /U*/me/.s?h/id_rsa")).toBe(true);
    expect(macOpaque("cat $PWD/.s?h/id_rsa")).toBe(true);
    expect(macOpaque("ls -la src")).toBe(false);
    expect(macOpaque("echo café")).toBe(true);
  });
});
