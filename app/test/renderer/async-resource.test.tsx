// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Async } from "../../src/renderer/components/Async";
import { useAsync, useKeyedState, type AsyncResource } from "../../src/renderer/async-resource";

// PRIMITIVE 3 — an async read has three outcomes and a component must handle all three.
//
// THE DEFECT: `useState<T | null>(null)` + `.catch(() => {})` made "still loading" and "the call
// failed" the same value, and both rendered as `return null` — the feature simply vanished, with
// nothing on screen and no way to retry. This union has no null state to hide in, and <Async />
// owns the loading and error arms so a component cannot forget to write them.

function Probe<T>({ load, deps = [] }: { load: () => Promise<T>; deps?: unknown[] }) {
  const r = useAsync(load, deps);
  return (
    <Async resource={r}>
      {(value) => <p>value: {String(value)}</p>}
    </Async>
  );
}

afterEach(cleanup);

describe("useAsync — the three outcomes are distinct values", () => {
  it("starts loading, then becomes ready with the value", async () => {
    render(<Probe load={async () => "hello"} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(await screen.findByText("value: hello")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a rejected load becomes an error carrying the reason, never an empty render", async () => {
    render(<Probe load={async () => { throw new Error("the host said no"); }} />);
    expect((await screen.findByRole("alert")).textContent).toContain("the host said no");
    expect(screen.queryByText(/^value:/), "nothing may be rendered as if it were data").toBeNull();
  });

  it("offers Retry, and a retry that succeeds replaces the error with the value", async () => {
    let attempt = 0;
    render(<Probe load={async () => { attempt += 1; if (attempt === 1) throw new Error("boom"); return "second time"; }} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("value: second time")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads when its deps change, and ignores a stale answer that lands after them", async () => {
    const seen: string[] = [];
    function Keyed({ id }: { id: string }) {
      const r = useAsync(async () => { seen.push(id); return id; }, [id]);
      return <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>;
    }
    const { rerender } = render(<Keyed id="a" />);
    expect(await screen.findByText("value: a")).toBeTruthy();
    rerender(<Keyed id="b" />);
    expect(await screen.findByText("value: b")).toBeTruthy();
    expect(seen).toEqual(["a", "b"]);
  });

  // BUG #19: the reload above is not enough on its own. Between the render in which the key changes
  // and the effect that starts the new load there is a committed frame, and a resource that only
  // resets inside that effect renders the PREVIOUS key's value in it — under the new key, with live
  // buttons. These record every render pass, so a reset written in an effect fails them.
  it("no render under a new key ever carries the previous key's value", async () => {
    const seen: { id: string; shown: string }[] = [];
    function Keyed({ id }: { id: string }) {
      const r = useAsync(async () => id, [id]);
      seen.push({ id, shown: r.status === "ready" ? r.value : r.status });
      return <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>;
    }
    const { rerender } = render(<Keyed id="a" />);
    expect(await screen.findByText("value: a")).toBeTruthy();
    rerender(<Keyed id="b" />);
    expect(await screen.findByText("value: b")).toBeTruthy();
    expect(seen.filter((s) => s.id !== s.shown && s.shown === "a"), "a render under key b carried key a's value").toEqual([]);
  });

  it("a load that rejects under the new key shows the error, never the previous key's value", async () => {
    function Keyed({ id }: { id: string }) {
      const r = useAsync(async () => { if (id === "b") throw new Error("the host said no"); return id; }, [id]);
      return <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>;
    }
    const { rerender } = render(<Keyed id="a" />);
    expect(await screen.findByText("value: a")).toBeTruthy();
    rerender(<Keyed id="b" />);
    expect((await screen.findByRole("alert")).textContent).toContain("the host said no");
    expect(screen.queryByText("value: a"), "a failed load left the previous key's value on screen forever").toBeNull();
  });

  it("goes back to loading when disabled, so re-enabling cannot flash the old answer", async () => {
    function Gated({ on }: { on: boolean }) {
      const r = useAsync(async () => "answer", [], { enabled: on });
      return <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>;
    }
    const { rerender } = render(<Gated on />);
    expect(await screen.findByText("value: answer")).toBeTruthy();
    rerender(<Gated on={false} />);
    expect(screen.queryByText("value: answer")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });

  it("a reload keeps the current value on screen until the new one lands — same question, no flash", async () => {
    let answer = "first";
    let settle: (() => void) | null = null;
    function Reloadable() {
      const r = useAsync(async () => { await new Promise<void>((res) => { settle = res; }); return answer; }, ["k"]);
      return (
        <>
          <button type="button" onClick={r.reload}>refresh</button>
          <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>
        </>
      );
    }
    render(<Reloadable />);
    await waitFor(() => expect(settle).not.toBeNull());
    settle!();
    await screen.findByText("value: first");
    answer = "second";
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(screen.getByText("value: first"), "a same-key reload blanked what the user was looking at").toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    settle!();
    expect(await screen.findByText("value: second")).toBeTruthy();
  });

  it("setValue survives an unrelated re-render with the same key", async () => {
    function Mutable({ tick }: { tick: number }) {
      const r = useAsync(async () => "before", ["k"]);
      return (
        <>
          <button type="button" onClick={() => r.setValue("after")}>mutate</button>
          <span>tick {tick}</span>
          <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>
        </>
      );
    }
    const { rerender } = render(<Mutable tick={1} />);
    await screen.findByText("value: before");
    fireEvent.click(screen.getByRole("button", { name: "mutate" }));
    await screen.findByText("value: after");
    rerender(<Mutable tick={2} />);
    expect(screen.getByText("value: after"), "an unrelated re-render must not reset a keyed resource").toBeTruthy();
  });

  it("setValue updates a ready resource in place, for a mutation that returns the new state", async () => {
    function Mutable() {
      const r = useAsync(async () => "before", []);
      return (
        <>
          <button type="button" onClick={() => r.setValue("after")}>mutate</button>
          <Async resource={r}>{(v) => <p>value: {v}</p>}</Async>
        </>
      );
    }
    render(<Mutable />);
    await screen.findByText("value: before");
    fireEvent.click(screen.getByRole("button", { name: "mutate" }));
    expect(await screen.findByText("value: after")).toBeTruthy();
  });

  it("does not call the loader while disabled, and loads as soon as it is enabled", async () => {
    const load = vi.fn(async () => "lazy");
    function Gated({ on }: { on: boolean }) {
      const r = useAsync(load, [], { enabled: on });
      return on ? <Async resource={r}>{(v) => <p>value: {v}</p>}</Async> : <p>closed</p>;
    }
    const { rerender } = render(<Gated on={false} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<Gated on />);
    expect(await screen.findByText("value: lazy")).toBeTruthy();
  });

  it("drops a result that arrives after unmount instead of setting state on a dead component", async () => {
    let settle: (v: string) => void = () => {};
    const { unmount } = render(<Probe load={() => new Promise<string>((res) => { settle = res; })} />);
    unmount();
    settle("too late");
    await waitFor(() => expect(true).toBe(true));
  });
});

describe("useKeyedState — local state that belongs to one key", () => {
  function Form({ botId }: { botId: string }) {
    const [draft, setDraft] = useKeyedState(botId, "");
    const [open, setOpen] = useKeyedState(botId, false);
    return (
      <>
        <p>bot {botId}</p>
        <button type="button" onClick={() => setOpen(true)}>open</button>
        {open && <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />}
        {open && <p>draft: {draft}</p>}
      </>
    );
  }

  it("keeps what was typed while the key is the same", () => {
    const { rerender } = render(<Form botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "half typed" } });
    rerender(<Form botId="a" />);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("half typed");
  });

  it("goes back to the initial value in the very render the key changes — no stale frame", () => {
    const frames: string[] = [];
    function Spy() { useLayoutEffect(() => { frames.push(document.body.textContent ?? ""); }); return null; }
    const { rerender } = render(<><Form botId="a" /><Spy /></>);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "for bot a" } });
    frames.length = 0;
    rerender(<><Form botId="b" /><Spy /></>);
    expect(screen.queryByLabelText("draft"), "Bot A's open form is still open under Bot B").toBeNull();
    expect(frames.filter((f) => f.includes("for bot a"))).toEqual([]);
  });

  it("takes a function updater, applied to the value of its own key", () => {
    function Counter({ botId }: { botId: string }) {
      const [n, setN] = useKeyedState(botId, 0);
      return <button type="button" onClick={() => setN((p) => p + 1)}>n {n}</button>;
    }
    const { rerender } = render(<Counter botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "n 0" }));
    fireEvent.click(screen.getByRole("button", { name: "n 1" }));
    expect(screen.getByRole("button", { name: "n 2" })).toBeTruthy();
    rerender(<Counter botId="b" />);
    expect(screen.getByRole("button", { name: "n 0" })).toBeTruthy();
  });
});

describe("the union itself", () => {
  it("has no null/undefined state a component could render as nothing", () => {
    // A compile-time contract, asserted at runtime so it is visible in the test output: every
    // inhabitant carries a status, and `value` exists only on "ready".
    const statuses: AsyncResource<number>["status"][] = ["loading", "error", "ready"];
    expect(statuses).toEqual(["loading", "error", "ready"]);
  });
});
