import { afterEach } from "vitest";

// Fix round 1 (docs/sdd, 2026-09-23): the menu's and the panel's exit fades run on a DETACHED clone,
// appended straight to `document.body` rather than into whatever tree `render()` mounted — on
// purpose, so a `position: fixed` menu's screen position can never be hijacked by a transformed
// ancestor. That means testing-library's own `cleanup()` never sees it: `cleanup()` only tears down
// the React root it created, and a clone living beside it in `document.body` is invisible to it. A
// clone a test never advanced past (no fake-timer tick, no manual `animationEnd`) is real DOM litter:
// it still matches text/role-agnostic queries like `getByText`, and it leaks into the NEXT test in the
// same file, which is exactly the "multiple elements found" failure this setup file exists to
// prevent. One global sweep after every test, rather than teaching each affected test file about a
// mechanism it has no reason to know exists.
afterEach(() => {
  // This setup file loads for every test file in the project, including plain-node ones (the voice
  // chunker, window-drag) that never touch `document` at all.
  if (typeof document === "undefined") return;
  document.querySelectorAll(".leaving").forEach((n) => n.remove());
});
