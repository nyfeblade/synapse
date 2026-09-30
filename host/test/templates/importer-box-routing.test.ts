import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeBotpack } from "../../templates/botpack";
import { tmpConfig } from "../helpers";

// Controller ruling: templates/importer.ts writes brand-new skill directories straight into the
// box-writable ~/.claude/skills the same way SkillLibrary.write()/writeHelper() used to -- it must
// route through the same root-owned helpers instead, and preserve the "never overwrite" guarantee
// the old `{ flag: "wx" }` fs.writeFileSync gave it by using the no-clobber variants.
vi.mock("../../skills/skill-box-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/skill-box-ops")>();
  return { ...actual, writeSkillFileNoClobber: vi.fn(), writeSkillHelperFileNoClobber: vi.fn() };
});

const { writeSkillFileNoClobber, writeSkillHelperFileNoClobber } = await import("../../skills/skill-box-ops");
const { TemplateImporter, loadStarters } = await import("../../templates/importer");

const manifest = {
  profile: { name: "Trip Desk", title: "Travel", description: "Plans trips end to end.", avatarShape: "puff" as const, avatarColor: "#49a393" },
  skills: [{ id: "book-flights", name: "book-flights", description: "Books flights" }],
  memories: [] as string[],
  routines: [] as { name: string; prompt: string; schedule: string | null }[],
  plugins: [] as { catalogId: string; name: string }[],
};
// readBotpack only keeps .md files under skills/<id>/ (host/templates/botpack.ts), so a skill's
// "non-SKILL.md helper file" is itself always a .md file in practice (e.g. a reference doc), never
// an arbitrary script — a script inside a botpack is silently dropped on round-trip.
const pack = () => Buffer.from(writeBotpack({
  template: { id: "5d0e6c0a-8b1f-4c1e-9a2b-3c4d5e6f7a8b", name: "Trip Desk", author: { name: "Ana" }, sourceBotId: null, visibility: "local", createdAt: 1, updatedAt: 1, manifest },
  skills: { "book-flights": { "SKILL.md": new TextEncoder().encode("---\nname: book-flights\ndescription: Books flights\n---\nSteps\n"), "notes.md": new TextEncoder().encode("# Notes\nExtra reference.\n") } },
  memoriesMd: "", avatar: null,
})).toString("base64");

function setup(brain: "claude" | "fake" = "claude") {
  const cfg = tmpConfig({ BRAIN: brain });
  const created: { id: string }[] = [];
  const kv = new Map<string, Map<string, unknown>>();
  const bots = {
    create: () => { const id = `bot-${created.length + 1}`; created.push({ id }); kv.set(id, new Map()); fs.mkdirSync(path.join(cfg.dataRoot, "agents", id), { recursive: true }); return id; },
    require: (id: string) => ({ store: { getKv: (k: string, fb: unknown) => kv.get(id)?.get(k) ?? fb, setKv: (k: string, v: unknown) => kv.get(id)!.set(k, v) } }),
    ids: () => [...kv.keys()],
  } as never;
  const packager = { list: () => [], templatesDir: path.join(cfg.dataRoot, "templates") } as never;
  const importer = new TemplateImporter({ cfg, bots, packager, starters: loadStarters(), installedCatalogIds: () => new Set(), kickstart: () => {}, selfName: () => null, now: () => Date.UTC(2026, 8, 19) });
  return { cfg, importer };
}

describe("TemplateImporter routes skill files through the no-clobber box helpers when cfg.brain === 'claude'", () => {
  it("writes SKILL.md and a helper file via writeSkillFileNoClobber/writeSkillHelperFileNoClobber, never fs.writeFileSync under the skills tree", () => {
    const { cfg, importer } = setup("claude");
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const { token } = importer.preview({ bytesBase64: pack() });
    importer.import(token);

    expect(writeSkillFileNoClobber).toHaveBeenCalledTimes(1);
    const [id, content] = vi.mocked(writeSkillFileNoClobber).mock.calls[0]!;
    expect(id).toBe("trip-desk-book-flights");
    expect(content).toContain("source: template:Trip Desk");

    expect(writeSkillHelperFileNoClobber).toHaveBeenCalledTimes(1);
    expect(writeSkillHelperFileNoClobber).toHaveBeenCalledWith(id, "notes.md", "# Notes\nExtra reference.\n");

    const skillsRoot = path.join(cfg.claudeConfigDir, "skills");
    const skillWrites = writeFile.mock.calls.filter(([p]) => String(p).startsWith(skillsRoot));
    expect(skillWrites).toEqual([]);
  });

  it("still picks a fresh directory name on a collision (a pre-existing 'trip-desk-book-flights') before ever writing", () => {
    const { cfg, importer } = setup("claude");
    fs.mkdirSync(path.join(cfg.claudeConfigDir, "skills", "trip-desk-book-flights"), { recursive: true });
    const { token } = importer.preview({ bytesBase64: pack() });
    importer.import(token);
    const [id] = vi.mocked(writeSkillFileNoClobber).mock.calls[0]!;
    expect(id).toBe("trip-desk-book-flights-2");
  });
});

describe("TemplateImporter symlink safety (controller ruling: never follow a Bot-controlled symlink as bothost)", () => {
  it("a symlinked skills root never gets written through, with the real box helper (cfg.brain === 'claude')", () => {
    const { cfg, importer } = setup("claude");
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "importer-hostprivate-"));
    fs.writeFileSync(path.join(hp, "vault.key"), "SECRET");
    fs.mkdirSync(cfg.claudeConfigDir, { recursive: true });
    fs.rmSync(path.join(cfg.claudeConfigDir, "skills"), { recursive: true, force: true });
    fs.symlinkSync(hp, path.join(cfg.claudeConfigDir, "skills"));

    const { token } = importer.preview({ bytesBase64: pack() });
    importer.import(token); // writeSkillFileNoClobber/writeSkillHelperFileNoClobber are mocked, so the
    // real root-owned helper never runs here; this proves TemplateImporter itself never touches fs
    // directly under the (symlinked) skills tree, only ever through the injected/mocked box ops.
    expect(fs.readdirSync(hp)).toEqual(["vault.key"]);
    expect(fs.readFileSync(path.join(hp, "vault.key"), "utf8")).toBe("SECRET");
  });
});
