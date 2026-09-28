// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../src/renderer/components/ErrorBoundary";
import { readSrc } from "./read-src";

// PRIMITIVE 1 — a render throw must degrade to a panel, never to a white window.
//
// main.tsx renders <App /> bare, so today ANY throw in ANY component unmounts the whole tree:
// React 19 unmounts the root when no boundary catches, and what is left on screen is an empty
// <div id="root">. The only way out is quitting the app. These tests render a component that
// throws and assert the window survives with something the user can act on.

/** A child that throws on render until it is told not to. */
function Boom({ throws }: { throws: boolean }): ReactElement {
  if (throws) throw new Error("kaboom from a child");
  return <p>child rendered fine</p>;
}

/** Stands in for App's chrome: proves the boundary replaces the tree rather than leaving it blank. */
function Chrome({ throws }: { throws: boolean }) {
  return (
    <div className="window">
      <ErrorBoundary>
        <Boom throws={throws} />
      </ErrorBoundary>
    </div>
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs every caught error; the boundary's own componentDidCatch logs too. Neither is the
  // thing under test, and both would bury the real assertion output.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

describe("the defect this replaces", () => {
  it("an unboundaried throw empties the root container — the white window", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    // React 19 unmounts the whole tree when a render throw reaches the root and re-throws.
    expect(() => act(() => root.render(<Boom throws />))).toThrow(/kaboom/);
    expect(container.textContent, "nothing is left on screen but an empty root").toBe("");
    act(() => root.unmount());
    container.remove();
  });
});

describe("ErrorBoundary — a render throw degrades to a panel", () => {
  it("keeps the window mounted and shows an alert instead of a blank root", () => {
    const { container } = render(<Chrome throws />);
    expect(container.querySelector(".window"), "the window chrome must survive the throw").not.toBeNull();
    expect(container.textContent!.trim().length, "a blank window is the bug this replaces").toBeGreaterThan(0);
    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("Something went wrong");
  });

  it("says what happened, quoting the error's own message", () => {
    render(<Chrome throws />);
    expect(screen.getByRole("alert").textContent).toContain("kaboom from a child");
  });

  it("offers a way back: Try again re-renders the subtree, Reload restarts the renderer", () => {
    render(<Chrome throws />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("Try again re-mounts the children, so a transient throw is recoverable without a reload", () => {
    function Flaky() {
      const [throws, setThrows] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setThrows(false)}>heal</button>
          <ErrorBoundary>
            <Boom throws={throws} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Flaky />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "heal" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("child rendered fine")).toBeTruthy();
  });

  it("Reload reloads the renderer window", () => {
    const reload = vi.fn();
    // jsdom forbids redefining window.location.reload, so the boundary takes its reloader as an
    // optional prop that defaults to window.location.reload() — the seam is part of the design,
    // not a test-only escape hatch.
    render(
      <ErrorBoundary onReload={reload}>
        <Boom throws />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalled();
  });

  it("renders nothing of its own while the children are healthy", () => {
    render(<Chrome throws={false} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("child rendered fine")).toBeTruthy();
  });
});

describe("ErrorBoundary — it is actually installed at the root", () => {
  it("main.tsx wraps <App /> in the boundary (a boundary nobody mounts catches nothing)", () => {
    const src = readSrc("main.tsx");
    expect(src).toMatch(/import \{ ErrorBoundary \} from "\.\/components\/ErrorBoundary"/);
    expect(src).toMatch(/<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/);
  });
});
