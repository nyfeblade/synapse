// @vitest-environment jsdom
// Hand-test round: approvals, cards, banners and trays. Each case here is a defect the user hit
// in the packaged build ("a lot of the buttons do random things").
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, type ApprovalCardView, type McpServerView, type SendMessageEntry, type SseEvent, type TeachStatus, type Tray } from "@synapse/shared";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { CardView } from "../../src/renderer/components/Cards";
import { ConnectCard } from "../../src/renderer/components/cards/ConnectCard";
import { ConnectListenerForm } from "../../src/renderer/components/ConnectListenerCard";
import { TeachBanner } from "../../src/renderer/components/TeachBanner";
import { TeachPill } from "../../src/renderer/components/TeachPill";
import { Trays } from "../../src/renderer/components/Trays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

type Reply = (cmd: string, args: Record<string, unknown>) => unknown;
const calls: [string, Record<string, unknown>][] = [];
let reply: Reply = () => ({});
const listeners = new Set<(e: SseEvent) => void>();
const emit = (e: SseEvent) => { for (const f of listeners) f(e); };

/** A bridge whose canned reply may return a value, throw (IPC/transport failure) or return a gateway error. */
function installBridge(): void {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const r = reply(cmd, args) as { __error?: { code: string; message: string } } | undefined;
      if (r && typeof r === "object" && r.__error) return { ok: false, error: r.__error };
      return { ok: true, result: r ?? {} };
    }),
    onEvent: (cb: (e: SseEvent) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    onConnection: () => () => {},
    retry: () => {},
    appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
}

beforeEach(() => {
  calls.length = 0;
  listeners.clear();
  reply = () => ({});
  installBridge();
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Scout" }, group: null } as never } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ---------------------------------------------------------------- approvals

const approval: ApprovalCardView = {
  approvalId: "ap1", requestId: "req_1", surface: "mcp", title: "Your Bot would like to use a connected service",
  reason: "Delete 3 events from your Google Calendar on Friday afternoon.", summary: "Use Google Calendar tool delete_events",
  locationLine: "Runs on Bots' computer", details: null, command: "google_calendar.delete_events({})",
  items: [], hasProposedRule: true, status: "pending", cause: null, ruleAddedText: null, createdAt: 1, settledAt: null,
  verdict: { reason: "Deletes events.", tier: 3, matchedRuleIds: [], floorCategory: "F4", stage: "model" },
};

describe("ApprovalCard: a failed resolve must not fake an expired approval", () => {
  it("keeps the card answerable and shows a retryable error when the call fails", async () => {
    reply = () => { throw new Error("gateway disconnected"); };
    render(<ApprovalCard botId="a" approval={approval} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.allowOnce })); });
    // Still the live approval, not the settled/"Expired approval" branch.
    expect(screen.getByRole("region", { name: "Approval needed" })).toBeTruthy();
    expect(screen.queryByText(STR.settledTitle.expired)).toBeNull();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    const allow = screen.getByRole("button", { name: STR.allowOnce }) as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    // Retrying clears the error and resolves the approval.
    reply = () => ({});
    await act(async () => { fireEvent.click(allow); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.filter(([c]) => c === "resolveAutoReviewApproval").length).toBe(2);
  });

  it("still shows the settled 'expired' card when the host reports STALE_APPROVAL", async () => {
    reply = () => ({ __error: { code: "STALE_APPROVAL", message: "unknown approval" } });
    render(<ApprovalCard botId="a" approval={approval} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.allowOnce })); });
    expect(screen.getByRole("region", { name: "Expired approval" })).toBeTruthy();
  });

  it("clears a stale error when the host publishes a new status for the approval", async () => {
    reply = () => { throw new Error("gateway disconnected"); };
    const { rerender } = render(<ApprovalCard botId="a" approval={approval} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.allowOnce })); });
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(<ApprovalCard botId="a" approval={{ ...approval, status: "approved", settledAt: 2 }} />);
    expect(screen.getByRole("region", { name: "Approved action" })).toBeTruthy();
    rerender(<ApprovalCard botId="a" approval={approval} />);
    expect(screen.getByRole("region", { name: "Approval needed" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ------------------------------------------------------------------- trays

const tray = (over: Partial<Tray> = {}): Tray => ({
  id: "t1", botId: "a", title: "Routines paused", detail: "Spend limit reached", requestId: null,
  buttons: [], dedupeKey: "k", count: 1, createdAt: 0, ...over,
});

describe("Trays", () => {
  it("forwards the button's own action so 'Resume routines' actually resumes", async () => {
    useUi.setState({ trays: [tray({ buttons: [{ label: STR.resumeRoutines, action: "resume-routines" }] })] });
    render(<Trays botId="a" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.resumeRoutines })); });
    expect(calls).toContainEqual(["dismissTray", { trayId: "t1", action: "resume-routines" }]);
  });

  it("Clear removes the app-wide notifications it is showing, not just this Bot's", async () => {
    useUi.setState({ trays: [tray(), tray({ id: "t2", botId: null, title: "Usage limit reached" })] });
    render(<Trays botId="a" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.clear })); });
    const clearedGlobal = calls.some(([cmd, a]) =>
      (cmd === "dismissTray" && a.trayId === "t2") || (cmd === "clearTrays" && a.botId === undefined));
    expect(clearedGlobal).toBe(true);
  });
});

