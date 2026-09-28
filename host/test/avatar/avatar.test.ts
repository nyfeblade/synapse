import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAvatarModule } from "../../avatar/module";
import { StubAvatarGenerator } from "../../avatar/generate";
import { sanitizeSvg } from "../../avatar/svg-sanitize";
import { GatewayError } from "../../gateway/errors";

describe("sanitizeSvg", () => {
  it("keeps flat shapes and drops scripts, handlers, links and foreign content", () => {
    const ok = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#3472d9"/><rect x="60" y="30" width="4" height="14" rx="2" fill="#fff"/></svg>');
    expect(ok).toContain("<circle");
    expect(sanitizeSvg('<svg viewBox="0 0 100 100"><circle r="4" onclick="alert(1)" fill="red"/></svg>')).not.toContain("onclick");
    expect(() => sanitizeSvg('<svg viewBox="0 0 100 100"><script>alert(1)</script></svg>')).toThrow(/not allowed/);
    expect(() => sanitizeSvg('<svg viewBox="0 0 100 100"><image href="https://x/y.png"/></svg>')).toThrow(/not allowed/);
    expect(() => sanitizeSvg('<svg viewBox="0 0 100 100"><foreignObject/></svg>')).toThrow(/not allowed/);
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"/>')).toThrow(/not allowed/);
    expect(() => sanitizeSvg("<svg><circle r='1'/></svg>")).toThrow(/viewBox/);
    expect(sanitizeSvg('<svg viewBox="0 0 100 100"><path d="M0 0" style="fill:url(https://x)"/></svg>')).not.toContain("url(");
  });
});

describe("avatar module (BOT-18)", () => {
  it("generates a preview, sets image avatars from bytes with type/size checks, and clears them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "av-"));
    fs.mkdirSync(path.join(root, "agents", "b1"), { recursive: true });
    const setImage: unknown[] = [];
    const ctx = {
      cfg: { dataRoot: root },
      bots: { summary: () => ({ id: "b1", profile: { avatarColor: "#3472d9" } }), setAvatarImage: (id: string, ext: string | null) => { setImage.push([id, ext]); return { id }; }, require: () => ({}) },
    } as never;
    const m = createAvatarModule(ctx, new StubAvatarGenerator());
    const { svg } = await m.handlers.generateAgentAvatar!({ id: "b1", prompt: "a friendly teal cloud" });
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 100 100"/);
    await m.handlers.setAgentAvatarBytes!({ id: "b1", mime: "image/svg+xml", bytesBase64: Buffer.from(svg).toString("base64") });
    expect(fs.existsSync(path.join(root, "agents", "b1", "avatar.svg"))).toBe(true);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await m.handlers.setAgentAvatarBytes!({ id: "b1", mime: "image/png", bytesBase64: png.toString("base64") });
    expect(fs.existsSync(path.join(root, "agents", "b1", "avatar.svg"))).toBe(false);
    expect(await m.handlers.getAgentAvatar!({ id: "b1" })).toEqual({ mime: "image/png", bytesBase64: png.toString("base64") });
    await expect(Promise.resolve().then(() => m.handlers.setAgentAvatarBytes!({ id: "b1", mime: "image/bmp", bytesBase64: "AA==" }))).rejects.toThrow(/PNG, JPG/);
    await expect(Promise.resolve().then(() => m.handlers.setAgentAvatarBytes!({ id: "b1", mime: "image/png", bytesBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }))).rejects.toThrow(/5 MB/);
    await m.handlers.clearAgentAvatar!({ id: "b1" });
    expect(setImage).toEqual([["b1", "svg"], ["b1", "png"], ["b1", null]]);
  });
});

describe("avatar module — Bot id validation (traversal guard)", () => {
  /** Mirrors BotService.require()/setAvatarImage(): unknown ids (including crafted `..` traversal
   *  ids, which are never in the known-Bots map) throw NOT_FOUND. */
  function makeCtx(root: string, known: Set<string>, setImage: unknown[]) {
    const requireBot = (id: string) => {
      if (!known.has(id)) throw new GatewayError("NOT_FOUND", "No such Bot", 404);
      return {};
    };
    return {
      cfg: { dataRoot: root },
      bots: {
        summary: (id: string) => { requireBot(id); return { id, profile: { avatarColor: "#3472d9" } }; },
        setAvatarImage: (id: string, ext: string | null) => { requireBot(id); setImage.push([id, ext]); return { id }; },
        require: requireBot,
      },
    } as never;
  }

  function seedOutsideFile(): { root: string; outside: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "av-"));
    fs.mkdirSync(path.join(root, "agents", "b1"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "avatar.png"), "leaked", "utf8");
    return { root, outside };
  }

  it("setAgentAvatarBytes rejects a crafted id before writing/deleting a file outside the Bot folder", async () => {
    const { root, outside } = seedOutsideFile();
    const m = createAvatarModule(makeCtx(root, new Set(["b1"]), []), new StubAvatarGenerator());
    await expect(
      Promise.resolve().then(() => m.handlers.setAgentAvatarBytes!({ id: "../outside", mime: "image/png", bytesBase64: Buffer.from("evil").toString("base64") })),
    ).rejects.toThrow(/No such Bot/);
    expect(fs.readFileSync(path.join(outside, "avatar.png"), "utf8")).toBe("leaked");
  });

  it("getAgentAvatar rejects a crafted id instead of leaking a file from outside the Bot folder", async () => {
    const { root } = seedOutsideFile();
    const m = createAvatarModule(makeCtx(root, new Set(["b1"]), []), new StubAvatarGenerator());
    await expect(Promise.resolve().then(() => m.handlers.getAgentAvatar!({ id: "../outside" }))).rejects.toThrow(/No such Bot/);
  });

  it("clearAgentAvatar rejects a crafted id before deleting a file outside the Bot folder", async () => {
    const { root, outside } = seedOutsideFile();
    const m = createAvatarModule(makeCtx(root, new Set(["b1"]), []), new StubAvatarGenerator());
    await expect(Promise.resolve().then(() => m.handlers.clearAgentAvatar!({ id: "../outside" }))).rejects.toThrow(/No such Bot/);
    expect(fs.existsSync(path.join(outside, "avatar.png"))).toBe(true);
  });
});

// Final box verification: the live helper model's SVG was refused with "declarations or entities are not allowed";
// models often annotate SVG with <!-- comments -->, which are harmless once the sanitizer rebuilds the elements.
describe("sanitizeSvg: comments are dropped, declarations still refused", () => {
  it("drops <!-- comments --> and keeps the shapes", () => {
    const out = sanitizeSvg(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><!-- main shape --><circle cx="50" cy="50" r="40" fill="#2a9d5c"/><!-- eyes\n --><rect x="60" y="30" width="4" height="14" fill="#fff"/></svg>`);
    expect(out).not.toContain("<!--");
    expect(out).toContain("<circle");
    expect(out).toContain("<rect");
  });
  it("still refuses a DOCTYPE, an ENTITY, CDATA and a comment that never closes", () => {
    for (const s of [
      `<!DOCTYPE svg><svg viewBox="0 0 1 1"></svg>`,
      `<svg viewBox="0 0 1 1"><!ENTITY x "y"></svg>`,
      `<svg viewBox="0 0 1 1"><![CDATA[x]]></svg>`,
      `<svg viewBox="0 0 1 1"><!-- open <script>alert(1)</script></svg>`,
    ]) expect(() => sanitizeSvg(s), s).toThrow(/not allowed/);
  });
});
