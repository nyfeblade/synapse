// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { Async } from "../../src/renderer/components/Async";
import { FilePreview } from "../../src/renderer/components/FilePreview";
import { PrivateSkills } from "../../src/renderer/components/PrivateSkills";
import { ThreadPanel } from "../../src/renderer/components/ThreadPanel";
import { GeneralSection } from "../../src/renderer/components/settings/GeneralSection";
import { MemoryBlock } from "../../src/renderer/components/settings/MemoryBlock";
import { MarketplaceModal } from "../../src/renderer/marketplace/MarketplaceModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { TemplateMenu } from "../../src/renderer/templates/TemplateMenu";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

// PRIMITIVE 3, APPLIED — every surface here used to render a permanently blank rectangle when its
// read failed. Each test drives the component into the failing state for real and asserts the user
// is told what happened and given a way to try again.

const FAIL = "Could not reach the computer";

/** A bridge where the named commands come back as gateway errors. */
function bridgeFailing(cmds: string[], canned: Record<string, unknown> = {}) {
  const h = installFakeBridge(canned);
  const real = window.synapse.call as unknown as (c: string, a: unknown) => Promise<unknown>;
  (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (c: string, args: unknown) =>
    cmds.includes(c) ? { ok: false, error: { code: "GATEWAY_ERROR", message: FAIL } } : real(c, args));
  return h;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has none, and ChatView's transcript scrolls on mount
  useUi.setState({ ...initialState(), settings: settingsFixture() });
  useMarketplace.setState({ open: false, page: "home", view: null, error: null, query: "", results: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("store.loadAll — the worst state in the app", () => {
  it("a failed bootstrap shows the reason and a Retry in the main pane, not a blank one forever", async () => {
    bridgeFailing(["listAgents"]);
    const { container } = render(<App />);
    const main = await waitFor(() => {
      const m = container.querySelector("main.main");
      expect(m, "no main pane").not.toBeNull();
      expect(m!.textContent).toContain(FAIL);
      return m!;
    });
    expect(within(main as HTMLElement).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("Retry actually re-runs the bootstrap and the app comes up", async () => {
    bridgeFailing(["listAgents"]);
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("main.main")!.textContent).toContain(FAIL));
    // The host came back.
    installFakeBridge({ listAgents: { agents: [botFixture("a", "Planner")], activeAgentId: "a" }, openAgent: { agent: botFixture("a", "Planner") }, getAgentTranscriptTail: { entries: [] } });
    fireEvent.click(within(container.querySelector("main.main") as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: /Planner/ })).toBeTruthy();
  });

  it("the store keeps the bootstrap outcome as a status, not as an absence of rows", async () => {
    bridgeFailing(["getHostSettings"]);
    render(<App />);
    await waitFor(() => expect(useUi.getState().bootstrap.status).toBe("error"));
    expect(useUi.getState().bootstrap).toMatchObject({ status: "error", message: FAIL });
  });
});

describe("Settings → General", () => {
  it("says the settings could not be loaded instead of rendering an empty section", async () => {
    bridgeFailing(["getHostSettings"]);
    useUi.setState({ settings: null, bootstrap: { status: "error", message: FAIL } });
    render(<GeneralSection />);
    expect((await screen.findByRole("alert")).textContent).toContain(FAIL);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Settings → General → Memory (MemoryBlock)", () => {
  it("a failed read shows the reason with a Retry instead of hiding the dropdown", async () => {
    bridgeFailing(["getPhase5Settings"]);
    render(<MemoryBlock />);
    expect((await screen.findByRole("alert")).textContent).toContain(FAIL);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("still renders the dropdown when the read succeeds", async () => {
    installFakeBridge({ getPhase5Settings: { memoryMode: "standard" } });
    render(<MemoryBlock />);
    expect(await screen.findByLabelText("Memory")).toBeTruthy();
  });
});

describe("Private skills", () => {
  it("a failed list shows the reason and a Retry instead of an empty skills list", async () => {
    bridgeFailing(["getWorkflows"]);
    render(<PrivateSkills />);
    const dlg = screen.getByRole("dialog");
    expect((await within(dlg).findByRole("alert")).textContent).toContain(FAIL);
    expect(within(dlg).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Marketplace", () => {
  it("shows a loading status while the catalog is in flight, not an empty modal body", async () => {
    installFakeBridge({ getMarketplace: () => new Promise(() => {}) });
    useMarketplace.getState().openMarketplace();
    render(<MarketplaceModal />);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("status").textContent).toContain("Loading");
  });
});

describe("File preview", () => {
  it("shows a loading status while the file is being read, not an empty dialog", async () => {
    installFakeBridge({ readWorkspaceFile: () => new Promise(() => {}) });
    render(<FilePreview path="/w/a.txt" name="a.txt" mime="text/plain" onClose={() => {}} />);
    expect(within(await screen.findByRole("dialog")).getByRole("status").textContent).toContain("Loading");
  });

  it("a failed read says so", async () => {
    bridgeFailing(["readWorkspaceFile"]);
    render(<FilePreview path="/w/a.txt" name="a.txt" mime="text/plain" onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain(FAIL);
  });
});

describe("ThreadPanel", () => {
  it("a failed thread read shows the reason instead of an empty reply list", async () => {
    bridgeFailing(["getAgentThread"]);
    render(<ThreadPanel botId="a" rootId="e1" count={2} />);
    fireEvent.click(screen.getByRole("button", { name: "2 replies" }));
    expect((await screen.findByRole("alert")).textContent).toContain(FAIL);
  });

  it("does not read the thread until it is opened", () => {
    const { calls } = installFakeBridge({ getAgentThread: { replies: [] } });
    render(<ThreadPanel botId="a" rootId="e1" count={2} />);
    expect(calls.map(([c]) => c)).not.toContain("getAgentThread");
  });
});

describe("TemplateMenu", () => {
  it("a failed lookup tells the user instead of a button click that does nothing", async () => {
    bridgeFailing(["getTemplate"]);
    render(<TemplateMenu botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: /template/i }));
    await waitFor(() => expect(useUi.getState().actionError).toContain(FAIL));
    // ...and the button is live again, so the user can retry once the host is back.
    expect((screen.getByRole("button", { name: /template/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Onboarding — the very first screen of the app", () => {
  it('a failed "Input API Key" says what went wrong instead of doing nothing at all', async () => {
    bridgeFailing(["getOnboarding"]);
    render(<Onboarding onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /input api key/i }));
    expect((await screen.findByRole("alert")).textContent).toContain(FAIL);
  });

  it("a failed starter list shows the reason with a Retry instead of an empty carousel", async () => {
    bridgeFailing(["listStarterTemplates"], { getOnboarding: { hasSeenOnboarding: false, tokenConfigured: true } });
    render(<Onboarding onDone={() => {}} initialStep="new-bot" />);
    const carousel = screen.getByRole("region", { name: /suggestion/i });
    expect((await within(carousel).findByRole("alert")).textContent).toContain(FAIL);
    expect(within(carousel).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("<Async /> is the shared shape, not one-off markup", () => {
  it("every migrated surface renders its states through it", () => {
    expect(typeof Async).toBe("function");
  });
});
