// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, LocalToolCardView, MarketplaceView, TemplateManifest } from "@synapse/shared";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { ManagePlugins } from "../../src/renderer/marketplace/ManagePlugins";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { ExportSheet } from "../../src/renderer/templates/ExportSheet";
import { useTemplates } from "../../src/renderer/templates/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

// Task 34 (Phase 5 fuzz pass): regressions for what the crawler and the abuse journeys found.

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
const calls: [string, unknown][] = [];
let reply: (cmd: string, args: unknown) => Reply | Promise<Reply>;
const unhandled: unknown[] = [];
const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault(); };

const e = (p: Partial<CatalogEntry> & { id: string; name: string }): CatalogEntry => ({ kind: "plugin", source: "curated", description: "", category: "Code", logo: null, action: "add", state: "available", ...p });
const view: MarketplaceView = { installed: { count: 0, logos: [] }, featuredBots: [], forYou: null, fromTeam: [], featuredPlugins: [e({ id: "curated:sentry", name: "Sentry" })], categories: [] };
const draft: TemplateManifest = { profile: { name: "Scout", title: "", description: "Scouts.", avatarShape: "orb", avatarColor: "#3472d9" }, skills: [], memories: [], routines: [], plugins: [] };

beforeEach(() => {
  calls.length = 0;
  unhandled.length = 0;
  window.addEventListener("unhandledrejection", onUnhandled);
  reply = () => ({ ok: true, result: {} });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); await new Promise((r) => setTimeout(r, 5)); return reply(cmd, args); }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); await new Promise((r) => setTimeout(r, 5)); return { ok: true, result: n === "saveFile" ? { path: "/tmp/scout.botpack" } : {} }; }), on: () => () => {} },
  };
});
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  window.removeEventListener("unhandledrejection", onUnhandled);
});
const count = (name: string) => calls.filter((c) => c[0] === name).length;

