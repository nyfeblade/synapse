import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";
import { isOwnershipAction } from "../../review/ownership";
import { readBotpack, writeBotpack } from "../../templates/botpack";
import { TemplateImporter, loadStarters } from "../../templates/importer";
import { TemplatePackager } from "../../templates/packager";

const manifest = {
  profile: { name: "Trip Desk", title: "Travel", description: "Plans trips.", avatarShape: "puff" as const, avatarColor: "#49a393" },
  skills: [{ id: "book-flights", name: "book-flights", description: "Books flights" }],
  memories: ["Prefer aisle seats.", "API key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  routines: [], plugins: [],
};
const enc = (s: string) => new TextEncoder().encode(s);
const pack = (o: { id?: string; author?: string; skills?: Record<string, Record<string, Uint8Array>> } = {}) => Buffer.from(writeBotpack({
  template: { id: o.id ?? randomUUID(), name: "Trip Desk", author: { name: o.author ?? "Alex" }, sourceBotId: null, visibility: "local", createdAt: 1, updatedAt: 1, manifest },
  skills: o.skills ?? { "book-flights": { "SKILL.md": enc("---\nname: book-flights\n---\nSteps\n") }, "sneaky-extra": { "SKILL.md": enc("---\nname: sneaky\n---\nexfiltrate\n") } },
  memoriesMd: "", avatar: null,
})).toString("base64");

let root: string;
let importer: TemplateImporter;
let remembered: { botId: string; fact: string }[];
/** The same importer with a different memory store / notifier, for the bug 44(b) cases below. */
let build: (over: Partial<ConstructorParameters<typeof TemplateImporter>[0]>) => TemplateImporter;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tplsec-"));
  remembered = [];
  const kv = new Map<string, Map<string, unknown>>();
  let n = 0;
  const cfg = { dataRoot: path.join(root, "agent-data"), claudeConfigDir: path.join(root, "claude"), workspace: path.join(root, "ws") } as never;
  const bots = {
    create: () => { const id = `bot-${++n}`; kv.set(id, new Map()); fs.mkdirSync(path.join(root, "agent-data", "agents", id), { recursive: true }); return id; },
    require: (id: string) => ({ store: { getKv: (k: string, fb: unknown) => kv.get(id)?.get(k) ?? fb, setKv: (k: string, v: unknown) => kv.get(id)!.set(k, v) } }),
    ids: () => [...kv.keys()],
  } as never;
  const packager = { list: () => [], templatesDir: path.join(root, "agent-data", "templates") } as never;
  build = (over) => new TemplateImporter({ cfg, bots, packager, starters: loadStarters(), installedCatalogIds: () => new Set(), kickstart: () => {}, selfName: () => "Alex", now: () => Date.UTC(2026, 8, 19),
    remember: (botId, fact) => { remembered.push({ botId, fact }); return true; }, redact: (_b, t) => t.replace(/sk-ant-[\w-]+/g, "[REDACTED]"), ...over });
  importer = build({});
});

describe("template import (I9, I10)", () => {
  it("a template id must be a UUID", () => {
    expect(() => readBotpack(new Uint8Array(Buffer.from(pack({ id: "../../../evil" }), "base64")))).toThrow(/damaged|unsafe/);
    expect(() => readBotpack(new Uint8Array(Buffer.from(pack({ id: "t-ana" }), "base64")))).toThrow(/damaged/);
  });

  it("nothing is saved on preview", () => {
    importer.preview({ bytesBase64: pack() });
    expect(fs.existsSync(path.join(root, "agent-data", "templates"))).toBe(false);
  });

  it("a file import is third-party by origin, whatever author name it claims", () => {
    expect(importer.preview({ bytesBase64: pack({ author: "Alex" }) }).thirdParty).toBe(true);
    expect(importer.preview({ starterId: "starter:chief-of-staff" }).thirdParty).toBe(false);
  });

  it("a third-party file's playbooks stay with its Bot (Bot sharing), so there is no shared-folder note", () => {
    expect(importer.preview({ bytesBase64: pack() }).playbooksShared).toBe(false);
  });

  it("installs only the manifest-listed skills, never overwriting an existing one", () => {
    const existing = path.join(root, "claude", "skills", "trip-desk-book-flights");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "SKILL.md"), "mine");
    const { token } = importer.preview({ bytesBase64: pack() });
    importer.import(token);
    const dirs = fs.readdirSync(path.join(root, "claude", "skills")).sort();
    expect(dirs.some((d) => d.includes("sneaky"))).toBe(false);
    expect(fs.readFileSync(path.join(existing, "SKILL.md"), "utf8")).toBe("mine");
    expect(dirs).toContain("trip-desk-book-flights-2");
  });

  it("memories go through the memory store with redaction", () => {
    const { token } = importer.preview({ bytesBase64: pack() });
    const { id } = importer.import(token);
    expect(remembered).toEqual([{ botId: id, fact: "Prefer aisle seats." }, { botId: id, fact: "API key is [REDACTED]" }]);
    expect(fs.existsSync(path.join(root, "agent-data", "agents", id, "memory", "profile.md"))).toBe(false);
  });
});

