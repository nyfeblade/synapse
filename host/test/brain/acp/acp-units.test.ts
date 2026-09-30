import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_CONSENT_VERSION, ACP_VENDOR_IDS, ACP_VENDORS, isAcpModelRef, modelLabel, parseAcpModelRef } from "@synapse/shared";
import { ProviderConsentStore } from "../../../auth/provider-consent";
import { brainKindOf, sessionKindOf } from "../../../brain/brain-switch";
import { JsonRpcPeer, MAX_LINE_BYTES, RPC, RpcError } from "../../../brain/acp/jsonrpc";
import { AcpLogins, vendorLink } from "../../../brain/acp/login";
import { createAcpCommands } from "../../../brain/acp/module";
import { gateCallsFor, pickOutcome } from "../../../brain/acp/permission";
import { wrapChild } from "../../../brain/acp/spawn";
import { spawn as nodeSpawn } from "node:child_process";
import { AGENT } from "./harness";

const HOST = path.resolve(__dirname, "../../..");
const REPO = path.resolve(HOST, "..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "acp-unit-")); dirs.push(d); return d; };

describe("permission requests → gate calls (fail closed)", () => {
  const cwd = "/workspace";
  it("maps each kind Synapse understands to the call the gate already classifies", () => {
    expect(gateCallsFor({ toolCallId: "1", kind: "execute", rawInput: { command: "npm test" } }, cwd)).toEqual([{ toolName: "Bash", input: { command: "npm test" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "execute", rawInput: { command: ["git", "commit", "-m", "a b"] } }, cwd)).toEqual([{ toolName: "Bash", input: { command: "git commit -m 'a b'" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "read", locations: [{ path: "src/a.ts" }] }, cwd)).toEqual([{ toolName: "Read", input: { file_path: "/workspace/src/a.ts" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "edit", content: [{ type: "diff", path: "/workspace/a", oldText: "x", newText: "y" }] }, cwd)).toEqual([{ toolName: "Edit", input: { file_path: "/workspace/a", old_string: "x", new_string: "y" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "edit", content: [{ type: "diff", path: "/etc/passwd", oldText: null, newText: "root" }] }, cwd)).toEqual([{ toolName: "Write", input: { file_path: "/etc/passwd", content: "root" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "delete", rawInput: { path: "/workspace/x y" } }, cwd)![0]!.input.command).toBe("rm -rf -- '/workspace/x y'");
    expect(gateCallsFor({ toolCallId: "1", kind: "move", rawInput: { from: "a", to: "/tmp/b" } }, cwd)![0]!.input.command).toBe("mv -- /workspace/a /tmp/b");
    expect(gateCallsFor({ toolCallId: "1", kind: "fetch", rawInput: { url: "https://x.example" } }, cwd)).toEqual([{ toolName: "WebFetch", input: { url: "https://x.example", prompt: "" } }]);
    expect(gateCallsFor({ toolCallId: "1", kind: "search", rawInput: { pattern: "TODO" } }, cwd)).toEqual([{ toolName: "Grep", input: { pattern: "TODO", path: "/workspace" } }]);
  });
  it("an edit of several files is several gate calls (all must pass)", () => {
    expect(gateCallsFor({ toolCallId: "1", kind: "edit", locations: [{ path: "/workspace/a" }, { path: "/home/box/.host/x" }] }, cwd)).toHaveLength(2);
  });
  it("denies what it can't read: unknown, missing, think, switch_mode, other, and known kinds with no input", () => {
    for (const kind of ["think", "switch_mode", "other", "brand_new", "", undefined, null]) expect(gateCallsFor({ toolCallId: "1", kind, rawInput: { command: "ls" } }, cwd)).toBeNull();
    expect(gateCallsFor({ toolCallId: "1", kind: "execute", rawInput: {} }, cwd)).toBeNull();
    expect(gateCallsFor({ toolCallId: "1", kind: "execute", rawInput: { command: 42 } }, cwd)).toBeNull();
    expect(gateCallsFor({ toolCallId: "1", kind: "read" }, cwd)).toBeNull();
    expect(gateCallsFor({ toolCallId: "1", kind: "move", rawInput: { from: "a" } }, cwd)).toBeNull();
    expect(gateCallsFor({ toolCallId: "1", kind: "fetch", rawInput: {} }, cwd)).toBeNull();
  });
  it("answers allow only with allow_once, never allow_always; a denial rejects, else cancels", () => {
    const all = [{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }, { optionId: "R", kind: "reject_always" }];
    expect(pickOutcome(all, true)).toEqual({ outcome: "selected", optionId: "o" });
    expect(pickOutcome([{ optionId: "a", kind: "allow_always" }, { optionId: "R", kind: "reject_always" }], true)).toEqual({ outcome: "selected", optionId: "R" });
    expect(pickOutcome(all, false)).toEqual({ outcome: "selected", optionId: "r" });
    expect(pickOutcome([{ optionId: "a", kind: "allow_always" }], false)).toEqual({ outcome: "cancelled" });
    expect(pickOutcome("junk", true)).toEqual({ outcome: "cancelled" });
  });
});

describe("the vendor's own folder", () => {
  it("is recognised through ~, $HOME and the Bot's home, not elsewhere", async () => {
    const { acpTouchesVendorDir: t } = await import("@synapse/shared");
    expect(t("cat ~/.copilot/config.json", null)).toBe(true);
    expect(t('{"file_path":"/home/bots/bot-0123456789ab/.cursor/cli-config.json"}', "/home/bots/bot-0123456789ab")).toBe(true);
    expect(t("ls $HOME/.kimi-code", null)).toBe(true);
    expect(t("cat ${HOME}/.vibe/config.toml", null)).toBe(true);
    expect(t("cat /workspace/.copilot/notes.md", "/home/bots/bot-0123456789ab")).toBe(false);
    expect(t("cat ~/.copilotrc", null)).toBe(false);
    expect(t("npm test", null)).toBe(false);
  });
});

describe("JSON-RPC over NDJSON", () => {
  it("answers requests, hides internal errors, refuses an oversized line, and rejects pending calls on close", async () => {
    const toPeer = new PassThrough(); const fromPeer = new PassThrough();
    const peer = new JsonRpcPeer(toPeer, fromPeer, {
      request: async (m) => { if (m === "ok") return { v: 1 }; if (m === "rpc") throw new RpcError(RPC.methodNotFound, "Method not found"); throw new Error("secret /home/box/.host path"); },
      notification: () => {},
    });
    const lines: unknown[] = [];
    fromPeer.setEncoding("utf8");
    fromPeer.on("data", (c: string) => c.split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    toPeer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ok" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "rpc" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "boom" })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: { v: 1 } },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "Internal error" } },
    ]);
    const pending = peer.request("x", {});
    toPeer.write("a".repeat(MAX_LINE_BYTES + 10));
    await expect(pending).rejects.toThrow(/size limit/);
    expect(peer.closed).toBe(true);
  });
});

describe("the vendor table", () => {
  it("lists only allowed or tolerated vendors, all Experimental; no prohibited login is there", () => {
    expect([...ACP_VENDOR_IDS]).toEqual(["copilot", "cursor", "kimi", "vibe"]);
    for (const v of Object.values(ACP_VENDORS)) { expect(["allowed", "tolerated"]).toContain(v.terms); expect(v.status).toBe("experimental"); }
    const blob = JSON.stringify(ACP_VENDORS).toLowerCase();
    for (const banned of ["gemini", "antigravity", "claude", "anthropic", "kiro", "qwen"]) expect(blob).not.toContain(banned);
    expect(isAcpModelRef("acp:copilot")).toBe(true);
    expect(isAcpModelRef("acp:gemini")).toBe(false);
    expect(parseAcpModelRef("acp:vibe")).toBe("vibe");
    expect(modelLabel("acp:kimi")).toBe("Kimi Code");
    expect(brainKindOf("acp:cursor")).toBe("acp");
    expect(brainKindOf("openai:gpt-x")).toBe("provider");
    expect(sessionKindOf("prov-acp-1")).toBe("acp");
    expect(sessionKindOf("prov-1")).toBe("provider");
  });

  it("the box helper's command table is exactly the shared one (the host can't make it run anything else)", () => {
    const helper = fs.readFileSync(path.join(REPO, "box/files/bot-acp-as-box"), "utf8");
    const table = helper.slice(helper.indexOf("# ACP-TABLE-BEGIN"), helper.indexOf("# ACP-TABLE-END"));
    const rows = [...table.matchAll(/^\s+([a-z]+):(acp|login)\) bin=([A-Za-z0-9_.-]+); set --([^;]*);;$/gm)].map((m) => ({ v: m[1], mode: m[2], bin: m[3], args: m[4]!.trim() }));
    const want = ACP_VENDOR_IDS.flatMap((id) => [
      { v: id, mode: "acp", bin: ACP_VENDORS[id].bin, args: ACP_VENDORS[id].acpArgs.join(" ") },
      { v: id, mode: "login", bin: ACP_VENDORS[id].loginBin ?? ACP_VENDORS[id].bin, args: ACP_VENDORS[id].loginArgs.join(" ") },
    ]);
    expect(rows).toEqual(want);
    expect(helper).toContain('[ "${SUDO_USER:-}" = "bothost" ]');
    expect(helper).toContain("/usr/bin/env -i HOME=\"$home\"");
    const sudoers = fs.readFileSync(path.join(REPO, "box/files/sudoers-bothost"), "utf8");
    expect(sudoers).toMatch(/Defaults!\/usr\/local\/libexec\/bot-acp-as-box env_reset/);
    expect(fs.readFileSync(path.join(REPO, "box/provision.sh"), "utf8")).toContain("/usr/local/libexec/bot-acp-as-box");
  });
});

describe("the vendor's token is never read by Synapse", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "test"].includes(e.name) || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...sources(p));
      else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }
  it("no host source names a vendor's credential folder, or reads the table's credentialPaths", () => {
    const names = Object.values(ACP_VENDORS).flatMap((v) => v.credentialPaths);
    const hits: string[] = [];
    for (const f of sources(HOST)) {
      const src = strip(fs.readFileSync(f, "utf8"));
      if (/credentialPaths/.test(src)) hits.push(`${path.relative(HOST, f)}: credentialPaths`);
      for (const n of names) if (src.includes(`"${n}`) || src.includes(`'${n}`) || src.includes(`/${n}/`)) hits.push(`${path.relative(HOST, f)}: ${n}`);
    }
    expect(hits).toEqual([]);
  });
  it("the ACP brain runs a Bot tool only through ToolLoop (runToolBatch), never a handler directly", () => {
    for (const f of sources(path.join(HOST, "brain", "acp"))) {
      const src = strip(fs.readFileSync(f, "utf8"));
      expect(src, f).not.toMatch(/\.handler\b|handlerForTicket|executeGated/);
    }
  });
});

