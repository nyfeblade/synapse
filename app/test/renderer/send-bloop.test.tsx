// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";
import { Transcript } from "../../src/renderer/components/Transcript";
import { useComposer } from "../../src/renderer/composer-store";
import { MSG_USER_ENTER_MS } from "../../src/renderer/motion";
import { usePendingSends } from "../../src/renderer/pending-sends";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge } from "./fake-bridge";

// THE BLOOP (decisions.md, "send bloop"; replaces the liquid send's flight at the user's ask). On
// Enter the message's bubble is in the transcript at once, in its final place, and the composer is
// empty; the host's entry (same clientNonce) replaces it on the same node; a failed send leaves no
// bubble and puts the message back; the Bot's dots wait for the bloop to settle.

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Piper", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});
const userMsg = (id: string, content: string, clientNonce?: string): TranscriptEntry =>
  ({ kind: "message", id, role: "user", content, createdAt: Date.now(), ...(clientNonce ? { clientNonce } : {}) }) as TranscriptEntry;

type Pending = { args: { text: string; clientNonce: string; attachmentIds?: string[] }; resolve: (v: unknown) => void };
let sends: Pending[] = [];

beforeEach(() => {
  installFakeBridge();
  const base = (window as unknown as { synapse: { call: (c: string, a: unknown) => Promise<unknown> } }).synapse.call;
  (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn((cmd: string, args: Pending["args"]) => {
    if (cmd !== "sendPrompt") return base(cmd, args);
    return new Promise((resolve) => { sends.push({ args, resolve }); });
  });
  sends = [];
  Element.prototype.scrollIntoView = vi.fn();
  useComposer.setState({ byBot: {} });
  usePendingSends.setState({ byBot: {} });
  try { localStorage.clear(); } catch { /* storage unavailable */ }
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" }, bots: { a: bot() }, transcripts: { a: [userMsg("u0", "earlier")] } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const view = () => render(<><Transcript botId="a" /><Composer botId="a" name="Piper" running={false} /></>);
const type = (text: string) => {
  const box = screen.getByRole("textbox", { name: "Message Piper" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
};
const userRows = () => [...document.querySelectorAll<HTMLElement>(".msg.user")];
const land = (...entries: TranscriptEntry[]) => act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [...s.transcripts.a!, ...entries] } })); });

