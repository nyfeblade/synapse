import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Motion guard (docs/motion-spec.md, Tier A).
//
// WHAT THESE ASSERTIONS ARE. CSS motion cannot be unit-tested by rendering — jsdom has no layout
// engine, runs no animations and reports no computed keyframes — so everything in THIS file is a
// CONTRACT-level assertion: it reads the stylesheets and asserts that the tokens exist, that the
// named selectors carry them, and that nothing animates a property the brief forbids. The assertions
// that genuinely exercise behaviour (the scroll gate, the `is-new` gate, the copy toast) live in
// motion-behaviour.test.tsx and drive real components.
//
// The point of the contract level is that the defects this tier fixes were all statable in CSS: five
// presence states sharing one animation, a 1.3s dot against a 2.4s shimmer, a duration drifting away
// from its curve. Those cannot come back without failing here.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first rule whose selector list contains `sel` exactly, at the top level. */
function ruleFor(src: string, sel: string): string | undefined {
  const clean = stripComments(src).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const bodies: string[] = [];
  while ((m = re.exec(clean))) {
    if (m[1]!.split(",").some((s) => s.trim() === sel)) bodies.push(m[2]!);
  }
  return bodies.length ? bodies.join(";") : undefined;
}

/** Every `@keyframes NAME { ... }` block in a stylesheet, as [name, body]. */
function keyframeBlocks(src: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push([m[1]!, m[2]!]);
  return out;
}

const SHEETS = ["app.css", "palette.css", "message-actions.css", "skills.css", "files.css", "widgets.css", "skill-picker.css", "tokens.css", "google.css", "bot-admin.css", "usage-dashboard.css"];

// The motion tokens (tokens.css). A composite duration+easing token is the whole mechanism: a
// duration can never drift away from its curve because they are one value.
const MOTION_TOKENS: [string, string][] = [
  ["--motion-tap", "120ms ease-out"],
  ["--motion-enter", "200ms cubic-bezier(0.22, 0.8, 0.32, 1)"],
  ["--motion-sheet", "340ms cubic-bezier(0.22, 0.8, 0.32, 1)"],
  ["--motion-spring", "300ms cubic-bezier(0.3, 1.3, 0.6, 1)"],
  ["--stagger", "40ms"],
  ["--loop-slow", "2.4s"],
  ["--loop-mid", "1.2s"],
  ["--loop-fast", "1.1s"],
];

describe("motion tokens (§1)", () => {
  const src = stripComments(read("tokens.css"));
  const light = src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1] ?? "";
  const mediaDark = src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const attrDark = src.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m)?.[1] ?? "";

  for (const [token, value] of MOTION_TOKENS) {
    it(`${token} is defined in :root as \`${value}\``, () => {
      const m = light.match(new RegExp(token.replace("-", "-") + ":\\s*([^;]+);"));
      expect(m, `${token} missing from the light :root block`).not.toBeNull();
      expect(m![1]!.trim()).toBe(value);
    });

    // Motion is theme-independent. Restating these in the dark blocks would be two more places for a
    // duration to drift, and interaction-states.test.ts's three-block rule covers colour only.
    it(`${token} is NOT restated in either dark block`, () => {
      expect(mediaDark, `${token} must not be themed`).not.toMatch(new RegExp(token + ":"));
      expect(attrDark, `${token} must not be themed`).not.toMatch(new RegExp(token + ":"));
    });
  }
});

describe("every transition is expressed in motion tokens (§1, §0)", () => {
  for (const file of SHEETS) {
    it(`${file} writes no bare duration in a transition`, () => {
      const decls = stripComments(read(file)).match(/transition\s*:[^;}]*/g) ?? [];
      const bare = decls.filter((d) => /\d+(\.\d+)?m?s\b/.test(d));
      expect(bare, `a transition duration outside the token set drifts from its curve — ${bare.join(" | ")}`).toEqual([]);
    });
  }

  // §0's three shipped drifts, named one at a time so a regression says which one came back.
  it("app.css folds away the .settings-block 0.3s drift", () => {
    expect(ruleFor(read("app.css"), ".settings-block")).toMatch(/transition:\s*background-color var\(--motion-sheet\)/);
  });
  it("app.css folds away the .bot-cursor 0.18s drift", () => {
    expect(ruleFor(read("app.css"), ".bot-cursor")).toMatch(/transition:\s*transform var\(--motion-enter\)/);
  });
  it("app.css folds away the .bot-cursor svg drift onto the tap token", () => {
    expect(ruleFor(read("app.css"), ".bot-cursor svg")).toMatch(/transition:\s*transform var\(--motion-tap\)/);
  });
});