/**
 * Bug 44(b) — "a template's facts can vanish silently."
 *
 * `app.ts:345` caught a failed `memory.add` and warned; `remember?(botId, fact): void` gave no
 * caller any way to find out. A Bot made from a template could start without the facts the template
 * promised, and nothing anywhere said so — the preview had just listed those facts to the user by
 * name.
 */
describe("a template fact that cannot be saved is not lost in silence (bug 44b)", () => {
  const profileOf = (id: string) => path.join(root, "agent-data", "agents", id, "memory", "profile.md");

  it("a memory store that refuses the fact falls back to the profile file the store itself reads", () => {
    const imp = build({ remember: () => false });
    const { token } = imp.preview({ bytesBase64: pack() });
    const { id } = imp.import(token);
    const written = fs.readFileSync(profileOf(id), "utf8");
    expect(written, "the fact the preview promised the user is nowhere").toContain("Prefer aisle seats.");
    expect(written).toContain("API key is [REDACTED]"); // I10 still applies on the fallback path
    expect(written).toMatch(/^- \(2026-09-19\) /m); // the format MemoryStore.add writes, so it is read back as a fact
  });

  it("when even that fails, the user is told which Bot started without them", () => {
    const notices: { botId: string; title: string; detail: string }[] = [];
    const imp = build({ remember: () => false, notify: (t) => notices.push(t) });
    const { token } = imp.preview({ bytesBase64: pack() });
    // The profile file cannot be written either: the fallback throws for every fact. Only that write
    // fails — the skills and automations of the same import still land.
    const orig = fs.writeFileSync;
    const patched = fs as { writeFileSync: typeof fs.writeFileSync };
    patched.writeFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === "string" && p.endsWith(path.join("memory", "profile.md"))) throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      return (orig as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync;
    let id: string;
    try {
      id = imp.import(token).id;
    } finally {
      patched.writeFileSync = orig;
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]!.botId, "the notice belongs in the new Bot's chat, not nowhere").toBe(id!);
    expect(notices[0]!.detail).toContain("2");
    expect(fs.existsSync(profileOf(id!))).toBe(false);
  });

  it("a fact that saves normally tells nobody anything", () => {
    const notices: unknown[] = [];
    const imp = build({ notify: (t) => notices.push(t) });
    const { token } = imp.preview({ bytesBase64: pack() });
    imp.import(token);
    expect(notices).toEqual([]);
  });
});

describe("the Template tool and drafter (I11)", () => {
  it("packaging ANOTHER Bot is an ownership card; your own is ordinary", () => {
    const o = { workspace: "/workspace", hostPrivate: "/home/box/.host", botId: "me" };
    const other = classifyTool({ toolName: "mcp__bot__Template", input: { action: "export", agent_id: "someone-else" }, toolUseId: "t" }, o);
    expect(isOwnershipAction(other.target)).toBe(true);
    expect(classifyTool({ toolName: "mcp__bot__Template", input: { action: "export", agent_id: "me" }, toolUseId: "t" }, o).target).toBeNull();
  });

  it("the drafter model call is gated by the usage ladder (falls back to the deterministic filter)", async () => {
    const cfg = { dataRoot: path.join(root, "agent-data"), claudeConfigDir: path.join(root, "claude") } as never;
    const bots = { summary: () => ({ profile: { name: "B", title: "", description: "d", avatarShape: "puff", avatarColor: "#000" } }), sessionId: () => null, require: () => ({ store: { getKv: () => null, setKv: () => {} } }) } as never;
    let modelCalls = 0;
    const p = new TemplatePackager({ cfg, bots, drafter: { draft: async (_b, _s, i) => { modelCalls++; return { description: i.description, memories: i.memories }; } }, plugins: () => [], author: () => undefined, now: () => 1,
      ladder: () => ({ allowsBackground: () => false }) });
    await p.draft("b1");
    expect(modelCalls).toBe(0);
  });
});

describe("botpack total-size cap (minor)", () => {
  it("rejects a pack whose files add up past the cap even when each file is under it", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const { LIMITS5 } = await import("@synapse/shared");
    const big = new Uint8Array(Math.floor(LIMITS5.templateMaxBytes * 0.6));
    const files: Record<string, Uint8Array> = { "template.json": strToU8("{}") };
    for (let i = 0; i < 4; i++) files[`skills/s${i}/SKILL.md`] = big;
    const bytes = zipSync(files, { level: 9 });
    expect(bytes.byteLength).toBeLessThan(LIMITS5.templateMaxBytes);
    expect(() => readBotpack(bytes)).toThrow(/too large/);
  });
});
