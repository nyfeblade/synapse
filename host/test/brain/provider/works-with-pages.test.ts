import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ACP_INSTALL_PINS, ACP_VENDOR_IDS, ACP_VENDORS } from "@synapse/shared";
import { ProviderEvidenceStore } from "../../../brain/provider/conformance/evidence";
import { whatWorks } from "../../../brain/provider/catalog-view";
import { quirksFor } from "../../../brain/provider/adapters/quirks";
import { HelperRouter } from "../../../helper-model/router";

/** 0.1.6: the "Works with" pages say what the code does (checked when the pages were drafted, kept true here). */
const SITE = path.resolve(__dirname, "../../../../site/works-with");
const text = (f: string) => fs.readFileSync(path.join(SITE, f), "utf8").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const ev = new ProviderEvidenceStore(path.join(dir, "e.json"));
const state = (ref: string, label: string, usable: (p: string) => boolean = () => true) => whatWorks(ref, { usable, evidence: ev, reviewerQualified: () => false }).find((w) => w.label === label)!.state;

describe("the Works with pages match the product", () => {
  it("Gemini's search is Experimental on the page and in What works", () => {
    expect(text("gemini.html")).toContain("Web search, through Google Search grounding, as Experimental");
    expect(state("gemini:gemini-3.8-flash", "Web search", (p) => p === "gemini")).toBe("experimental");
  });

  it("coding agents and computer helpers: every provider page says they need an Anthropic key, and no provider Bot has them in What works", () => {
    for (const f of ["openai.html", "gemini.html", "openrouter.html", "mistral.html", "deepseek.html", "local-models.html"]) {
      expect(text(f), f).toContain("Coding agents. They run on Claude, so they need an Anthropic key.");
      expect(text(f), f).toContain("Computer and browser helpers. They still run on Claude, so they need an Anthropic key.");
    }
    expect(state("openai:gpt-6.1-sol", "Coding agents")).toBe("no");
  });

  it("voice calls: yes on cloud providers, Experimental on local ones, not on coding CLIs, as the pages say", () => {
    for (const f of ["openai.html", "gemini.html", "openrouter.html", "mistral.html", "deepseek.html"]) expect(text(f), f).toContain("Voice calls.");
    expect(text("local-models.html")).toContain("Voice calls, as Experimental.");
    expect(state("mistral:mistral-medium-latest", "Voice calls")).toBe("yes");
    expect(state("ollama:qwen3:4b", "Voice calls")).toBe("experimental");
    expect(state("acp:copilot", "Voice calls")).toBe("no");
  });

  it("local models: reached at their default ports on the Mac by the host's proxy, never by a Bot directly", () => {
    expect(quirksFor("ollama").baseUrl).toBe("http://host.orb.internal:11434/v1");
    expect(quirksFor("lmstudio").baseUrl).toBe("http://host.orb.internal:1234/v1");
    // The box's Mac guard lets only root and bothost (the host, where the provider proxy runs) reach the Mac.
    expect(fs.readFileSync(path.resolve(__dirname, "../../../../box/files/bots-ports"), "utf8")).toContain('meta skuid { "root", "bothost" } accept');
    const t = text("local-models.html");
    expect(t).toContain("Ollama on 11434 and LM Studio on 1234");
    expect(t).toContain("Your Bots never connect to your Mac themselves");
  });

  it("OpenRouter's models are pickable, and the coding CLIs page names exactly the vendors Install can put on the box", () => {
    expect(text("openrouter.html")).not.toContain("doesn't list OpenRouter's models");
    expect(text("openrouter.html")).toContain("The model picker lists them with their prices, and you can search them.");
    const installable = ACP_VENDOR_IDS.filter((v) => ACP_INSTALL_PINS[v]).map((v) => ACP_VENDORS[v].label);
    expect(installable).toEqual(["GitHub Copilot", "Kimi Code"]);
    expect(text("coding-subscriptions.html")).toContain(`${installable.join(" and ")} can be installed this way.`);
  });

  it("any-key setup: with an Anthropic key the reviewer and shared work run on Claude; without one, on the provider set up; the pages say both", () => {
    const router = (anthropic: boolean, reviewerChoice: string | null) => new HelperRouter({
      botModel: (id) => (id === "local-bot" ? "ollama:qwen3:4b" : undefined), anthropicReady: () => anthropic,
      consented: () => true, hasKey: () => false, botModels: () => ["ollama:qwen3:4b"], reviewerChoice: () => reviewerChoice,
    });
    expect(router(true, null).forBot("local-bot")).toEqual({ kind: "provider", ref: "ollama:qwen3:4b" });
    expect(router(true, null).forBot(null)).toEqual({ kind: "claude" });
    expect(router(true, null).reviewer()).toEqual({ kind: "claude" });
    expect(router(true, "ollama:qwen3:4b").reviewer()).toEqual({ kind: "provider", ref: "ollama:qwen3:4b" });
    // Set up with only a local model: the reviewer and the shared work run on it.
    expect(router(false, null).forBot(null)).toEqual({ kind: "provider", ref: "ollama:qwen3:4b" });
    expect(router(false, null).reviewer()).toEqual({ kind: "provider", ref: "ollama:qwen3:4b" });
    const local = text("local-models.html");
    expect(local).not.toContain("Setup always saves an Anthropic key");
    expect(local).toContain("Its own background work, like memory notes and summaries of long chats, runs on the same local model.");
    expect(local).toContain("If you set up with only a local model, the reviewer and the shared work run on your Mac as well.");
    expect(local).toContain("pick On this Mac in the key step");
    for (const f of ["index.html", "openai.html", "gemini.html", "openrouter.html", "mistral.html", "deepseek.html", "coding-subscriptions.html", "local-models.html"]) {
      expect(text(f), f).not.toMatch(/Setup always saves an Anthropic key|Setup still asks for an Anthropic key/);
      expect(text(f), f).toMatch(/Safety reviewer|reviewer in Settings/);
    }
    for (const f of ["openai.html", "gemini.html", "openrouter.html", "mistral.html", "deepseek.html"]) {
      expect(text(f), f).toContain("The safety reviewer runs on Claude when you've saved an Anthropic key, and otherwise on the provider you set up.");
      expect(text(f), f).toContain("pick it in the key step when you first open Synapse");
    }
  });

  it("the site, README and changelog say setup takes any provider's key", () => {
    const root = path.resolve(__dirname, "../../../..");
    const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    for (const f of ["README.md", "CHANGELOG.md", "site/index.html", "site/docs.html"]) {
      expect(read(f), f).not.toMatch(/Setup still asks for an Anthropic key|Setup needs (it|this key)|Anthropic API key to (start|finish setup|set it up)/);
    }
    expect(read("CHANGELOG.md")).toContain("Set up with any of them.");
    expect(read("site/index.html")).toContain("needs OrbStack and an AI key to start");
    expect(read("README.md")).toContain("Any one of them finishes setup.");
  });
});
