// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { AdvancedSection } from "../../src/renderer/components/AdvancedSection";
import { SecretsSection } from "../../src/renderer/components/SecretsSection";
import { BotAvatar } from "../../src/renderer/avatar/BotAvatar";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

// BUG #19 — STALE DATA FROM THE PREVIOUS BOT.
//
// The class: async data keyed by an id, held in component state, never reset when the id changes.
// Switching Bot A -> Bot B left A's context meter and A's *secret names* (with live Replace/Remove
// buttons) on screen under B's id — forever if B's fetch failed, since a rejected fetch left the
// previous value untouched.
//
// "Not on screen after the switch settles" is too weak a bar: a reset written in a `useEffect`
// satisfies it while still committing one frame of A's data to the DOM under B's id, and that frame
// is clickable. So every test here snapshots the DOM in a `useLayoutEffect` — which React runs after
// the DOM is mutated and BEFORE passive effects and before paint — and asserts that no committed
// frame after the switch ever contained A's data.

/**
 * Records the committed DOM on every commit — after React has mutated it and BEFORE paint and
 * before any useEffect runs. innerHTML rather than textContent so an `img src` counts as "on
 * screen" too.
 */
function CommitSpy({ into }: { into: string[] }) {
  useLayoutEffect(() => { into.push(document.body.innerHTML); });
  return null;
}

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ctxFor = (ratio: number) => ({ ctxTokens: Math.round(200_000 * ratio), window: 200_000, ratio, compactionEpoch: 1, compactions: 1, sessionBytes: 1 });
const METER_A = STR.contextMeter(42, "84k", "200k");
const METER_B = STR.contextMeter(10, "20k", "200k");

afterEach(cleanup);

describe("AdvancedSection: the context meter belongs to the Bot on screen", () => {
  let pending: Map<string, Deferred<unknown>>;
  beforeEach(() => {
    pending = new Map();
    installFakeBridge({
      getAgentContext: ((args: { id: string }) => {
        const d = deferred<unknown>();
        pending.set(args.id, d);
        return d.promise;
      }) as never,
    });
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true }, bots: {}, actionError: null } as never);
  });

  it("drops Bot A's meter the moment the id changes, and never shows it while Bot B loads", async () => {
    const frames: string[] = [];
    const { rerender } = render(<><AdvancedSection botId="a" /><CommitSpy into={frames} /></>);
    pending.get("a")!.resolve(ctxFor(0.42));
    expect(await screen.findByText(METER_A)).toBeTruthy();

    frames.length = 0;
    rerender(<><AdvancedSection botId="b" /><CommitSpy into={frames} /></>);

    expect(screen.queryByText(METER_A), "Bot A's meter is still on screen under Bot B's id").toBeNull();
    expect(frames.filter((f) => f.includes(METER_A)), "Bot A's meter was committed to the DOM under Bot B's id").toEqual([]);

    pending.get("b")!.resolve(ctxFor(0.1));
    expect(await screen.findByText(METER_B)).toBeTruthy();
  });

  it("keeps Bot A's meter off screen when Bot B's fetch rejects (the forever case)", async () => {
    const frames: string[] = [];
    const { rerender } = render(<><AdvancedSection botId="a" /><CommitSpy into={frames} /></>);
    pending.get("a")!.resolve(ctxFor(0.42));
    expect(await screen.findByText(METER_A)).toBeTruthy();

    frames.length = 0;
    rerender(<><AdvancedSection botId="b" /><CommitSpy into={frames} /></>);
    pending.get("b")!.reject(new Error("the host said no"));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText(METER_A), "a failed fetch for Bot B left Bot A's meter on screen forever").toBeNull();
    expect(frames.filter((f) => f.includes(METER_A))).toEqual([]);
  });
});

