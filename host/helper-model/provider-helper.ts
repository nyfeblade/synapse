import type { Meter } from "../usage/metered-query";
import type { OneShotModel as TextOneShot } from "../brain/one-shot";
import type { DreamLlm } from "../memory/dreaming/dreamer";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { extractJson, providerComplete } from "./llm";
import { OneShotTimeout, purposeOfPrompt, type OneShotModel as StructuredOneShot, type OneShotRequest } from "./one-shot";
import type { HelperRouter } from "./router";
import type { AvatarGenerator } from "../avatar/generate";
import { StubTemplateDrafter, type DraftInput, type DraftOutput, type TemplateDrafter } from "../templates/drafter";

/**
 * The host's helper interfaces, routed (spec §7a): each call asks the HelperRouter where it runs, and runs on Claude
 * (the existing implementation, unchanged) or on the chosen provider's model through HelperLLM. A Claude-only install
 * routes everything to Claude exactly as before.
 */

/** helper-model/one-shot.ts: structured one-shots (b2b gate, schedule parser, group floor, call greetings/wrap-up, standup). */
export class RoutedStructuredOneShot implements StructuredOneShot {
  constructor(private router: HelperRouter, private claude: StructuredOneShot) {}
  async run<T>(req: OneShotRequest): Promise<T> {
    const t = this.router.forBot(req.botId ?? null);
    if (t.kind === "claude") return this.claude.run<T>(req);
    // The email poll's connector tools run through ToolLoop on provider Bots, a later step: refused here, never unchecked.
    if (req.allowedTools?.length) throw new Error("connector tools in a one-shot aren't available on a provider model yet");
    const system = req.vars ? fillTemplate(loadPrompt(req.prompt), req.vars) : loadPrompt(req.prompt);
    const ac = new AbortController();
    try {
      const r = await providerComplete({
        purpose: purposeOfPrompt(req.prompt), botId: req.botId ?? null, ref: t.ref, system: `${system}\n\nReply with one JSON object only.`,
        user: JSON.stringify(req.input), schema: req.schema, timeoutMs: req.timeoutMs, signal: ac.signal, maxTokens: 4_000,
      });
      return r.json as T;
    } catch (e) {
      if (ac.signal.aborted || (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError") throw new OneShotTimeout(req.timeoutMs);
      throw e;
    }
  }
}

/** brain/one-shot.ts: plain-text helper calls (memory extraction, episodes). */
export class RoutedTextOneShot implements TextOneShot {
  constructor(private router: HelperRouter, private claude: TextOneShot, private o: { timeoutMs?: number } = {}) {}
  async complete(p: { system: string; user: string; signal?: AbortSignal; tag: Meter }): Promise<string> {
    const t = this.router.forBot(p.tag.botId);
    if (t.kind === "claude") return this.claude.complete(p);
    const r = await providerComplete({ purpose: p.tag.purpose, botId: p.tag.botId, ref: t.ref, system: p.system, user: p.user, timeoutMs: this.o.timeoutMs ?? 60_000, ...(p.signal ? { signal: p.signal } : {}), maxTokens: 4_000 });
    return r.text;
  }
}

/** memory/dreaming: synthesis and its independent verifier, both on the helper. */
export class RoutedDreamLlm implements DreamLlm {
  constructor(private router: HelperRouter, private claude: DreamLlm) {}
  synthesize(input: object, botId?: string): Promise<unknown> {
    return this.call("synthesize", fillTemplate(loadPrompt("orig/dream-synthesis.md"), { botName: String((input as { botName?: string }).botName ?? "the assistant") }), input, botId);
  }
  verify(input: object, botId?: string): Promise<unknown> {
    return this.call("verify", loadPrompt("orig/dream-verify.md"), input, botId);
  }
  private async call(which: "synthesize" | "verify", system: string, input: object, botId?: string): Promise<unknown> {
    const t = this.router.forBot(botId ?? null);
    if (t.kind === "claude") return which === "synthesize" ? this.claude.synthesize(input, botId) : this.claude.verify(input, botId);
    const r = await providerComplete({ purpose: "dreaming", botId: botId ?? null, ref: t.ref, system, user: JSON.stringify(input), timeoutMs: 120_000, maxTokens: 8_000 });
    return extractJson(r.text);
  }
}

/** Avatar SVGs (spec §7a row 9): the account helper; Claude's generator when it runs on Claude. */
export class RoutedAvatarGenerator implements AvatarGenerator {
  constructor(private router: HelperRouter, private claude: AvatarGenerator) {}
  async generate(botId: string, prompt: string, color: string): Promise<string> {
    const t = this.router.forBot(botId);
    if (t.kind === "claude") return this.claude.generate(botId, prompt, color);
    const r = await providerComplete({
      purpose: "avatar", botId, ref: t.ref, system: "Reply with one JSON object only.",
      user: fillTemplate(loadPrompt("orig/avatar-svg.md"), { prompt: prompt.slice(0, 300), color }),
      schema: { type: "object", properties: { svg: { type: "string" } }, required: ["svg"], additionalProperties: false }, timeoutMs: 90_000, maxTokens: 6_000,
    }).catch(() => null);
    const svg = (r?.json as { svg?: unknown } | undefined)?.svg;
    if (typeof svg !== "string" || !svg.includes("<svg")) throw new Error("The avatar couldn't be generated. Try a different description.");
    return svg;
  }
}

/** Template drafts (spec §7a row 10): the Bot's helper; without Claude there is no session fork, only the input. */
export class RoutedTemplateDrafter implements TemplateDrafter {
  constructor(private router: HelperRouter, private claude: TemplateDrafter) {}
  async draft(botId: string, sessionId: string | null, input: DraftInput): Promise<DraftOutput> {
    const t = this.router.forBot(botId);
    if (t.kind === "claude") return this.claude.draft(botId, sessionId, input);
    const schema = { type: "object", properties: { description: { type: "string" }, memories: { type: "array", items: { type: "string" } } }, required: ["description", "memories"], additionalProperties: false };
    const r = await providerComplete({ purpose: "template-draft", botId, ref: t.ref, system: `${loadPrompt("orig/template-draft.md").trim()}\n\nReply with one JSON object only.`, user: JSON.stringify(input), schema, timeoutMs: 90_000, maxTokens: 6_000 }).catch(() => null);
    const out = r?.json as DraftOutput | undefined;
    if (!out) return new StubTemplateDrafter().draft(botId, sessionId, input);
    const allowed = new Set(input.memories);
    return { description: String(out.description).slice(0, 20_000), memories: out.memories.filter((x) => allowed.has(x)) };
  }
}