describe("the send bloop", () => {
  it("the bubble is on screen at Enter, before the call answers, and the composer is already empty", () => {
    view();
    const box = type("hi there");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sends).toHaveLength(1);
    expect(box.value, "cleared at once: nothing is held").toBe("");
    const rows = userRows();
    expect(rows.at(-1)!.textContent).toContain("hi there");
    expect(rows.at(-1)!.classList.contains("is-new"), "it plays the bloop entrance").toBe(true);
    expect(rows.at(-1)!.id).toMatch(/^entry-pending-/);
  });

  it("the host's entry replaces the optimistic one on the SAME node: no duplicate, no remount", async () => {
    view();
    fireEvent.keyDown(type("hello"), { key: "Enter" });
    const optimistic = userRows().at(-1)!;
    const nonce = sends[0]!.args.clientNonce;
    await act(async () => { sends[0]!.resolve({ ok: true, result: { entryId: "u1" } }); });
    expect(userRows().at(-1), "still the optimistic row until the entry lands").toBe(optimistic);
    land(userMsg("u1", "hello", nonce));
    const rows = userRows().filter((r) => r.textContent?.includes("hello"));
    expect(rows, "exactly one bubble for the message").toHaveLength(1);
    expect(rows[0], "the same DOM node (no remount, so no second bloop)").toBe(optimistic);
    expect(rows[0]!.id).toBe("entry-u1");
    expect(rows[0]!.classList.contains("is-new"), "the entrance class never drops mid-bloop").toBe(true);
    await waitFor(() => expect(usePendingSends.getState().byBot.a ?? []).toHaveLength(0));
  });

  it("the entry landing BEFORE the call answers (and with the reply in the same commit) is still one bubble", () => {
    view();
    fireEvent.keyDown(type("quick one"), { key: "Enter" });
    const optimistic = userRows().at(-1)!;
    const botMsg = { kind: "message", id: "b1", role: "assistant", content: "On it.", createdAt: Date.now() } as TranscriptEntry;
    land(userMsg("u1", "quick one", sends[0]!.args.clientNonce), botMsg);
    expect(userRows().filter((r) => r.textContent?.includes("quick one"))).toEqual([optimistic]);
  });

  it("a failed send leaves no bubble, puts the message back and shows the existing error", async () => {
    view();
    const ref = { attachmentId: "abc.md", name: "notes.md", size: 5, mime: "text/markdown", storePath: "/s/abc.md", boxPath: "/workspace/uploads/notes.md" };
    act(() => useComposer.getState().upsertAttachment("a", { uploadId: "up1", name: "notes.md", size: 5, mime: "text/markdown", progress: 1, ref, error: null }));
    const box = type("will fail");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(userRows().some((r) => r.textContent?.includes("will fail"))).toBe(true);
    expect(useComposer.getState().byBot.a?.attachments ?? []).toHaveLength(0);
    await act(async () => { sends[0]!.resolve({ ok: false, error: { code: "AGENT_BUSY", message: "The Bot is busy." } }); });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(userRows().some((r) => r.textContent?.includes("will fail")), "no ghost bubble").toBe(false);
    expect(box.value, "the text is back to retry").toBe("will fail");
    expect(useComposer.getState().byBot.a?.attachments.map((x) => x.uploadId), "and its file").toEqual(["up1"]);
  });

  it("double sends each bloop: the second is not blocked by the first's call and lands below it", () => {
    view();
    fireEvent.keyDown(type("one"), { key: "Enter" });
    fireEvent.keyDown(type("two"), { key: "Enter" });
    expect(sends.map((s) => s.args.text)).toEqual(["one", "two"]);
    const rows = userRows().slice(-2);
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("one"), expect.stringContaining("two")]);
    expect(rows.every((r) => r.classList.contains("is-new"))).toBe(true);
  });

  it("a second Enter on the same (already sent) text sends nothing", () => {
    view();
    const box = type("once");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sends).toHaveLength(1);
    expect(userRows().filter((r) => r.textContent?.includes("once"))).toHaveLength(1);
  });

  it("the Bot's typing dots wait for the send glide to settle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    view();
    fireEvent.keyDown(type("question"), { key: "Enter" });
    act(() => { useUi.setState((s) => ({ bots: { ...s.bots, a: bot({ presence: "thinking" }) } })); });
    expect(document.querySelector(".bubble.bot.typing"), "not beside a bubble still forming").toBeNull();
    act(() => { vi.advanceTimersByTime(MSG_USER_ENTER_MS); });
    expect(document.querySelector(".bubble.bot.typing"), "once it has settled, the Bot is typing").not.toBeNull();
  });

  it("a send queued behind an uploading file shows its bubble when the queued send fires, not before", async () => {
    view();
    const pending = { uploadId: "up1", name: "notes.md", size: 5, mime: "text/markdown", progress: 0, ref: null, error: null };
    act(() => useComposer.getState().upsertAttachment("a", pending));
    fireEvent.keyDown(type("with file"), { key: "Enter" });
    expect(sends).toHaveLength(0);
    expect(userRows().some((r) => r.textContent?.includes("with file")), "nothing sent yet, so no bubble").toBe(false);
    const ref = { attachmentId: "abc.md", name: "notes.md", size: 5, mime: "text/markdown", storePath: "/s/abc.md", boxPath: "/workspace/uploads/notes.md" };
    act(() => useComposer.getState().upsertAttachment("a", { ...pending, progress: 1, ref }));
    await waitFor(() => expect(sends).toHaveLength(1));
    const row = userRows().at(-1)!;
    expect(row.textContent).toContain("with file");
    expect(row.querySelector(".file-card.user"), "its file bloops with it, inside the same row").not.toBeNull();
  });
});