describe("SecretsSection: the secret list belongs to the Bot on screen", () => {
  let pending: Map<string, Deferred<{ name: string; description: string; updatedAt: number }[]>>;
  let api: { list: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    pending = new Map();
    api = {
      list: vi.fn((botId: string) => {
        const d = deferred<{ name: string; description: string; updatedAt: number }[]>();
        pending.set(botId, d);
        return d.promise;
      }),
      save: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
  });

  const rowsA = [{ name: "A_ONLY_STRIPE_KEY", description: "Bot A's key", updatedAt: Date.now() }];
  const rowsB = [{ name: "B_ONLY_OPENAI_KEY", description: "Bot B's key", updatedAt: Date.now() }];

  it("drops Bot A's secret names the moment the id changes, and never shows them while Bot B loads", async () => {
    const frames: string[] = [];
    const { rerender } = render(<><SecretsSection botId="a" /><CommitSpy into={frames} /></>);
    pending.get("a")!.resolve(rowsA);
    expect(await screen.findByText("A_ONLY_STRIPE_KEY")).toBeTruthy();

    frames.length = 0;
    rerender(<><SecretsSection botId="b" /><CommitSpy into={frames} /></>);

    expect(screen.queryByText("A_ONLY_STRIPE_KEY"), "Bot A's secret name is on screen under Bot B's id").toBeNull();
    expect(frames.filter((f) => f.includes("A_ONLY_STRIPE_KEY")), "Bot A's secret name was committed to the DOM under Bot B's id").toEqual([]);
    expect(screen.queryAllByRole("button", { name: "Replace" }), "a live Replace button during the switch window").toEqual([]);
    expect(screen.queryAllByRole("button", { name: "Remove" }), "a live Remove button during the switch window").toEqual([]);

    pending.get("b")!.resolve(rowsB);
    expect(await screen.findByText("B_ONLY_OPENAI_KEY")).toBeTruthy();
    expect(screen.queryByText("A_ONLY_STRIPE_KEY")).toBeNull();
  });

  it("keeps Bot A's secret names off screen when Bot B's list rejects", async () => {
    const frames: string[] = [];
    const { rerender } = render(<><SecretsSection botId="a" /><CommitSpy into={frames} /></>);
    pending.get("a")!.resolve(rowsA);
    expect(await screen.findByText("A_ONLY_STRIPE_KEY")).toBeTruthy();

    frames.length = 0;
    rerender(<><SecretsSection botId="b" /><CommitSpy into={frames} /></>);
    pending.get("b")!.reject(new Error("vault locked"));

    expect(await screen.findByText("vault locked")).toBeTruthy();
    expect(screen.queryByText("A_ONLY_STRIPE_KEY"), "a failed list for Bot B left Bot A's secret names on screen").toBeNull();
    expect(frames.filter((f) => f.includes("A_ONLY_STRIPE_KEY"))).toEqual([]);
  });

  // THE HAZARD. Every row's Replace/Remove closes over the CURRENT `botId` prop, not the id the row
  // was fetched with — so a row left over from Bot A wrote to Bot B. `vault.upsert` creates on an
  // unknown name (app/src/main/secret-vault.ts:41), so Replace during the window silently CREATED a
  // secret on Bot B named after Bot A's, holding the value the user meant for A.
  it("never offers a control that would write Bot A's secret name to Bot B", async () => {
    const { rerender } = render(<SecretsSection botId="a" />);
    pending.get("a")!.resolve(rowsA);
    expect(await screen.findByText("A_ONLY_STRIPE_KEY")).toBeTruthy();

    rerender(<SecretsSection botId="b" />);
    expect(screen.queryByText("A_ONLY_STRIPE_KEY")).toBeNull();

    pending.get("b")!.resolve(rowsB);
    expect(await screen.findByText("B_ONLY_OPENAI_KEY")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "value-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace value" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0]?.slice(0, 2), "a write must name the Bot whose list it was clicked in").toEqual(["b", "B_ONLY_OPENAI_KEY"]);
  });

  it("does not carry a half-typed secret value from Bot A into Bot B's form", async () => {
    const { rerender } = render(<SecretsSection botId="a" />);
    pending.get("a")!.resolve(rowsA);
    expect(await screen.findByText("A_ONLY_STRIPE_KEY")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "DRAFT_FOR_A" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "value-for-bot-a" } });

    rerender(<SecretsSection botId="b" />);
    pending.get("b")!.resolve(rowsB);
    await screen.findByText("B_ONLY_OPENAI_KEY");
    expect(screen.queryByLabelText("Value"), "Bot A's half-typed secret value is sitting in Bot B's form").toBeNull();
    expect(document.body.textContent).not.toContain("DRAFT_FOR_A");
  });
});

describe("BotAvatar: the picture belongs to the Bot on screen", () => {
  let pending: Map<string, Deferred<{ mime: string; bytesBase64: string }>>;
  beforeEach(() => {
    pending = new Map();
    installFakeBridge({
      getAgentAvatar: ((args: { id: string }) => {
        const d = deferred<{ mime: string; bytesBase64: string }>();
        pending.set(args.id, d);
        return d.promise;
      }) as never,
    });
  });

  const imageBot = (id: string) => {
    const b = botFixture(id, id.toUpperCase());
    return { ...b, profile: { ...b.profile, avatarKind: "image" as const, avatarVersion: 1 } };
  };

  it("drops Bot A's picture the moment the Bot changes, and never shows it as Bot B", async () => {
    const frames: string[] = [];
    const a = imageBot("avatar-a");
    const b = imageBot("avatar-b");
    const { rerender, container } = render(<><BotAvatar bot={a} size={32} /><CommitSpy into={frames} /></>);
    pending.get("avatar-a")!.resolve({ mime: "image/png", bytesBase64: "AAAA" });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("AAAA"));

    frames.length = 0;
    rerender(<><BotAvatar bot={b} size={32} /><CommitSpy into={frames} /></>);
    expect(container.querySelector("img")?.getAttribute("src") ?? "", "Bot A's picture is being shown as Bot B").not.toContain("AAAA");
    expect(frames.filter((f) => f.includes("AAAA")), "Bot A's picture was committed to the DOM as Bot B's").toEqual([]);

    pending.get("avatar-b")!.resolve({ mime: "image/png", bytesBase64: "BBBB" });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("BBBB"));
  });
});
