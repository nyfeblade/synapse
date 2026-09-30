// @vitest-environment jsdom
// Send feedback: the sheet's preview is exactly what's sent, a type is required, "Post on GitHub"
// builds a correct prefilled issue link, and 👍/👎 stay local.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_ISSUE_PREFIX, FEEDBACK_MAX_ISSUE_URL, type FeedbackPayload } from "@synapse/shared";
import { FeedbackHost } from "../../src/renderer/feedback/FeedbackSheet";
import { closeFeedback, openFeedback } from "../../src/renderer/feedback/store";
import { buildPayload, githubIssueUrl } from "../../src/renderer/feedback/payload";
import { RateButtons, RatingsRow } from "../../src/renderer/feedback/Ratings";
import { accountMenuItems } from "../../src/renderer/components/account-menu";
import { typedRows } from "../../src/renderer/palette-rows";
import { DiagnosticsSection } from "../../src/renderer/components/settings/DiagnosticsSection";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const LOGS = "2026-09-29T10:00:00Z info window shown\n2026-09-29T10:00:01Z warn key=[redacted] at ~/Library/x";
const CTX = { appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2", logs: LOGS };

let calls: { name: string; args: any }[] = [];
let listeners: Record<string, (p: unknown) => void> = {};
let ratings: Record<string, 1 | -1> = {};
beforeEach(() => {
  calls = [];
  listeners = {};
  ratings = {};
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (name: string, args: any) => {
        calls.push({ name, args });
        const count = () => ({ ratings, up: Object.values(ratings).filter((v) => v === 1).length, down: Object.values(ratings).filter((v) => v === -1).length });
        const result =
          name === "feedback.screenshot" ? { png: PNG }
          : name === "feedback.context" ? CTX
          : name === "feedback.send" ? { ok: true }
          : name === "ratings.get" ? count()
          : name === "ratings.set" ? (args.value ? (ratings[args.entryId] = args.value) : delete ratings[args.entryId], count())
          : name === "crashes.list" ? { reports: [{ id: "crash-1", at: 1, kind: "host-crash", message: "x", appVersion: "0.1.2", hostVersion: null, count: 1, seen: true }], unseen: 0 }
          : {};
        return { ok: true, result };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { listeners[ch] = cb; return () => {}; },
    },
  };
});
afterEach(() => { act(() => closeFeedback()); cleanup(); });

async function openSheet(preset: { type?: "bug"; crash?: string } = {}) {
  render(<FeedbackHost />);
  await act(async () => { await openFeedback(preset); });
  const dialog = await screen.findByRole("dialog", { name: preset.crash ? "Send a report" : "Send feedback" });
  await screen.findByText(/App 0\.1\.2 · macOS 15\.1\.0 · Mac14,2/);
  return dialog;
}
const sent = () => calls.filter((c) => c.name === "feedback.send");

describe("Send feedback sheet", () => {
  it("opens from the account menu, ⌘K and the Help menu", async () => {
    expect(accountMenuItems().some((i) => "label" in i && i.label === "Send feedback")).toBe(true);
    const row = typedRows({ bots: {}, pinned: [], currentBotId: null, theme: "light", actions: {} as never }, "feedback", []).find((r) => r.key === "feedback");
    expect(row?.title).toBe("Send feedback");
    render(<FeedbackHost />);
    await act(async () => { listeners["feedback"]!({}); await new Promise((r) => setTimeout(r, 0)); });
    expect(await screen.findByRole("dialog", { name: "Send feedback" })).toBeTruthy();
  });

  it("requires a type: nothing is sent without one", async () => {
    await openSheet();
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "The sidebar froze" } });
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a type.");
    fireEvent.click(screen.getByRole("button", { name: "Post on GitHub (public)" }));
    expect(sent()).toHaveLength(0);
    expect(calls.some((c) => c.name === "feedback.openIssue")).toBe(false);
  });

  it("the preview shows exactly what Send privately sends", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "  The sidebar froze\nafter a call  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include a screenshot of this window" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Attach logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "What will be sent" });
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    expect(await screen.findByText("Sent. Thank you.")).toBeTruthy();

    expect(sent()).toHaveLength(1);
    const payload = sent()[0]!.args as FeedbackPayload;
    expect(payload).toEqual(buildPayload({ type: "bug", message: "  The sidebar froze\nafter a call  ", includeLogs: true, includeScreenshot: true }, CTX, PNG));
    expect(Object.keys(payload).sort()).toEqual(["appVersion", "logs", "macos", "message", "model", "screenshot", "source", "type"]);
    // Every sent value is in the preview, whole.
    const text = preview.textContent!;
    for (const v of [payload.message, payload.appVersion, payload.macos, payload.model, payload.logs!]) expect(text).toContain(v);
    expect(text).toContain("Bug");
    expect(within(preview).getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${payload.screenshot}`);
  });

  it("sends no logs or screenshot unless ticked, and the preview says so", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "Dark dock icon" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "What will be sent" });
    expect(preview.textContent).toContain("No logs");
    expect(preview.textContent).toContain("No screenshot");
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    await screen.findByText("Sent. Thank you.");
    expect(sent()[0]!.args).toEqual({ source: "app", type: "idea", message: "Dark dock icon", appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2" });
  });

  it("Post on GitHub opens a prefilled new issue on the public repo", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Something confusing" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "Where is Settings?" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Attach logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Post on GitHub (public)" }));
    await vi.waitFor(() => expect(calls.some((c) => c.name === "feedback.openIssue")).toBe(true));
    const url = calls.find((c) => c.name === "feedback.openIssue")!.args.url as string;
    expect(url.startsWith(FEEDBACK_ISSUE_PREFIX)).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("title")).toBe("[Something confusing] Where is Settings?");
    expect(q.get("labels")).toBe("feedback");
    expect(q.get("body")).toContain("Where is Settings?");
    expect(q.get("body")).toContain("**App** 0.1.2 · **macOS** 15.1.0 · **Mac** Mac14,2");
    expect(q.get("body")).toContain(LOGS);
    expect(sent()).toHaveLength(0);
  });
});

describe("githubIssueUrl", () => {
  const base: FeedbackPayload = { source: "app", type: "bug", message: "Crashed on launch", appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2" };
  it("cuts the oldest log lines to stay under GitHub's link limit, and says so", () => {
    const logs = Array.from({ length: 300 }, (_, i) => `2026-09-29 line-${String(i).padStart(3, "0")} ${"z".repeat(80)}`).join("\n");
    const { url, logsCut } = githubIssueUrl({ ...base, logs });
    expect(url.length).toBeLessThanOrEqual(FEEDBACK_MAX_ISSUE_URL);
    expect(logsCut).toBe(true);
    const body = new URL(url).searchParams.get("body")!;
    expect(body).toContain("line-299");
    expect(body).not.toContain("line-000");
    expect(body).toContain("logs cut to fit the link");
  });
  it("never includes the screenshot, and says so", () => {
    const { url } = githubIssueUrl({ ...base, screenshot: PNG });
    expect(url).not.toContain(encodeURIComponent(PNG.slice(0, 20)));
    expect(new URL(url).searchParams.get("body")).toContain("A screenshot isn't included");
  });
  it("fits even a 5,000-character message", () => {
    const { url } = githubIssueUrl({ ...base, message: "ü".repeat(5000) });
    expect(url.length).toBeLessThanOrEqual(FEEDBACK_MAX_ISSUE_URL);
  });
  it("fences logs so backticks inside can't break out", () => {
    const body = new URL(githubIssueUrl({ ...base, logs: "a ``` b" }).url).searchParams.get("body")!;
    expect(body).toContain("````text\na ``` b\n````");
  });
});