// ------------------------------------------------------------- connect card

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "s1", name: "Linear", label: null, kind: "remote", status: "connected", catalogId: "linear", tools: [], instructions: "", error: null, ...over,
});

describe("ConnectCard", () => {
  const card = { kind: "connect" as const, serverId: "s1", catalogId: "linear", name: "Linear", logo: null, toolCount: 3, state: "added" as const };

  it("shows the failure instead of hanging on 'Waiting for authorization'", async () => {
    reply = () => { throw new Error("no remote MCP server"); };
    render(<ConnectCard botId="a" entryId="e1" card={card} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${STR5.authorize} Linear` })); });
    expect(screen.getByRole("alert").textContent).toContain("no remote MCP server");
    expect(screen.queryByText(STR5.waitingForAuthorization)).toBeNull();
  });

  it("flips to Connected when the host reports the server authorized", async () => {
    render(<ConnectCard botId="a" entryId="e1" card={{ ...card, state: "waiting-auth" }} />);
    expect(screen.getByText(STR5.waitingForAuthorization)).toBeTruthy();
    await act(async () => { emit({ channel: "mcp-servers", payload: { servers: [server()] } }); });
    expect(screen.getByText(STR5.connected)).toBeTruthy();
    expect(screen.queryByText(STR5.waitingForAuthorization)).toBeNull();
  });
});

// ---------------------------------------------------- connect listener form

describe("ConnectListenerForm", () => {
  it("says what is still missing when the host stores the secret but is not connected", async () => {
    reply = () => ({ connected: false });
    render(<ConnectListenerForm botId="a" platform="slack" />);
    fireEvent.change(screen.getByLabelText("Slack webhook signing secret"), { target: { value: "shh" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.connect })); });
    expect(screen.getByRole("alert").textContent).toMatch(/token/i);
    expect(screen.queryByText("Connected")).toBeNull();
  });
});

// ------------------------------------------------------------------- teach

const rec = (p: Partial<TeachStatus> = {}): TeachStatus => ({
  state: "RECORDING", botId: "a", sessionId: "teach-1", sessionDir: "/w/t", startedAtMs: Date.now(), elapsedMs: 0, goal: "File an expense", ...p,
});

describe("Teach a task", () => {
  it("shows the error on the recording bar when Stop & save fails", async () => {
    useUi.setState({ teach: rec() });
    reply = () => { throw new Error("The Bot's output folder isn't usable."); };
    render(<TeachBanner botId="a" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR.teachStopSave })); });
    expect(screen.getByRole("alert").textContent).toContain("output folder isn't usable");
    expect((screen.getByRole("button", { name: STR.teachStopSave }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a bar on screen while the recording is being saved", () => {
    useUi.setState({ teach: rec({ state: "FINALIZING" }) });
    render(<TeachBanner botId="a" />);
    expect(screen.getByRole("status").textContent).toContain("Saving the recording");
    expect(screen.queryByText(/REC/)).toBeNull();
  });

  it("disables 'Teach a task' while this same Bot is recording", () => {
    useUi.setState({ teach: rec() });
    render(<TeachPill botId="a" />);
    const pill = screen.getByRole("button", { name: STR.teachTask }) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(pill.title).toBe("Recording in progress.");
  });

  it("drops a stale setup banner once the recording leaves IDLE", () => {
    useUi.setState({ teach: rec({ state: "FINALIZING" }), teachSetupFor: "a" });
    render(<TeachBanner botId="a" />);
    expect(screen.queryByText(STR.teachBanner)).toBeNull();
    expect(useUi.getState().teachSetupFor).toBeNull();
  });
});

// ------------------------------------------------------------- chat cards

const formEntry = (fields: { name: string; label: string; kind: "text" | "textarea" | "select"; options?: string[]; required?: boolean }[]): SendMessageEntry => ({
  kind: "send-message", id: "e1", requestId: "r", createdAt: 1, status: "pending",
  message: { type: "card", card: { kind: "form", title: "Trip", fields } },
});

describe("CardView", () => {
  it("a select with no preset value submits its first option, not an empty answer", () => {
    render(<CardView botId="a" entry={formEntry([{ name: "size", label: "Size", kind: "select", options: ["Small", "Large"] }])} />);
    expect((screen.getByLabelText("Size") as HTMLSelectElement).value).toBe("Small");
    fireEvent.click(screen.getByRole("button", { name: STR.submit }));
    expect(calls.at(-1)).toEqual(["respondToWidget", { id: "a", entryId: "e1", value: "submit", formValues: { size: "Small" } }]);
  });

  it("does not offer Submit until the required fields are filled", () => {
    render(<CardView botId="a" entry={formEntry([{ name: "city", label: "City", kind: "text", required: true }])} />);
    const submit = screen.getByRole("button", { name: STR.submit }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Denver" } });
    expect((screen.getByRole("button", { name: STR.submit }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a link card with a malformed url renders instead of blanking the transcript", () => {
    const entry: SendMessageEntry = { kind: "send-message", id: "e2", requestId: "r", createdAt: 1, status: "pending", message: { type: "card", card: { kind: "link", url: "https://", title: null, description: null } } };
    expect(() => render(<CardView botId="a" entry={entry} />)).not.toThrow();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://");
  });
});