describe("nothing animates a layout property (brief; §10.2)", () => {
  // The allowed list from the brief. Everything else is either a layout property or a paint property
  // expensive enough that it has no business running per frame.
  const ALLOWED = new Set(["transform", "transform-origin", "opacity", "background-color", "border-color", "color", "box-shadow", "filter", "animation-timing-function"]);

  for (const file of SHEETS) {
    it(`${file} animates only compositor-safe properties in its @keyframes`, () => {
      const offenders: string[] = [];
      for (const [name, body] of keyframeBlocks(read(file))) {
        for (const m of body.matchAll(/(?:^|[;{])\s*([-a-zA-Z]+)\s*:/g)) {
          if (!ALLOWED.has(m[1]!)) offenders.push(`@keyframes ${name} animates \`${m[1]}\``);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  // §10.12. The onboarding typewriter animated `width` on every frame of a 3s loop and escaped the
  // shipped guard only because that guard inspects `transition` declarations and never @keyframes.
  it("app.css no longer carries the width-animating `type` keyframe", () => {
    expect(stripComments(read("app.css"))).not.toMatch(/@keyframes\s+type\s*\{/);
  });
  it("app.css reveals the onboarding typewriter with a transform wipe instead", () => {
    const src = stripComments(read("app.css"));
    expect(src).toMatch(/@keyframes\s+type-wipe\s*\{[^}]*scaleX/);
    expect(ruleFor(src, ".typing-text::after"), "the wipe needs a cover element").toMatch(/animation:\s*type-wipe/);
    // Base state is uncovered, so reduced motion (which collapses the animation) leaves the text
    // readable rather than hidden under a cover frozen at scaleX(1).
    expect(ruleFor(src, ".typing-text::after")).toMatch(/transform:\s*scaleX\(0\)/);
  });
});

describe("message and card entrances (§3.2, §3.3, §5.1, §5.2)", () => {
  const src = () => stripComments(read("app.css"));

  it("a new user message GLIDES from its tail corner, no squash-bounce (the smooth pass, Task 9)", () => {
    const rule = ruleFor(src(), ".msg.user.is-new");
    expect(rule, "the entrance must be gated on .is-new, never on :last-child (§10.8)").toBeDefined();
    expect(rule!).toMatch(/animation:\s*msg-in-user var\(--motion-msg-user\) var\(--ease-out\) backwards/);
    expect(rule!).toMatch(/transform-origin:\s*100% 100%/);
  });

  it("the user glide's keyframe is a plain translate+scale-in, not a sampled spring", () => {
    const body = keyframeBlocks(src()).find(([n]) => n === "msg-in-user")?.[1];
    expect(body, "@keyframes msg-in-user missing").toBeDefined();
    expect(body!).toMatch(/opacity:\s*0/);
    expect(body!).toMatch(/transform:\s*translateX\(12px\)\s*translateY\(4px\)\s*scale\(0\.98\)/);
    const light = stripComments(read("tokens.css"));
    expect(light).toMatch(/--motion-msg-user:\s*240ms;/);
  });

  it("the JS timer that holds the Bot's typing dots off is pinned to --motion-msg-user, so it cannot drift from the CSS duration", async () => {
    const { MSG_USER_ENTER_MS } = await import("../../src/renderer/motion");
    expect(MSG_USER_ENTER_MS).toBe(240);
  });

  it("under reduced motion, messages fade in only — opacity, on the fast token, no glide or scale-in", () => {
    const reduce = src().match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduce).toMatch(/\.msg\.user\.is-new,\s*\.msg\.bot\.is-new,\s*\.bubble\.bot\.typing\s*\{\s*animation:\s*text-in var\(--motion-tap\) backwards !important;/);
    const fade = keyframeBlocks(read("app.css")).find(([n]) => n === "text-in")?.[1] ?? "";
    expect(fade).not.toMatch(/transform/);
    expect(stripComments(read("tokens.css"))).toMatch(/--motion-tap:\s*120ms ease-out;/);
  });

  it("the Bot's reply enters once, as the typing bubble, mirrored — opacity + a 6px rise, no scale", () => {
    expect(src()).toMatch(/@keyframes\s+msg-in-left\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(6px\);/);
    const rule = ruleFor(src(), ".bubble.bot.typing");
    expect(rule).toBeDefined();
    expect(rule!).toMatch(/animation:\s*msg-in-left var\(--motion-msg-bot\) var\(--ease-out\) backwards/);
    expect(ruleFor(src(), ".msg.bot.is-new"), "the persisted reply shares the one entrance").toMatch(/msg-in-left/);
  });

  it("cards enter on the sheet curve, gated on .is-new", () => {
    expect(src()).toMatch(/@keyframes\s+card-in\s*\{/);
    for (const sel of [".card.is-new", ".card-primitive.is-new", ".file-card.is-new"]) {
      expect(ruleFor(src(), sel), `${sel} has no entrance`).toMatch(/animation:\s*card-in var\(--motion-sheet\) backwards/);
    }
  });

  it("a tray comes down from the chrome, and the banners share the rule", () => {
    expect(src()).toMatch(/@keyframes\s+tray-in\s*\{\s*from\s*\{[^}]*translateY\(-6px\)/);
    for (const sel of [".tray.is-new", ".attention", ".box-banner", ".disk-banner"]) {
      expect(ruleFor(src(), sel), `${sel} has no entrance`).toMatch(/animation:\s*tray-in var\(--motion-sheet\) backwards/);
    }
  });
});

describe("surfaces (§5.3, §6.1, §6.2, §6.3)", () => {
  it("the scrim darkens on the fast tier, not the surface tier", () => {
    const src = stripComments(read("app.css"));
    expect(src).toMatch(/@keyframes\s+scrim-in\s*\{\s*from\s*\{\s*opacity:\s*0/);
    expect(ruleFor(src, ".scrim")).toMatch(/animation:\s*scrim-in var\(--motion-tap\) backwards/);
    expect(ruleFor(src, ".voice-scrim")).toMatch(/animation:\s*scrim-in var\(--motion-tap\) backwards/);
  });

  it("the scrim never animates its backdrop-filter radius (§6.1)", () => {
    const decls = stripComments(read("app.css")).match(/(transition|animation)\s*:[^;}]*/g) ?? [];
    expect(decls.filter((d) => /backdrop-filter/.test(d))).toEqual([]);
  });

  it("modals, sheets and the voice overlay carry the weight", () => {
    const src = stripComments(read("app.css"));
    expect(src).toMatch(/@keyframes\s+surface-in\s*\{/);
    for (const sel of [".modal", ".sheet", ".voice-overlay"]) {
      expect(ruleFor(src, sel), `${sel} has no entrance`).toMatch(/animation:\s*surface-in var\(--motion-sheet\) backwards/);
    }
  });

  // UI polish pass (2026-09-24, critique 4.3): ⌘K appears in 120ms, opacity and 4px only, no scale.
  it("the palette descends on the fast tier — ⌘K is muscle memory", () => {
    const src = stripComments(read("palette.css"));
    expect(src).toMatch(/@keyframes\s+palette-in\s*\{[^}]*translateY\(-4px\)/);
    expect(src).not.toMatch(/@keyframes\s+palette-in\s*\{[^}]*scale/);
    expect(ruleFor(src, ".palette")).toMatch(/animation:\s*palette-in var\(--motion-quick\) var\(--ease-out\) backwards/);
    expect(stripComments(read("tokens.css"))).toMatch(/--motion-quick:\s*120ms;/);
    expect(ruleFor(src, ".palette")).toMatch(/transform-origin:\s*50% 0%/);
  });

  // §5.3 and §10.7: the single most likely bug in the spec. `.link-copied` is centred with
  // translateX(-50%); a keyframe that sets only translateY silently drops the centring and throws the
  // toast to the middle-left of the window for the duration of the animation.
  it("the copy toast keeps its horizontal centring in every keyframe", () => {
    const src = stripComments(read("app.css"));
    const toastFrames = keyframeBlocks(src).filter(([n]) => n.startsWith("toast-"));
    expect(toastFrames.length, "no toast keyframes").toBeGreaterThan(0);
    for (const [name, body] of toastFrames) {
      for (const m of body.matchAll(/transform:\s*([^;}]+)/g)) {
        expect(m[1]!, `@keyframes ${name} drops the -50% centring`).toMatch(/translate\(\s*-50%/);
      }
    }
    expect(ruleFor(src, ".link-copied")).toMatch(/animation:\s*toast-in var\(--motion-sheet\) backwards/);
    expect(ruleFor(src, ".link-copied.leaving")).toMatch(/animation:\s*toast-out var\(--motion-tap\) both/);
  });
});

describe("presence: shape avatars move by the measured script, pictures by CSS (§4.1, §4.3)", () => {
  // A shape avatar animates itself (avatar/face-sim.ts; see face-sim.test.ts for every
  // per-state claim: poses, dwell, blinks, sway, spins, overlays). CSS keeps one distinct loop per state
  // for the one avatar with no face to move — an uploaded/generated picture (`.avatar-img`).
  const STATES = ["idle", "thinking", "working", "searching", "sending", "orbit", "loading"];

  it("every presence state has a picture-avatar animation, including idle", () => {
    const src = stripComments(read("app.css"));
    for (const s of STATES) {
      expect(ruleFor(src, `.avatar-img.presence-${s}`), `.avatar-img.presence-${s} is inert`).toMatch(/animation:\s*[\w-]+\s+var\(--loop-(slow|mid|fast)\)/);
    }
  });

  it("no two presence states look the same", () => {
    const src = stripComments(read("app.css"));
    const signatures = STATES.map((s) => {
      const m = ruleFor(src, `.avatar-img.presence-${s}`)!.match(/animation:\s*([\w-]+)\s+(var\(--loop-[\w-]+\))/)!;
      return `${m[1]} @ ${m[2]}`;
    });
    expect(new Set(signatures).size, `states collapse onto one another: ${signatures.join(", ")}`).toBe(STATES.length);
  });

  // §1, "Why three loop periods". 1.3 and 2.4 share no common period, so the sidebar dot and the
  // status text describing ONE state drifted in and out of phase forever. At 1.2s the dot is an exact
  // half of the shimmer and the pair re-aligns every cycle.
  it("the working marker and the Working status are phase-locked", () => {
    const src = stripComments(read("app.css"));
    expect(ruleFor(src, ".marker.working")).toMatch(/animation:\s*pulse var\(--loop-mid\)/);
    // The header's live chip (the Carbon look) pulses its dot on the marker's own period.
    expect(ruleFor(src, ".live-chip.working::before")).toMatch(/animation:\s*pulse var\(--loop-mid\)/);
    expect(ruleFor(src, ".avatar-img.presence-working")).toMatch(/var\(--loop-mid\)/);
    expect(ruleFor(src, ".activity-row.live")).toMatch(/animation:\s*shimmer var\(--loop-slow\)/);
  });

  it("--loop-fast is reserved for the typing dots", () => {
    const src = stripComments(read("app.css"));
    expect(ruleFor(src, ".typing .dots i")).toMatch(/animation:\s*typing var\(--loop-fast\)/);
    // Counted by SELECTOR, not by occurrence: the reduced-motion block restates the dots' period for
    // their opacity-only pulse, which is still the typing dots. Any other selector is a violation.
    const users = [...src.matchAll(/([^{}]+)\{([^{}]*var\(--loop-fast\)[^{}]*)\}/g)].map((m) => m[1]!.trim());
    expect(users.length).toBeGreaterThan(0);
    expect(new Set(users), "--loop-fast belongs to the typing dots alone").toEqual(new Set([".typing .dots i"]));
  });

  it("the picture avatar's one-shots exist (motion-spec §4.4)", () => {
    const src = stripComments(read("app.css"));
    expect(ruleFor(src, ".avatar-img.presence-ack")).toMatch(/animation:\s*ack var\(--motion-sheet\) backwards/);
    expect(ruleFor(src, ".avatar-img.presence-settle")).toMatch(/animation:\s*settle var\(--motion-spring\) backwards/);
  });

  // The shape avatar's head, eyes and overlays are written every frame by the avatar loop. A CSS
  // animation on any of them — or an unscoped `.presence-*` loop, which lands on the shape avatar's
  // <svg> because BotAvatar still sets the class — would stack an invented motion on the measured one.
  it("no stylesheet animates a shape avatar", () => {
    for (const file of SHEETS) {
      const clean = stripComments(read(file)).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/animation\s*:/.test(m[2]!)) continue;
        for (const sel of m[1]!.split(",").map((s) => s.trim())) {
          expect(sel, `${file}: ${sel}`).not.toMatch(/face-avatar|avatar-body|avatar-head|avatar-eye|avatar-mouth|avatar-spark|avatar-pupil|avatar-side-dot|avatar-kit-|avatar-3d/);
          if (/\.presence-/.test(sel)) expect(sel, `${file}: an unscoped presence loop reaches the shape avatar`).toMatch(/^\.avatar-img\.presence-/);
        }
      }
    }
  });

  it("the retired motion kits and dark pupils are gone from the stylesheet", () => {
    const src = stripComments(read("app.css"));
    const names = keyframeBlocks(src).map(([n]) => n);
    expect(names.filter((n) => /^(kit-|pupil|eyes-|eye-blink)/.test(n))).toEqual([]);
    expect(src).not.toMatch(/\.avatar-kits\b|\.avatar-pupils\b|\.avatar-kit-/);
  });

  it("streamed text fades in over the typing dots (motion-spec §3.4)", () => {
    const src = stripComments(read("app.css"));
    expect(src).toMatch(/@keyframes\s+text-in\s*\{/);
    expect(ruleFor(src, ".typing > :not(.dots)")).toMatch(/animation:\s*text-in var\(--motion-tap\) backwards/);
  });
});

describe("micro-interactions (§7.1, §7.2)", () => {
  it("the switch knob throws on the spring while its colour stays on the fast tier", () => {
    const knob = ruleFor(read("app.css"), ".switch::after");
    expect(knob).toBeDefined();
    expect(knob!, "transform must ride the spring — a real toggle has momentum").toMatch(/transition:[^;]*\btransform var\(--motion-spring\)/);
    expect(knob!, "a 320ms colour fade on a 14px dot reads as lag, not spring").toMatch(/transition:[^;]*\bbackground-color var\(--motion-tap\)/);
  });

  // `.stop-btn` was in this group and is now one of `.btn-compact`'s three surfaces, so the press
  // reaches the teach pill and the teach bar too. That is the whole 28px family pressing alike
  // rather than one of its three former spellings — see app.css, where the rule's own comment says
  // why the bar-scale pill belongs here and a 52px tile does not.
  it("action bars damp on press and spring back", () => {
    const src = stripComments(read("app.css"));
    for (const sel of [".btn-primary", ".round-btn.dark", ".btn-compact"]) {
      const base = ruleFor(src, sel);
      expect(base, `${sel} has no press transition`).toMatch(/transition:[^;]*\btransform var\(--motion-spring\)/);
      expect(ruleFor(src, `${sel}:not(:disabled):active`), `${sel} has no press squash`).toMatch(/transform:\s*scale\(0\.96\)/);
    }
  });

  // §10.10 / §10.11 and the interaction-states contract: hover never moves a row in a scrolling list,
  // and a press-squash on a 52px sidebar tile reads as a toy.
  it("the squash never reaches a list row or a sidebar tile", () => {
    const src = stripComments(read("app.css"));
    for (const sel of [".row", ".tile", ".menu-item", ".nav-item", ".palette-row"]) {
      for (const state of [":hover", `:active`]) {
        const body = ruleFor(src, `${sel}${state}`) ?? "";
        expect(body, `${sel}${state} must not move`).not.toMatch(/transform:/);
      }
    }
  });
});

// ---- Liquid motion (decisions.md, "motion tokens and the scope of liquid") ----------------------
// Extends the guard so NEW motion has to use the tokens: no bare duration in an animation either, no
// hand-written curve anywhere but tokens.css, only compositor-safe properties in a transition, and —
// the user's own clarification, "no glass, just the flow" — no blur or backdrop-filter.

/** Every `prop: value` declaration of a sheet, with the selector it sits under (comments and keyframes stripped). */
function declarations(src: string, prop: RegExp): { sel: string; value: string }[] {
  const clean = stripComments(src).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: { sel: string; value: string }[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const d of m[2]!.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      if (prop.test(d.slice(0, i).trim())) out.push({ sel: m[1]!.trim(), value: d.slice(i + 1).trim() });
    }
  }
  return out;
}

describe("liquid motion: the tokens", () => {
  const src = stripComments(read("tokens.css"));
  const light = src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1] ?? "";
  const token = (name: string) => light.match(new RegExp(name + ":\\s*([^;]+);"))?.[1]?.trim();

  // The user asked for motion that feels "heavier… actually liquid, like water" (2026-09-21), which
  // replaced the original 150–350ms budget with a 400–650ms one. Then "even more liquid… ultra liquid"
  // (decisions.md, "ultra liquid"): MORE MASS, not more wobble. Each spring now has its own narrow
  // window (glide 650–700ms, pop 520–580ms) and its own overshoot band (glide 3.5–5%, pop 6–8%),
  // both TIGHTER than the shared 400–650 / 1–5% / 3–9% they replace. The SHAPE rules are unchanged
  // and strict: it rises without a wobble, sloshes past once, settles back without a second bounce,
  // and ends exactly at rest. A curve that snaps (no overshoot) or wobbles fails.
  const curve = (v: string) => (v.match(/linear\(([^)]*)\)/)?.[1] ?? "").split(",").map((s) => Number(s.trim()));
  it.each([["--motion-glide", 650, 700], ["--motion-pop", 520, 580]] as const)("%s is a sampled spring inside its %sms–%sms ultra-liquid budget", (name, lo, hi) => {
    const v = token(name);
    expect(v, `${name} missing from :root`).toBeDefined();
    const ms = Number(v!.match(/^(\d+)ms\s+linear\(/)?.[1]);
    expect(ms, `${name} must be a sampled spring (linear()) with a ms duration`).toBeGreaterThanOrEqual(lo);
    expect(ms).toBeLessThanOrEqual(hi);
  });
  it.each([["--motion-glide", 0.035, 0.05], ["--motion-pop", 0.06, 0.08]] as const)("%s sloshes past its target by %s–%s and settles without a second bounce", (name, lo, hi) => {
    const p = curve(token(name)!);
    expect(p[0]).toBe(0);
    expect(p.at(-1)).toBe(1);
    const peak = Math.max(...p);
    expect(peak - 1).toBeGreaterThanOrEqual(lo);
    expect(peak - 1).toBeLessThanOrEqual(hi);
    const rise = p.slice(0, p.indexOf(peak) + 1);
    rise.slice(1).forEach((x, i) => expect(x, "the rise never wobbles back").toBeGreaterThanOrEqual(rise[i]!));
    const after = p.slice(p.indexOf(peak));
    const trough = Math.min(...after);
    expect(trough, "it may dip just under rest once as it settles, never swing back down").toBeGreaterThan(0.99);
    expect(Math.max(...after.slice(after.indexOf(trough))) - 1, "no second bounce above rest").toBeLessThanOrEqual(0.01);
  });
  it("both curves are SAMPLED from the damped-spring model in renderer/motion.ts, not hand-tuned", async () => {
    const { SPRINGS, springCurve } = await import("../../src/renderer/motion");
    for (const k of ["glide", "pop"] as const) {
      expect(SPRINGS[k].zeta, `${k} is underdamped (it sloshes) but not springy`).toBeGreaterThan(0.6);
      expect(SPRINGS[k].zeta).toBeLessThan(0.75);
      expect(token(`--motion-${k}`)).toBe(`${SPRINGS[k].duration}ms ${springCurve(SPRINGS[k])}`);
    }
  });

  it("the JS mirror in renderer/motion.ts is the same two curves, value for value", async () => {
    const { MOTION } = await import("../../src/renderer/motion");
    expect(`${MOTION.glide.duration}ms ${MOTION.glide.easing}`).toBe(token("--motion-glide"));
    expect(`${MOTION.pop.duration}ms ${MOTION.pop.easing}`).toBe(token("--motion-pop"));
  });

  it("no curve is hand-written outside tokens.css", () => {
    for (const file of SHEETS.filter((f) => f !== "tokens.css")) {
      const src = stripComments(read(file));
      expect(src, `${file} writes its own cubic-bezier()/linear() — use a --motion-* token`).not.toMatch(/cubic-bezier\(|linear\(/);
    }
  });
});

describe("liquid motion: new motion must use the tokens", () => {
  // Two one-offs that predate the token set and are deliberately not interaction timings: the
  // settings-row highlight HOLDS for 2s so a deep-linked row can be found, and the onboarding
  // typewriter runs a 3s stepped loop. Anything else with a literal duration fails.
  const LEGACY = new Set(["flash 2s ease-out", "type-wipe 3s steps(40) infinite alternate"]);

  for (const file of SHEETS) {
    it(`${file} writes no bare duration in an animation`, () => {
      const bare = declarations(read(file), /^animation(-duration|-delay)?$/)
        .filter(({ value }) => !value.includes("!important")) // the reduced-motion collapse
        .filter(({ value }) => /(^|[\s,(])\d+(\.\d+)?m?s\b/.test(value) && !LEGACY.has(value));
      expect(bare.map((b) => `${b.sel} { ${b.value} }`)).toEqual([]);
    });

    it(`${file} transitions only compositor/paint-safe properties`, () => {
      const SAFE = new Set(["transform", "opacity", "background-color", "border-color", "color", "box-shadow"]);
      const bad: string[] = [];
      for (const { sel, value } of declarations(read(file), /^transition$/)) {
        for (const part of value.split(/,(?![^(]*\))/)) {
          const prop = part.trim().split(/\s+/)[0]!;
          if (prop !== "none" && !SAFE.has(prop)) bad.push(`${sel}: ${prop}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("liquid motion: no glass, just the flow", () => {
  // The single pre-existing blur: the voice overlay's scrim (§6.1), set once and never animated. It is
  // pinned here by selector so it cannot spread; the user's rule for everything new is flat and opaque.
  const ALLOWED = [".voice-scrim"];

  for (const file of SHEETS) {
    it(`${file} adds no backdrop-filter or blur()`, () => {
      const glass = [
        ...declarations(read(file), /^(-webkit-)?backdrop-filter$/).filter(({ value }) => value !== "none"),
        ...declarations(read(file), /^filter$/).filter(({ value }) => /blur\(/.test(value)),
      ].filter(({ sel }) => !ALLOWED.includes(sel));
      expect(glass.map((h) => `${h.sel} { ${h.value} }`)).toEqual([]);
    });
  }

  it("no renderer component sets a blur or backdrop filter inline", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = fileURLToPath(new URL("../../src/renderer/", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== "avatar") walk(p); continue; } // avatar motion is out of scope
        if (/\.tsx?$/.test(n) && /backdropFilter|blur\(/.test(readFileSync(p, "utf8"))) offenders.push(p.slice(root.length));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("liquid motion: surfaces", () => {
  const src = () => stripComments(read("app.css"));

  it("the typing dots keep their timing: 1.1s, staggered 0 / 0.15 / 0.30s, in the muted ink", () => {
    expect(stripComments(read("tokens.css"))).toMatch(/--dot-stagger:\s*150ms;/);
    expect(ruleFor(src(), ".typing .dots i")).toMatch(/background:\s*var\(--ink-muted\)/);
    expect(ruleFor(src(), ".typing .dots i:nth-child(2)")).toMatch(/animation-delay:\s*var\(--dot-stagger\)/);
    expect(ruleFor(src(), ".typing .dots i:nth-child(3)")).toMatch(/animation-delay:\s*calc\(2 \* var\(--dot-stagger\)\)/);
  });

  it("under reduced motion the dots pulse opacity only — no bounce", () => {
    const reduce = src().match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduce).toMatch(/\.typing \.dots i\s*\{[^}]*animation-name:\s*typing-fade/);
    const fade = keyframeBlocks(read("app.css")).find(([n]) => n === "typing-fade");
    expect(fade, "typing-fade keyframe missing").toBeDefined();
    expect(fade![1]).not.toMatch(/transform/);
    expect(fade![1]).toMatch(/opacity/);
  });

  it("the new-messages pill springs in and sits outside the scroller", () => {
    expect(ruleFor(src(), ".new-pill")).toMatch(/animation:\s*pill-in var\(--motion-pop\) backwards/);
    expect(ruleFor(src(), ".new-pill"), "centred with margins, so the entrance can own transform").not.toMatch(/translateX\(-50%\)/);
    expect(ruleFor(src(), ".transcript-wrap")).toMatch(/position:\s*relative/);
  });

  // UI polish pass (critique 4.1): a dropdown is clicked all day, so it opens from its origin in
  // 160ms on --ease-out — no spring, no overshoot.
  it("listboxes and pickers open from their origin, quickly and without a spring", () => {
    for (const sel of [".listbox", ".mention-picker", ".skill-picker"]) {
      expect(ruleFor(src(), sel), `${sel} has no entrance`).toMatch(/animation:\s*drop-in var\(--motion-dropdown\) var\(--ease-out\) backwards/);
    }
    expect(stripComments(read("tokens.css"))).toMatch(/--motion-dropdown:\s*160ms;/);
  });

  it("chevrons turn in 180ms on --ease-out, not on the glide spring", () => {
    expect(ruleFor(src(), ".activity-chev")).toMatch(/transition:\s*transform var\(--motion-chevron\) var\(--ease-out\)/);
    expect(ruleFor(src(), ".event-row.as-button > svg:last-child")).toMatch(/transition:\s*transform var\(--motion-chevron\) var\(--ease-out\)/);
    expect(stripComments(read("tokens.css"))).toMatch(/--motion-chevron:\s*180ms;/);
  });

  // The smooth pass, Task 8 (docs/sdd, 2026-09-23; controller decisions): `.menu` (the account menu
  // and every context menu) moves OFF the pop spring onto the new gliding family — no overshoot.
  it("the account and context menu glide in, not spring", () => {
    expect(ruleFor(src(), ".menu")).toMatch(/animation:\s*menu-in var\(--motion-menu\) var\(--ease-out\) backwards/);
  });

  it("view changes never run a View Transition (its overlay swallowed clicks; the morph went blank)", () => {
    expect(src()).not.toMatch(/view-transition-name/);
    expect(src()).not.toMatch(/::view-transition/);
  });

  // The smooth pass, Task 8: the right panel's content glides on the new flat family, not the spring —
  // its box still snaps (motion-css.test.ts's own Task 8 describe block pins the width guard).
  it("panels, settings sections, tool steps and Manage plugins all move", () => {
    expect(ruleFor(src(), ".panel > *")).toMatch(/animation:\s*panel-in var\(--motion-panel\) var\(--ease-drawer\) backwards/);
    // UI polish pass: a Settings section switch is a 120ms cross-fade, with no stagger.
    expect(ruleFor(src(), ".settings-content > :not(.settings-close)")).toMatch(/animation:\s*text-in var\(--motion-quick\) var\(--ease-out\) backwards/);
    expect(ruleFor(src(), ".settings-content > :not(.settings-close)")).not.toMatch(/animation-delay/);
    expect(ruleFor(src(), ".steps .step")).toMatch(/animation:\s*step-in var\(--motion-enter\) backwards/);
    expect(ruleFor(src(), ".steps .step")).toMatch(/min\(var\(--i, 0\), 4\) \* var\(--stagger\)/);
    expect(ruleFor(src(), ".market .skill-editor")).toMatch(/var\(--motion-glide\)/);
  });

  it("every button that is not a row or a tile presses on the spring", () => {
    for (const sel of [".btn-secondary", ".icon-btn", ".btn-outline"]) {
      expect(ruleFor(src(), sel), sel).toMatch(/transform var\(--motion-spring\)/);
      expect(ruleFor(src(), `${sel}:not(:disabled):active`), sel).toMatch(/transform:\s*scale\(0\.96\)/);
    }
  });

  it("the selection fill only exists while it is in flight", () => {
    expect(ruleFor(src(), ".glide-sel::before")).toMatch(/background:\s*var\(--fill-selected\)/);
    expect(ruleFor(src(), ".row.active"), "the resting selection is still the row's own background").toMatch(/background:\s*var\(--fill-selected\)/);
  });
});

// "Ultra liquid" (decisions.md): containers carry their contents with follow-through (children trail
// the container on the same spring), and lists cascade. Both are CAPPED: the trail index stops at
// STAGGER_CAP, so a 200-row list lags no more than a 5-row one.
describe("ultra liquid: follow-through and capped cascades", () => {
  const src = () => stripComments(read("app.css"));
  // `.panel > *` left this list in the smooth pass, Task 8 (docs/sdd, 2026-09-23; controller
  // decisions): the right panel's content now glides in flat on --motion-panel/--ease-drawer, with no
  // per-child --stagger delay, so it no longer belongs to the spring's follow-through cascade. The
  // panel's own entrance is covered above ("panels, settings sections, tool steps... all move" and
  // the Task 8 describe block); its --i nth-child assignments were removed from app.css to match.
  // UI polish pass: the Settings sections and ⌘K rows left this list — both are clicked all day and
  // now appear at once (a 120ms fade), with no cascade.
  const CONTAINERS = [".modal > *", ".sheet > *", ".market .plain-list.skills > li"];

  it("the JS stagger mirrors --stagger, and the cap keeps the longest trail under 200ms", async () => {
    const { STAGGER_MS, STAGGER_CAP } = await import("../../src/renderer/motion");
    expect(stripComments(read("tokens.css"))).toMatch(new RegExp(`--stagger:\\s*${STAGGER_MS}ms;`));
    expect(STAGGER_CAP * STAGGER_MS).toBeLessThanOrEqual(200);
  });

  it.each(CONTAINERS)("%s trails by its capped index on a token", (sel) => {
    const rule = ruleFor(src(), sel);
    expect(rule, `${sel} has no follow-through`).toBeDefined();
    expect(rule!).toMatch(/animation:\s*[\w-]+-in var\(--motion-(glide|enter)\) backwards/);
    expect(rule!).toMatch(/animation-delay:\s*calc\(\(?var\(--i, 0\)( \+ 1\))?\)? \* var\(--stagger\)\)/);
  });

  it("the trail index is assigned by position and stops growing at the cap", async () => {
    const { STAGGER_CAP } = await import("../../src/renderer/motion");
    const idx = [...src().matchAll(/:nth-child\(([^)]+)\)\s*\{\s*--i:\s*(\d+);?\s*\}/g)].map((m) => [m[1]!, Number(m[2])] as const);
    expect(idx.map(([, i]) => i).sort()).toEqual(Array.from({ length: STAGGER_CAP }, (_, k) => k + 1));
    expect(idx.find(([, i]) => i === STAGGER_CAP)![0], "the cap is a catch-all for every later child").toBe(`n+${STAGGER_CAP + 1}`);
    expect(ruleFor(src(), ".steps .step"), "tool steps keep their own cap").toMatch(/min\(var\(--i, 0\), 4\)/);
  });
});

// Bug: "the model dropdown hides behind the rest of the page". An ENTRANCE animation that holds its end
// state (fill-mode both/forwards) keeps a transform on the element forever, and Chromium gives every such
// element its own stacking context, so a listbox inside a `.panel > *` section could never draw over the
// section below it, whatever its z-index. Entrances use `backwards`: hidden before they start, and a
// completely ordinary element once they finish. Exits (…-out, .leaving) may hold their end state.
describe("entrance animations never outlive themselves (no residual stacking contexts)", () => {
  const files = ["app.css", "palette.css", "widgets.css", "skills.css", "bot-admin.css", "files.css", "google.css", "message-actions.css", "skill-picker.css", "tokens.css", "usage-dashboard.css"];
  it("every entrance animation uses fill-mode backwards", () => {
    const offenders: string[] = [];
    for (const f of files) {
      let css = "";
      try { css = stripComments(read(f)); } catch { continue; }
      for (const m of css.matchAll(/([^{}]+)\{[^{}]*?animation:\s*([\w-]+)\b([^;}]*)/g)) {
        const name = m[2]!, rest = m[3]!;
        const entrance = /-in(-|$)/.test(name) || name === "ack" || name === "settle";
        if (entrance && /\b(both|forwards)\b/.test(rest)) offenders.push(`${f}: ${m[1]!.trim()} → ${name}${rest}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("still lets an exit hold its end state (must-not-fire)", () => {
    expect(ruleFor(stripComments(read("app.css")), ".link-copied.leaving")).toMatch(/toast-out var\(--motion-tap\) both/);
  });
});

// The smooth pass, Task 8 (docs/sdd, 2026-09-23; controller decisions). UI motion GLIDES — ease-out,
// ~200ms, no overshoot — while the two springs above stay for avatars and continuity moves only. The
// right panel's box still snaps (never a width transition); only its CONTENT glides in.
describe("the smooth pass, Task 8 — the panel and account menu glide", () => {
  const tokens = stripComments(read("tokens.css"));
  const appCss = stripComments(read("app.css"));

  it("glides the panel and account menu without overshoot (smooth pass)", () => {
    expect(tokens).toMatch(/--motion-panel:\s*240ms/);
    expect(tokens).toMatch(/--ease-drawer:\s*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/);
    expect(appCss).toMatch(/\.panel > \*[^{]*\{[^}]*animation:[^;]*var\(--motion-panel\)/);
    expect(appCss).not.toMatch(/\.panel[^{]*\{[^}]*transition:[^;]*width/);
  });
});

// Fix round 1 (docs/sdd, 2026-09-23; controller ruling): the exit half of the same spec. Both the
// menu and the panel close on a DETACHED clone (Menus.tsx / DetailsPanel.tsx), never on the live,
// interactive element, so both keyframes are opacity-only and both hold their end state (`both`) —
// the exact carve-out "entrance animations never outlive themselves" already makes for `-out`/`.leaving`.
describe("fix round 1 — the menu and panel exits are opacity-only, on the fast token", () => {
  const appCss = stripComments(read("app.css"));

  it.each([[".menu", "menu-out"], [".panel", "panel-out"]] as const)("%s.leaving plays %s on --motion-tap, holding its end state", (sel, name) => {
    expect(ruleFor(appCss, `${sel}.leaving`)).toMatch(new RegExp(`animation:\\s*${name} var\\(--motion-tap\\) both`));
    expect(ruleFor(appCss, `${sel}.leaving`), "the exit must not intercept a click while it fades").toMatch(/pointer-events:\s*none/);
  });

  it.each(["menu-out", "panel-out"])("@keyframes %s only ever touches opacity", (name) => {
    const body = keyframeBlocks(appCss).find(([n]) => n === name)?.[1];
    expect(body, `@keyframes ${name} missing`).toBeDefined();
    expect(body!).toMatch(/opacity:\s*0/);
    expect(body!).not.toMatch(/transform/);
  });
});

// Fix round 1: the hover in/out split (Task 8) reaches every symmetric hover background, not only the
// ones inside the task's own file-range. Each of these still ran the SAME --motion-tap both ways.
describe("fix round 1 — the hover in/out split reaches every hover background", () => {
  const appCss = stripComments(read("app.css"));
  it.each([".new-pill", ".onb-shape", ".mini-call-return"])("%s's background transitions OUT on --motion-hover-out", (sel) => {
    expect(ruleFor(appCss, sel)).toMatch(/background-color var\(--motion-hover-out\)/);
  });
  it.each([".new-pill:hover", ".onb-shape:not(:disabled):hover", ".onb-shape[aria-checked=\"true\"]:not(:disabled):hover", ".mini-call-return:hover"])(
    "%s speeds back IN on --motion-hover-in",
    (sel) => { expect(ruleFor(appCss, sel)).toMatch(/transition-duration:[^;]*var\(--motion-hover-in\)/); },
  );
});
