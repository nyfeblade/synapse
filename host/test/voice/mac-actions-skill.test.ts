import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { messagesSend } from "@synapse/shared";
import { delegateText, macRecipeFor } from "../../voice/front";

// Bug 142: Mac actions by voice go through the delegated Bot with short recipes and NO new tool. The recipes ride
// the delegated task that needs them — not the per-turn skill catalog, which every Bot pays for on every call
// (test/perf/prompt-budget.test.ts is the ratchet on that).

const md = fs.readFileSync(path.resolve(__dirname, "../../prompts/skills/mac-quick-actions/SKILL.md"), "utf8");

describe("the Mac quick-actions recipes", () => {
  it("cover the four ways in, with one command each", () => {
    for (const h of ["## Open an app or a file", "## Send an iMessage or SMS (Messages)", "## Run a Shortcut", "## The web"]) expect(md).toContain(h);
    expect(md).toContain("open -a");
    expect(md).toContain("shortcuts run");
    expect(md).toContain("Browser tool");
  });

  it("the Messages command in the recipe is recognized as a send, with the recipient and exact text", () => {
    const cmd = /```\n\s*(osascript <<'EOF'[\s\S]*?EOF)\n/.exec(md)![1]!.replace(/^ {3}/gm, "");
    expect(messagesSend(cmd)).toEqual({ recipient: "Sam Lee", text: "I'm running 10 minutes late", service: "iMessage" });
  });

  it("ride a Mac-shaped delegated task only (nothing else pays for them)", () => {
    expect(macRecipeFor("Text Sam Lee: I'm running late")).toContain("## Send an iMessage or SMS");
    expect(macRecipeFor("Open the Calendar app")).toContain("## Open an app or a file");
    expect(macRecipeFor("Run the Morning shortcut")).toContain("## Run a Shortcut");
    expect(macRecipeFor("What did we decide about the retainer?")).toBeNull();
    expect(macRecipeFor("Summarise the last standup")).toBeNull();
  });

  it("the delegated task says what to do and how to report; the recipes come with it when they apply", () => {
    const t = delegateText("Text Sam Lee: I'm running late");
    expect(t).toContain("Task: Text Sam Lee: I'm running late");
    expect(t).toContain("SendMessage");
    expect(t).toContain("read aloud on the call");
    expect(t).toContain("Recipes for the user's Mac");
    expect(delegateText("What did we decide about the retainer?")).not.toContain("Recipes for the user's Mac");
  });
});
