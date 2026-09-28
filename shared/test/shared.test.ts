import { describe, expect, it } from "vitest";
import {
  AVATAR_COLOR_NAMES, AVATAR_COLORS, AVATAR_EDITOR_SHAPES, AVATAR_MATERIALS, AVATAR_MOTIONS, DEFAULT_AVATAR_COLOR, normalizeAvatarColor, normalizeAvatarShape,
  AVATAR_SHAPE_LABELS, AVATAR_SHAPES, COMPUTER_NAME, DEFAULT_AVATAR_SHAPE, DEFAULT_BOT_MODEL, DEFAULT_EFFORT, EFFORT_LEVELS,
  HELPER_MODEL, LIMITS, MODEL_IDS, STR, activityEntryId, formatDuration, isEntryId, isEffortLevel,
  isModelId, isSafeFolderId, modelLabel, possessive, sendEntryId, spawnModelId, timeSeparator, userEntryId,
} from "../src/index";

describe("models (D4 as modified)", () => {
  it("defaults every Bot to Sonnet 5 and uses Haiku 4.5 for helpers", () => {
    expect(DEFAULT_BOT_MODEL).toBe("claude-sonnet-5");
    expect(HELPER_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(MODEL_IDS).toEqual(["claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]);
    expect(isModelId("claude-opus-5")).toBe(true);
    expect(isModelId("gpt-5")).toBe(false);
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(DEFAULT_EFFORT).toBe("high");
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(isEffortLevel("high")).toBe(true);
    expect(isEffortLevel("turbo")).toBe(false);
    expect(spawnModelId("claude-sonnet-5")).toBe("claude-sonnet-5[1m]");
    expect(spawnModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });
});

describe("avatars (BOT-17; bug 292: Synapse's own ids)", () => {
  it("has 16 shapes and 11 colors, plus materials and motion kits", () => {
    expect(AVATAR_SHAPES).toHaveLength(16);
    expect(AVATAR_SHAPES.slice(0, 8)).toEqual(["pebble", "orb", "tile", "pill", "dome", "gem", "puff", "bead"]);
    expect(AVATAR_SHAPES.slice(8)).toEqual(["hex", "diamond", "shield", "crescent", "petal", "stadium", "notch", "wave"]);
    expect(AVATAR_COLORS).toHaveLength(11);
    expect(AVATAR_COLOR_NAMES).toEqual(["White", "Gray", "Brown", "Red", "Orange", "Amber", "Green", "Teal", "Blue", "Purple", "Pink"]);
    expect(AVATAR_COLORS[0]).toBe("#ffffff");
    expect(AVATAR_COLORS[1]).toBe("#777777");
    expect(DEFAULT_AVATAR_COLOR).toBe(AVATAR_COLORS[AVATAR_COLOR_NAMES.indexOf("Blue")]);
    expect(AVATAR_MATERIALS).toEqual(["matte", "glass", "grain", "glow"]);
    expect(AVATAR_MOTIONS).toEqual(["calm", "curious", "kinetic", "stoic"]);
    for (const s of AVATAR_SHAPES) expect(AVATAR_SHAPE_LABELS[s]).toBeTruthy();
  });

  it("offers the six Synapse forms in the editor, the pebble first", () => {
    expect(AVATAR_EDITOR_SHAPES).toEqual(["pebble", "orb", "tile", "pill", "dome", "gem"]);
    expect(AVATAR_EDITOR_SHAPES.map((s) => AVATAR_SHAPE_LABELS[s])).toEqual(["Pebble", "Orb", "Tile", "Pill", "Dome", "Gem"]);
    expect(DEFAULT_AVATAR_SHAPE).toBe("pebble");
  });

  it("stored ids from before the rename still load: each old shape and colour maps to its Synapse one", () => {
    // The old ids in a shuffled order (the list as it was is retired copy, public-tree.test.ts).
    const old = ["droplet", "octagon", "circle", "capsule", "rounded-square", "cloud", "blob", "triangle"];
    expect(old.map((s) => normalizeAvatarShape(s))).toEqual(["bead", "gem", "pebble", "pill", "tile", "puff", "orb", "dome"]);
    for (const s of old) expect((AVATAR_SHAPES as readonly string[]).includes(s)).toBe(false);
    expect(normalizeAvatarShape("hex")).toBe("hex");
    expect(normalizeAvatarShape("gem")).toBe("gem");
    expect(normalizeAvatarShape("hexagon")).toBeNull();
    const oldColors: Record<string, string> = { "#7f5e3c": "Brown", "#ce383d": "Red", "#ed712e": "Orange", "#f19d38": "Amber", "#43975d": "Green", "#49a393": "Teal", "#3472d9": "Blue", "#7951d8": "Purple", "#ce3d86": "Pink" };
    for (const [hex, name] of Object.entries(oldColors)) {
      expect((AVATAR_COLORS as readonly string[]).includes(hex)).toBe(false);
      expect(normalizeAvatarColor(hex.toUpperCase())).toBe(AVATAR_COLORS[AVATAR_COLOR_NAMES.indexOf(name as never)]);
    }
    expect(normalizeAvatarColor("#FFFFFF")).toBe("#ffffff");
    expect(normalizeAvatarColor("#123456")).toBeNull();
  });
});


describe("ids (§4)", () => {
  it("accepts UUIDs and rejects unsafe folder names", () => {
    expect(isSafeFolderId("0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", " x", "x ", "a\u0000b"]) expect(isSafeFolderId(bad)).toBe(false);
  });
  it("builds entry ids that match the spec regex", () => {
    expect(userEntryId(5)).toBe("t5u");
    expect(sendEntryId(7, 2)).toBe("t7s2");
    expect(activityEntryId(7, 3)).toBe("t7a3");
    expect(activityEntryId("b", 1)).toBe("tba1");
    for (const id of ["t5u", "t5ua2", "t7a3", "t7s2", "tbs1", "tba1"]) expect(isEntryId(id)).toBe(true);
    for (const id of ["x5u", "t5", "tb", "t5s"]) expect(isEntryId(id)).toBe(false);
  });
});

describe("strings (D13-B)", () => {
  it("derives the computer name from the one product name", () => {
    expect(possessive("Bots")).toBe("Bots'");
    expect(possessive("Piper")).toBe("Piper's");
    expect(COMPUTER_NAME).toBe("Bots' computer");
    expect(STR.connStarting).toBe("Starting your computer");
    expect(STR.trayBotCrashedDetail).not.toMatch(/claude code/i);
    expect(STR.trayBotCrashedDetail).toBe("The Bot crashed 3 times in 10 minutes; retrying in 60 s.");
    expect(STR.createNamedBot("Tutor")).toBe('Create "Tutor" Bot');
    expect(STR.rulesFooter).toBe("Your rules are private to you. The built-in safety checks apply no matter what.");
    expect(STR.batchTitle("Courier", "send", 5, "emails")).toBe("Courier wants to send 5 emails");
    expect(STR.andMore(3)).toBe("and 3 more");
    const now = new Date(2026, 8, 18, 12, 0).getTime();
    expect(timeSeparator(new Date(2026, 8, 18, 7, 2).getTime(), now)).toBe("Today 7:02 AM");
    expect(timeSeparator(new Date(2026, 8, 17, 21, 43).getTime(), now)).toBe("Yesterday 9:43 PM");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m");
  });
});

describe("limits (§5)", () => {
  it("copies the spec constants", () => {
    expect(LIMITS.maxBots).toBe(50);
    expect(LIMITS.pendingApprovalsPerBot).toBe(4);
    expect(LIMITS.rulesPerList).toBe(20);
    expect(LIMITS.ruleMaxChars).toBe(1000);
    expect(LIMITS.gatewayPort).toBe(47800);
    expect(LIMITS.runWatchdogMs).toBe(120_000);
    expect(LIMITS.reviewerTimeoutMs).toBe(15_000);
    expect(LIMITS.warmIdleMs).toBe(600_000);
  });
});