describe("Send a report after a crash", () => {
  it("Diagnostics offers Send a report, which opens the sheet with that report as the logs, ticked", async () => {
    render(<><DiagnosticsSection /><FeedbackHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Send a report" }));
    expect(await screen.findByRole("dialog", { name: "Send a report" })).toBeTruthy();
    await vi.waitFor(() => expect(calls.find((c) => c.name === "feedback.context")?.args).toEqual({ crash: "crash-1" }));
    expect((screen.getByRole("checkbox", { name: "Attach logs" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "Bug" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("👍/👎 (local only)", () => {
  it("rates a reply, toggles it off, and the Bot's settings show the counts", async () => {
    render(<><RateButtons botId="nova" entryId="e1" kind="reply" /><RatingsRow botId="nova" /></>);
    const up = screen.getByRole("button", { name: "Good" });
    fireEvent.click(up);
    await vi.waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("👍 1 · 👎 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bad" }));
    await vi.waitFor(() => expect(screen.getByText("👍 0 · 👎 1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Bad" }));
    await vi.waitFor(() => expect(screen.getByText("👍 0 · 👎 0")).toBeTruthy());
    expect(calls.filter((c) => c.name.startsWith("feedback."))).toHaveLength(0);
    expect(calls.filter((c) => c.name === "ratings.set").map((c) => c.args)).toEqual([
      { botId: "nova", entryId: "e1", kind: "reply", value: 1 },
      { botId: "nova", entryId: "e1", kind: "reply", value: -1 },
      { botId: "nova", entryId: "e1", kind: "reply", value: 0 },
    ]);
  });
});

describe("review round 1", () => {
  it("Send a report: the crash logs in the preview match the payload byte for byte", async () => {
    await openSheet({ type: "bug", crash: "latest" });
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "It crashed" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const shown = within(screen.getByRole("region", { name: "What will be sent" })).getByText((_, el) => el?.tagName === "PRE").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    await screen.findByText("Sent. Thank you.");
    const sentLogs = sent()[0]!.args.logs as string;
    expect(Buffer.from(shown!, "utf8").equals(Buffer.from(sentLogs, "utf8"))).toBe(true);
    expect(sentLogs).toBe(LOGS);
    expect(calls.find((c) => c.name === "feedback.context")!.args).toEqual({ crash: "latest" });
  });

  it("hides personal details and hidden characters in the preview and the payload alike", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "Call 555-123-4567 about it\u200B" } });
    expect(screen.getByText("Hidden before sending: 1 phone number")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "What will be sent" });
    expect(preview.textContent).toContain("Call [phone] about it");
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    await screen.findByText("Sent. Thank you.");
    expect(sent()[0]!.args.message).toBe("Call [phone] about it");
  });

  it("a click on the screenshot thumbnail shows it full size", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include a screenshot of this window" }));
    fireEvent.click(screen.getByRole("button", { name: "Show screenshot" }));
    const big = await screen.findByRole("dialog", { name: "Screenshot" });
    expect(within(big).getByRole("img", { name: "Screenshot" }).getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    fireEvent.click(within(big).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Screenshot" })).toBeNull();
  });

  it("says why before sending when a message would be refused as spam, and doesn't send it", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("radio", { name: "Idea" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "Buy followers now https://a.test https://b.test https://c.test https://d.test" } });
    expect(screen.getByText("This looks like spam, so it won't be sent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send privately" }));
    expect(sent()).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "What's on your mind?" }), { target: { value: "AirDrop to my iPhone doesn't work" } });
    expect(screen.queryByText("This looks like spam, so it won't be sent.")).toBeNull();
  });
});
