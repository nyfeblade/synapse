// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originFrom } from "../../src/renderer/pop-origin";

// "Ultra liquid" (decisions.md): every popover and menu GROWS OUT OF the element that opened it. The
// transform-origin of its pop-in is the point of the trigger nearest the popover, in the popover's
// own coordinates, so the scale visibly starts at the trigger.

describe("originFrom", () => {
  it("a popover below its trigger grows from the trigger's bottom-centre", () => {
    expect(originFrom(new DOMRect(100, 50, 80, 30), new DOMRect(90, 86, 200, 120))).toBe("50px 0px");
  });
  it("a popover above its trigger grows from the trigger's top-centre", () => {
    expect(originFrom(new DOMRect(100, 300, 80, 30), new DOMRect(60, 180, 200, 120))).toBe("80px 120px");
  });
  it("a menu opened at a pointer grows from that point", () => {
    expect(originFrom({ x: 140, y: 210 }, new DOMRect(130, 200, 180, 90))).toBe("10px 10px");
  });
  it("clamps to the popover's box, so an off-box trigger still grows from its nearest edge", () => {
    expect(originFrom(new DOMRect(0, 0, 10, 10), new DOMRect(100, 100, 50, 50))).toBe("0px 0px");
  });
});

describe("every popover in the renderer grows from its trigger", () => {
  // A component that renders a menu or a listbox popover must either go through Menus.tsx (origin =
  // the anchor point) or call usePopOrigin. The exceptions are not popovers from a trigger: the
  // palette's results ARE the palette; NewChat's recipient list is inline; the mention and skill
  // pickers open upward out of the composer they belong to (app.css: transform-origin 50% 100%).
  const INLINE_OR_COMPOSER = new Set(["CommandPalette.tsx", "NewChat.tsx", "MentionPicker.tsx", "SkillPicker.tsx", "Menus.tsx"]);
  const dir = join(__dirname, "../../src/renderer/components");
  it("uses Menu or usePopOrigin wherever a role=menu/listbox popover is rendered", () => {
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".tsx") && !INLINE_OR_COMPOSER.has(f)).filter((f) => {
      const src = readFileSync(join(dir, f), "utf8");
      return /role="(menu|listbox)"/.test(src) && !/usePopOrigin\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
