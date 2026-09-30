import type { BotSettings } from "@synapse/shared";
import type { SystemPromptMode } from "../brain/spawn-options";

export function canOfferEngineering(s: BotSettings): boolean {
  return !s.engineeringMode && !s.engineeringOffered;
}

const utcMinute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Engineering mode ON (user decision 2026-09-21): the Bot runs Claude Code's full preset with our Bot
 * prompt appended, and this section, at the end of that append, tells it so. The preset already
 * carries the whole coding workflow, so this explains the mode; it does not re-teach coding.
 */
export function engineeringModeSection(sinceMs?: number, synapsePrompt = false): string {
  return [
    "# ENGINEERING MODE",
    `You are in engineering mode. The user turned it on${sinceMs ? ` (${utcMinute(sinceMs)})` : ""}.`,
    // A Bot on another provider's model runs Synapse's own engineering prompt (prompts/engineering-provider.md).
    synapsePrompt
      ? "Your system prompt is Synapse's engineering prompt (everything above your Bot instructions) plus your Bot instructions, instead of your standard assistant prompt."
      : "Your system prompt is Claude Code's full engineering prompt (everything above your Bot instructions) plus your Bot instructions, instead of your standard assistant prompt.",
    "Work as a software engineer: follow those coding practices in full. Read code before you change it and match its conventions; use git carefully (check status and diffs, commit only when asked, never rewrite shared history); run the tests and type checks before you say something works.",
    // cost-diet-2: the `cd <absolute project path> &&` line is gone. The gate now reads the built-in Bash's real cwd
    // from the CLI's PreToolUse input (bash-cwd.cli.integration.test.ts), so a bare `npm test` in the work tree takes
    // the fast path by mechanism; the Bot ignored the line after its first command anyway (coding-bench run 2).
    // Progress notes: 2026-09-21 run 1 sent 7 as model calls of their own; run 2 still sent 2-3 a task.
    // coding-parity: run 3 opened every task with an ack as a model call of its own; the host no longer asks for one here.
    "Do not acknowledge before you start: the app shows the user you are working, and each tool call. Start on the work; your first message is normally the result, sent with end_turn: true.",
    "Progress notes are rare and terse: the host only nudges past a genuinely long quiet stretch, at most once every ten minutes, never every couple of minutes; one short line, in the same response as your next tool call, never a model call of its own.",
    "Your Bot instructions still hold: how you reply to the user, your memory, your teammates and your tools are unchanged.",
    // Bug 5 (hand-test after a long engineering build): "no mistakes" got no special handling, so a Bot
    // could publish first and only catch an error on review after. Budget: prompt-budget.test.ts's on/off
    // diff ceiling (1,400 chars) had 174 chars of headroom; this line costs ~95.
    "When the user asks for no mistakes, fact-check and review before the first publish, not after.",
    "If asked which mode you are in, say engineering mode. It stays on until the user switches it off in this Bot's settings.",
  ].join("\n");
}

/** OFF under the box owner's SYNAPSE_SYSTEM_PROMPT=preset: standalone.md's mode line is not in the prompt, so this is. */
export const PRESET_STANDARD_MODE_LINE =
  "Mode: standard mode (engineering mode is off). The user can turn engineering mode on in this Bot's settings.";

/** The one-time hidden notice on the turn after a switch, so the change is explicit in the conversation. */
export function modeChangeNotice(on: boolean, offMode: SystemPromptMode, synapsePrompt = false): string {
  if (on) {
    return `Engineering mode was turned ON by the user just now; your system prompt changed to ${synapsePrompt ? "Synapse's engineering prompt" : "Claude Code's full engineering prompt"} plus your Bot instructions (see the ENGINEERING MODE section). Work as a software engineer from here on.`;
  }
  const standard = offMode === "standalone" ? "your standard assistant prompt" : "the standard Claude Code prompt";
  return `Engineering mode was turned OFF by the user just now; your system prompt changed back to ${standard} plus your Bot instructions. You are in standard mode.`;
}

export function engineeringOfferHint(canAsk: boolean): string {
  if (!canAsk) return "";
  return [
    "# Engineering mode",
    "If the user starts software-engineering work (code, git, pull requests, stack traces), call SuggestEngineeringMode once.",
    "The host refuses if they already declined or the mode is already on. Do not name the tool to the user.",
  ].join("\n");
}

/** `offMode` is the prompt this Bot runs while the switch is OFF (standalone unless the box owner forced the preset). */
/** `synapsePrompt`: the Bot runs on another provider's model, so engineering mode is Synapse's own prompt, not Claude Code's. */
export function engineeringSystemExtra(s: BotSettings, offMode: SystemPromptMode = "standalone", synapsePrompt = false): string {
  const mode = s.engineeringMode ? engineeringModeSection(s.engineeringModeSince, synapsePrompt) : offMode === "preset" && !synapsePrompt ? PRESET_STANDARD_MODE_LINE : "";
  return [mode, engineeringOfferHint(canOfferEngineering(s))].filter(Boolean).join("\n\n");
}
