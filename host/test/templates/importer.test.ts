import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { writeBotpack } from "../../templates/botpack";
import { TemplateImporter, loadStarters } from "../../templates/importer";
import { REFERENCE_NAME } from "../../../scripts/public-scan";

let root: string;
let created: { id: string; a: Record<string, unknown> }[];
let kv: Map<string, Map<string, unknown>>;
let kicked: string[];
let importer: TemplateImporter;
const manifest = {
  profile: { name: "Trip Desk", title: "Travel", description: "Plans trips end to end.", avatarShape: "puff" as const, avatarColor: "#49a393" },
  skills: [{ id: "book-flights", name: "book-flights", description: "Books flights" }],
  memories: ["Prefer aisle seats when booking."],
  routines: [{ name: "Fare watch", prompt: "Check fares", schedule: "0 9 * * *" }],
  plugins: [{ catalogId: "curated:linear", name: "Linear" }, { catalogId: "curated:notion", name: "Notion" }],
};
const pack = (author: string) => Buffer.from(writeBotpack({
  template: { id: "5d0e6c0a-8b1f-4c1e-9a2b-3c4d5e6f7a8b", name: "Trip Desk", author: { name: author }, sourceBotId: null, visibility: "local", createdAt: 1, updatedAt: 1, manifest },
  skills: { "book-flights": { "SKILL.md": new TextEncoder().encode("---\nname: book-flights\ndescription: Books flights\n---\nSteps\n") } },
  memoriesMd: "- (2026-09-01) Prefer aisle seats when booking.\n", avatar: null,
})).toString("base64");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
  created = []; kv = new Map(); kicked = [];
  const cfg = { dataRoot: path.join(root, "agent-data"), claudeConfigDir: path.join(root, "claude"), workspace: path.join(root, "ws") } as never;
  const bots = {
    create: (a: Record<string, unknown>) => { const id = `bot-${created.length + 1}`; created.push({ id, a }); kv.set(id, new Map()); fs.mkdirSync(path.join(root, "agent-data", "agents", id), { recursive: true }); return id; },
    require: (id: string) => ({ store: { getKv: (k: string, fb: unknown) => kv.get(id)?.get(k) ?? fb, setKv: (k: string, v: unknown) => kv.get(id)!.set(k, v) } }),
    ids: () => [...kv.keys()],
  } as never;
  const packager = { list: () => [], templatesDir: path.join(root, "agent-data", "templates") } as never;
  importer = new TemplateImporter({ cfg, bots, packager, starters: loadStarters(), installedCatalogIds: () => new Set(["curated:linear"]), kickstart: (id) => kicked.push(id), selfName: () => "Alex", now: () => Date.UTC(2026, 8, 19) });
});

describe("starter templates (TPL-03)", () => {
  it("ships 20 well-formed starters", () => {
    const s = loadStarters();
    expect(s).toHaveLength(20);
    expect(new Set(s.map((x) => x.id)).size).toBe(20);
    for (const x of s) {
      expect(x.name.length).toBeGreaterThan(2);
      expect(x.description.length).toBeGreaterThan(60);
      expect(x.tools.length).toBeGreaterThan(0);
      expect(x.description).not.toMatch(REFERENCE_NAME);
      expect(x.description).not.toMatch(/Claude Code/);
    }
    expect(s.map((x) => x.name)).toEqual(expect.arrayContaining(["Chief of Staff", "Inbox Triage", "Night Shift", "Feedback Miner"]));
  });
});

describe("TemplateImporter (TPL-02)", () => {
  it("previews a third-party .botpack with the four sections and Needs connecting", () => {
    const p = importer.preview({ bytesBase64: pack("Ana") });
    expect(p).toMatchObject({ name: "Trip Desk", thirdParty: true, facts: ["Prefer aisle seats when booking."], playbooks: ["book-flights"], jobs: ["Fare watch"], author: { name: "Ana" } });
    expect(p.apps).toEqual([{ name: "Linear", needsConnecting: false }, { name: "Notion", needsConnecting: true }]);
    // P5 review I9: a file is third-party by origin, even when it claims the user's own name.
    expect(importer.preview({ bytesBase64: pack("Alex") }).thirdParty).toBe(true);
  });

  it("Add Bot creates a distinct copy: memories, skills, disabled routines, sourceTemplateId, kickstart", () => {
    const { token } = importer.preview({ bytesBase64: pack("Ana") });
    const { id } = importer.import(token);
    expect(created[0]!.a).toMatchObject({ name: "Trip Desk", title: "Travel", description: "Plans trips end to end.", origin: "user", kickstart: true });
    expect(kv.get(id)!.get("sourceTemplateId")).toBe("tpl:5d0e6c0a-8b1f-4c1e-9a2b-3c4d5e6f7a8b");
    const bot = path.join(root, "agent-data", "agents", id);
    expect(fs.readFileSync(path.join(bot, "memory", "profile.md"), "utf8")).toContain("- (2026-09-19) Prefer aisle seats when booking.");
    const routineDir = fs.readdirSync(path.join(bot, "automations"))[0]!;
    expect(JSON.parse(fs.readFileSync(path.join(bot, "automations", routineDir, "automation.json"), "utf8"))).toMatchObject({ name: "Fare watch", enabled: false, schedule: "0 9 * * *" });
    expect(fs.readFileSync(path.join(root, "claude", "skills", "trip-desk--book-flights", "SKILL.md"), "utf8")).toContain("source: template:Trip Desk");
    expect(kicked).toEqual([id]);
    expect(() => importer.import(token)).toThrow(/expired/);
  });

  it("starters preview without a third-party warning, and show Added while a Bot made from them exists (TPL-04)", () => {
    const { token } = importer.preview({ starterId: "starter:chief-of-staff" });
    expect(importer.list().find((x) => x.id === "starter:chief-of-staff")).toMatchObject({ added: false, author: { name: "Synapse Team" } });
    importer.import(token);
    expect(importer.list().find((x) => x.id === "starter:chief-of-staff")).toMatchObject({ added: true });
    expect(importer.preview({ starterId: "starter:inbox-triage" }).thirdParty).toBe(false);
  });
});