describe("Task 34 fuzz regressions", () => {
  it("K2 speed: double-clicking Add installs once and opens one authorization tab", async () => {
    reply = (cmd) => ({ ok: true, result: cmd === "getMarketplace" ? view
      : cmd === "installPlugin" ? { entry: e({ id: "curated:sentry", name: "Sentry", state: "needs-auth" }), serverIds: ["sentry"], needsAuth: true, openUrl: null }
      : cmd === "startMcpAuth" ? { authorizationUrl: "https://auth.example/a" } : {} });
    useMarketplace.setState({ open: true, page: "home", view, query: "", results: null, waiting: {}, recent: [], detailId: null });
    render(<MarketplaceModal />);
    const add = screen.getByRole("button", { name: "Add Sentry" });
    fireEvent.click(add);
    fireEvent.click(add);
    await vi.waitFor(() => expect(count("native:openExternal")).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(count("installPlugin")).toBe(1);
    expect(count("native:openExternal")).toBe(1);
  });

  it("K3 order: a connector removed while waiting for authorization offers Add again, and a failed Reopen/Add is shown, not thrown", async () => {
    reply = (cmd) => (cmd === "getMarketplace" ? { ok: true, result: view }
      : cmd === "startMcpAuth" || cmd === "installPlugin" ? { ok: false, error: { code: "NOT_FOUND", message: "No remote MCP server sentry" } }
      : { ok: true, result: {} });
    useMarketplace.setState({ open: true, page: "home", view, query: "", results: null, waiting: { "curated:sentry": "sentry" }, recent: [], detailId: null });
    // Manage plugins → Remove publishes mcp-servers; the Marketplace reloads and the entry is "available" again.
    await useMarketplace.getState().load();
    render(<MarketplaceModal />);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Sentry" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No remote MCP server sentry");
    useMarketplace.setState({ waiting: { "curated:sentry": "sentry" } });
    await useMarketplace.getState().reopen(e({ id: "curated:sentry", name: "Sentry", state: "waiting-auth" }));
    expect(useMarketplace.getState().waiting["curated:sentry"]).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it("LOC-04 speed: double-clicking Allow once answers once; a late answer shows an error, not an uncaught rejection", async () => {
    const card: LocalToolCardView = { kind: "local-tool-permission", askId: "k1", action: "run-command", target: "echo hi", description: null, status: "pending", createdAt: 1, expiresAt: 2 };
    let n = 0;
    reply = () => (++n === 1 ? { ok: true, result: { status: "allowed" } } : { ok: false, error: { code: "GONE", message: "This request is no longer waiting." } });
    render(<LocalToolCard botId="b" entryId="t1s1" card={card} />);
    const once = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(once);
    fireEvent.click(once);
    await new Promise((r) => setTimeout(r, 50));
    expect(count("resolveLocalToolPermission")).toBe(1);

    cleanup();
    reply = () => ({ ok: false, error: { code: "GONE", message: "This request is no longer waiting." } });
    render(<LocalToolCard botId="b" entryId="t1s1" card={{ ...card, askId: "k2" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This request is no longer waiting.");
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it("TPL-01 speed: triple-clicking Save template exports and saves once", async () => {
    reply = (cmd) => ({ ok: true, result: cmd === "draftTemplate" ? { draft } : cmd === "exportTemplate" ? { template: { id: "t1", name: "Scout" }, fileName: "scout.botpack", bytesBase64: "UEs=" } : {} });
    useUi.setState({ ...initialState() } as never);
    await useTemplates.getState().openExport("b1");
    render(<ExportSheet />);
    const save = screen.getByRole("button", { name: "Save template" });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(await screen.findByText("Saved to /tmp/scout.botpack")).toBeTruthy();
    expect(count("exportTemplate")).toBe(1);
    expect(count("native:saveFile")).toBe(1);
  });

  it("PLG-10 input: a rejected marketplace source shows the reason instead of an uncaught rejection", async () => {
    reply = (cmd) => (cmd === "addPluginMarketplace"
      ? { ok: false, error: { code: "BAD_ARGS", message: "Use a GitHub owner/repo or an https git URL." } }
      : { ok: true, result: cmd === "listMcpServers" ? { servers: [] } : cmd === "listPluginMarketplaces" ? { marketplaces: [] } : {} });
    render(<ManagePlugins />);
    fireEvent.change(await screen.findByRole("textbox", { name: "GitHub owner/repo or git URL" }), { target: { value: "file:///etc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add marketplace" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use a GitHub owner/repo or an https git URL.");
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it("TPL-02 input: File → Import Bot… with an unsafe or oversized .botpack says why instead of failing silently", async () => {
    reply = (cmd) => (cmd === "previewTemplateImport"
      ? { ok: false, error: { code: "BAD_TEMPLATE", message: "This template contains unsafe file names." } }
      : { ok: true, result: {} });
    useUi.setState({ ...initialState(), actionError: null } as never);
    useTemplates.setState({ sheet: null });
    await useTemplates.getState().importFromFile();
    expect(useUi.getState().actionError).toBe("This template contains unsafe file names.");
    expect(useTemplates.getState().sheet).toBeNull();

    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = async () => ({ ok: false, error: { code: "NATIVE_ERROR", message: "The file is larger than 25 MB." } });
    await useTemplates.getState().importFromFile();
    expect(useUi.getState().actionError).toBe("The file is larger than 25 MB.");
  });

  // Bug 134 (item 10): leaving the call's chat no longer ends the call (it shrinks to a pill; see
  // call-teammates-overlay.test.tsx). What stays true: the call's component going away ends the call.
  it("CHAT-08 order: unmounting the call ends voice mode, so it doesn't restart when you come back", () => {
    useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Scout", avatarShape: "orb", avatarColor: "#3472d9" }, settings: {} } } } as never);
    useVoice.getState().open("a");
    const { unmount } = render(<VoiceOverlay botId="a" />);
    expect(screen.getByRole("dialog", { name: "Start a voice call" })).toBeTruthy();
    unmount();
    expect(useVoice.getState().openFor).toBeNull();
  });
});
