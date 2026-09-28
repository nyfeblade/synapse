import { test as base, expect, type ElectronApplication, type Page } from "@playwright/test";
import { NO_STEP, PageErrors, register, settleAll } from "./page-error-sink";

export { PageErrors } from "./page-error-sink";

/**
 * A page error raised during an e2e journey fails that journey — BY DEFAULT, with no line in the
 * spec saying so.
 *
 * WHY THE DEFAULT LIVES HERE AND NOT AT THE CALL SITES (bug 14). `launch()` used to hand every spec
 * an `errors: string[]`, and a spec was free to take it and never look at it: four Phase 1
 * journeys, two Phase 5 journeys and the whole a11y sweep collected renderer crashes into an array
 * and threw the array away. Four more specs never collected them at all. An unasserted requirement
 * is not a requirement.
 *
 * The specs that DID assert had the subtler half of the same defect. `expect(errors).toEqual([])`
 * on the last line of a 60-step journey only runs if the journey reaches the last line. The moment
 * the app fails QUIETLY — a render throw that leaves a control unclickable — the journey dies at a
 * locator timeout thirty steps earlier and the error assertion never executes. It caught the loud
 * failures and missed exactly the quiet ones; and when it did fire it named a whole journey rather
 * than an action. That is the shape of this build's third green-suite escape (bug 27: a packaged
 * app that never drew a window reported success six times, because the check meant to catch it
 * asked the wrong question at the wrong moment).
 *
 * So the verdict moved into fixture teardown, which runs whether the body passed, failed or timed
 * out, and it is keyed to the WINDOW rather than to a variable a spec has to remember. Forgetting
 * is now the safe behaviour, and a spec added tomorrow is covered without its author knowing this
 * file exists. It is the same trade `src/renderer/bridge.ts` makes for gateway writes: `call()`
 * reports by default, and silence costs a visible `callQuiet()`.
 *
 * Deliberate silence here is `.expect(pattern, why)` on the handle `launch()` returns — one line,
 * in the journey that provokes the error, naming the error and the reason. It is not a mute button:
 * a declared expectation must MATCH SOMETHING, so a journey that stops provoking the error it was
 * excused for fails as well.
 */

const SURFACE_TIMEOUT_MS = 2000;

/** The action in flight, set by `step()`. A journey that declares no steps still gets a verdict; it
 *  just gets "(no step declared)" where the action's name would be. */
let currentStep: string = NO_STEP;

/** True only while a test that imported THIS `test` is running. `watchPageErrors` refuses to attach
 *  otherwise, because a sink nobody gives a verdict to is the defect this file exists to remove. */
let guardActive = false;

/** Read straight out of the page the instant an error arrives, so the report names where the app was
 *  rather than where the journey started. Bounded: a wedged renderer must not hang the teardown. */
function snapshotSurface(page: Page): Promise<string> {
  const read = page
    .evaluate(() => {
      const top = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"], .computer-view');
      const label = top?.getAttribute("aria-label") ?? top?.querySelector("h1,h2,h3")?.textContent?.trim() ?? null;
      const active = document.activeElement as HTMLElement | null;
      const focus =
        active && active !== document.body
          ? `${active.tagName.toLowerCase()}${active.getAttribute("aria-label") ? `[${active.getAttribute("aria-label")}]` : ""}`
          : "nothing";
      const alert = document.querySelector('[role="alert"]')?.textContent?.trim().slice(0, 120) ?? null;
      return `${label ? `overlay "${label}"` : "main window"}, focus on ${focus}${alert ? `, alert: "${alert}"` : ""}`;
    })
    .catch((e: Error) => `(could not read the page: ${e.message.slice(0, 80)})`);
  const bail = new Promise<string>((r) => setTimeout(() => r("(the page did not answer in 2s — it may be wedged)"), SURFACE_TIMEOUT_MS));
  return Promise.race([read, bail]);
}

/**
 * Attach the guard to a freshly launched window. Every launcher under `app/e2e` calls this, and the
 * class guard fails any spec that opens an Electron app without it or hand-rolls its own
 * `on("pageerror")` listener instead.
 *
 * `console` is opt-in because it is a different claim. The shared `launch()` in fuzz-helpers has
 * always watched page errors only; the phase-2/3/5 launchers have always watched console errors as
 * well. Switching console watching on for a journey that never had it is a widening with its own
 * triage cost, and bug 14 is about errors that were collected and then dropped.
 */
export function watchPageErrors(app: ElectronApplication, page: Page, label: string, opts: { console?: boolean } = {}): PageErrors {
  if (!guardActive) {
    throw new Error(
      `watchPageErrors(${label}) was called outside a guarded test. This spec must import { test } from ` +
        `"./page-errors" rather than from "@playwright/test", or nothing gives a verdict on the errors it collects.`,
    );
  }
  const sink = new PageErrors(label, () => snapshotSurface(page));
  page.on("pageerror", (e) => sink.record("pageerror", e.message, currentStep));
  if (opts.console) page.on("console", (m) => { if (m.type() === "error") sink.record("console.error", m.text(), currentStep); });
  page.on("close", () => { sink.closed = true; });
  // The app is taken rather than the window alone so the sink knows when the journey ENDS: see the
  // note on `closed` in page-error-sink.ts for why a quit is a boundary and not a failure.
  const close = app.close.bind(app);
  app.close = async () => { sink.closed = true; return close(); };
  register(sink);
  return sink;
}

/**
 * Run `body` as a named step. The name is attached to any error raised while it is in flight, so the
 * verdict reads "during: open the Marketplace" instead of naming a 60-step journey and leaving the
 * reader to bisect it.
 */
export function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  return base.step(name, async () => {
    const previous = currentStep;
    currentStep = name;
    try {
      return await body();
    } finally {
      currentStep = previous;
    }
  });
}

/**
 * The e2e `test`: Playwright's, plus an always-on fixture that turns every page error collected
 * during the test into a failure of that test.
 *
 * The teardown runs after the body whether the body passed, failed or timed out — which is the whole
 * point. A journey that dies at step 30 because a render threw at step 12 now reports the render
 * throw, and the step that caused it, next to the timeout it caused.
 */
export const test = base.extend<{ pageErrorGuard: void }>({
  pageErrorGuard: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      guardActive = true;
      try {
        await use();
      } finally {
        guardActive = false;
      }
      const problems = await settleAll();
      currentStep = NO_STEP;
      expect(problems, `renderer errors during this journey:\n\n${problems.join("\n\n")}\n`).toEqual([]);
    },
    { auto: true },
  ],
});