describe("consent and the gateway commands", () => {
  it("one consent per vendor, current text only; sign-in and the check need it and a real Bot", async () => {
    const consent = new ProviderConsentStore({ dir: tmp() });
    const logins = new AcpLogins({ spawn: () => { throw new Error("no"); }, cwd: () => "/" });
    const c = createAcpCommands({ consent, logins, hasBot: (id) => id === "b1" });
    const view = (await c.getAcpVendors!({} as never)) as { vendors: { id: string; consented: boolean; planNote: string; status: string }[] };
    expect(view.vendors.map((v) => [v.id, v.consented, v.planNote, v.status])).toEqual([
      ["copilot", false, "Included in your GitHub Copilot plan", "experimental"], ["cursor", false, "Included in your Cursor plan", "experimental"],
      ["kimi", false, "Included in your Kimi Code plan", "experimental"], ["vibe", false, "Included in your Mistral Vibe plan", "experimental"],
    ]);
    await expect(Promise.resolve().then(() => c.startAcpLogin!({ id: "b1", vendor: "copilot" } as never))).rejects.toMatchObject({ code: "NO_CONSENT" });
    await expect(Promise.resolve().then(() => c.consentAcpVendor!({ vendor: "copilot", textVersion: ACP_CONSENT_VERSION + 1 } as never))).rejects.toMatchObject({ code: "BAD_ARGS" });
    await c.consentAcpVendor!({ vendor: "copilot", textVersion: ACP_CONSENT_VERSION } as never);
    expect(consent.consentedAcp("copilot")).toBe(true);
    expect(consent.consentedAcp("cursor")).toBe(false);
    expect(consent.consented("openai")).toBe(false); // a vendor consent is not a provider consent
    await expect(Promise.resolve().then(() => c.startAcpLogin!({ id: "nope", vendor: "copilot" } as never))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(Promise.resolve().then(() => c.startAcpLogin!({ id: "b1", vendor: "gemini" } as never))).rejects.toMatchObject({ code: "BAD_PROVIDER" });
    expect(await c.startAcpLogin!({ id: "b1", vendor: "copilot" } as never)).toEqual({ kind: "failed", detail: "The sign-in couldn't start." });
    // A terminal sign-in is a command for the Bot's terminal, nothing started.
    await c.consentAcpVendor!({ vendor: "vibe", textVersion: ACP_CONSENT_VERSION } as never);
    expect(await c.startAcpLogin!({ id: "b1", vendor: "vibe" } as never)).toEqual({ kind: "terminal", command: "vibe --setup" });
  });
});

describe("Sign in with <vendor>", () => {
  it("shows a link only on the vendor's own hosts", () => {
    expect(vendorLink("Open https://github.com/login/device and enter ABCD-1234", ["github.com"])).toBe("https://github.com/login/device");
    expect(vendorLink("Go to https://evil.example/github.com", ["github.com"])).toBeNull();
    expect(vendorLink("https://github.com.evil.example/x", ["github.com"])).toBeNull();
    expect(vendorLink("http://github.com/login/device", ["github.com"])).toBeNull();
    expect(vendorLink("https://user:pw@github.com/x", ["github.com"])).toBeNull();
    expect(vendorLink("https://auth.kimi.com/device?x=1", ["kimi.com"])).toBe("https://auth.kimi.com/device?x=1");
  });

  it("runs the vendor's sign-in as the Bot and returns its link and code, never its other output", async () => {
    const d = tmp();
    const script = path.join(d, "login.mjs");
    fs.writeFileSync(script, `process.stderr.write("token-ish noise tok_ZZZ\\n"); console.log("First copy your one-time code: WXYZ-9876"); console.log("Then open https://github.com/login/device"); setTimeout(() => process.exit(0), 3000);`);
    const seen: { mode: string }[] = [];
    const logins = new AcpLogins({ spawn: (a) => { seen.push({ mode: a.mode }); return wrapChild(nodeSpawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] })); }, cwd: () => d });
    const r = await logins.start("b1", "copilot");
    logins.dispose();
    expect(r).toEqual({ kind: "link", url: "https://github.com/login/device", code: "WXYZ-9876" });
    expect(JSON.stringify(r)).not.toContain("tok_ZZZ");
    expect(seen).toEqual([{ mode: "login" }]);
  });

  it("the check asks the vendor CLI itself (signed in, or authentication required)", async () => {
    const d = tmp();
    const plan = path.join(d, "plan.json"); fs.writeFileSync(plan, "[]");
    const log = path.join(d, "log.jsonl"); fs.writeFileSync(log, "");
    const home = path.join(d, "home"); fs.mkdirSync(home);
    const spawn = () => wrapChild(nodeSpawn(process.execPath, [AGENT, plan, log], { env: { PATH: process.env.PATH ?? "", HOME: home, FAKE_ACP_AUTH: "1" }, stdio: ["pipe", "pipe", "pipe"] }));
    const logins = new AcpLogins({ spawn, cwd: () => d });
    expect(await logins.check("b1", "cursor")).toEqual({ signedIn: false, detail: "" });
    fs.mkdirSync(path.join(home, ".fakevendor")); fs.writeFileSync(path.join(home, ".fakevendor", "token"), "t");
    expect(await logins.check("b1", "cursor")).toEqual({ signedIn: true, detail: "" });
  });
});

