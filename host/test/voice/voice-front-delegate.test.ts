import { describe, expect, it } from "vitest";
import { loadPrompt } from "../../prompts/index";
import { macRecipeFor, delegateText } from "../../voice/front";

// Bug 199: the voice front session (host/voice/front-session.ts, delegate-only) told the user "I can only drive
// Chrome, Edge is outside my reach" instead of delegating "in the open Edge browser navigate to YouTube" — a made-up
// limit. The full self's MacApp tool (shared/src/macapp.ts) drives any Mac app, including other browsers, through
// `open` plus ui.*. The voice must never claim something is out of reach; it delegates and lets the full self find out.

describe("the voice never claims a limit it doesn't have", () => {
  it("voice-front.md tells the voice never to say something can't be done or is out of reach", () => {
    const md = loadPrompt("voice-front.md");
    expect(md).toMatch(/never (?:say|tell the user)[^\n]*(?:can'?t be done|out of reach)/i);
    expect(md).toMatch(/delegat/i);
  });

  it("base.md says another browser or app is driven with MacApp, not just Chrome", () => {
    const base = loadPrompt("base.md");
    expect(base).toMatch(/Browser tool[^\n]*Chrome on the user's Mac/);
    expect(base).toMatch(/other browser or app[^\n]*MacApp/i);
    expect(base).toMatch(/ui\.\*/);
  });

  it("the mac-quick-actions skill's web section covers a non-Chrome browser with MacApp", () => {
    const md = loadPrompt("skills/mac-quick-actions/SKILL.md");
    expect(md).toMatch(/## The web[\s\S]*non-Chrome browser[\s\S]*MacApp/i);
    expect(md).toContain("ui.key");
    expect(md).toContain("cmd+L");
  });

  it("'open YouTube in Edge' is a Mac-shaped task: it delegates with the Mac recipes, not a made-up refusal", () => {
    const task = "in the open Edge browser navigate to YouTube";
    expect(macRecipeFor(task)).toContain("## The web");
    const t = delegateText(task);
    expect(t).toContain(`Task: ${task}`);
    expect(t).toContain("Recipes for the user's Mac");
  });
});