describe("the model picker and metering", () => {
  it("a consented vendor is a Coding CLIs row, Experimental; its cost is the vendor's plan ($0 per token)", async () => {
    const { modelCatalogView, costPer100 } = await import("../../../brain/provider/catalog-view");
    const { ProviderEvidenceStore } = await import("../../../brain/provider/conformance/evidence");
    const view = modelCatalogView({ claudeModels: () => [], usable: () => false, evidence: new ProviderEvidenceStore(path.join(tmp(), "e.json")), reviewerQualified: () => true, acpVendors: () => ["copilot"] });
    expect(view.groups).toEqual([expect.objectContaining({ provider: "acp", label: "Coding CLIs", models: [expect.objectContaining({ ref: "acp:copilot", label: "GitHub Copilot", badges: ["experimental"] })] })]);
    expect(costPer100("acp:copilot", [{ inputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1e6 }])).toBe(0);
    expect(modelCatalogView({ claudeModels: () => [], usable: () => false, evidence: new ProviderEvidenceStore(path.join(tmp(), "e.json")), reviewerQualified: () => true }).groups).toEqual([]);
  });

  it("a Bot can be set to a vendor only once that vendor has consent", async () => {
    const { BotService } = await import("../../../bots/bot-service");
    const { SseHub } = await import("../../../gateway/sse-hub");
    const { HostSettingsStore } = await import("../../../store/host-settings");
    const { initLayout } = await import("../../../store/layout");
    const { tmpConfig } = await import("../../helpers");
    const cfg = tmpConfig();
    initLayout(cfg);
    let ok = false;
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "s.json")), acpModelAllowed: () => ok });
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    expect(() => bots.update(id, { model: "acp:copilot" })).toThrow(/Unknown model/);
    ok = true;
    bots.update(id, { model: "acp:copilot" });
    expect(bots.summary(id).profile.model).toBe("acp:copilot");
    expect(() => bots.update(id, { model: "acp:gemini" } as never)).toThrow(/Unknown model/);
  });
});
