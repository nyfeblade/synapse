import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { TeachStatus } from "@synapse/shared";
import { createBot, gatewayApi, launch } from "./fuzz-helpers";
import { test } from "./page-errors";

/**
 * Bug 5 / bug 42 — "Teach a task" end to end, in the real app (TCH-01, TCH-02, TCH-03).
 *
 * The evidence for bug 5 was that `/workspace/.host-out/teach` was empty: no recording had ever been
 * produced. Bug 42 found why, and it was never the host — the pill set `teachSetupFor` from the
 * computer view's title bar while the only form that read it was mounted in ChatView, under an
 * opaque full-window cover, so `startTeachRecording` was never reached.
 *
 * The jsdom tests (teach-reachable.test.tsx) prove the form lands on the surface that is on top.
 * They cannot prove it is CLICKABLE — jsdom has no layout and no stacking. This journey can:
 * Playwright refuses to click an element that does not receive pointer events, so the three clicks
 * below would fail on the old code even though the elements were all in the DOM. It then follows the
 * flow into the host and asserts a session folder really lands on disk.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: `demo.mp4`. The FUZZ box has no X server, and the ffmpeg on
 * a developer Mac has no `x11grab` input ("Unknown input format: 'x11grab'" in ffmpeg.log), so the
 * capture cannot produce video here. That is the environment, not the app. What this owns is the
 * wiring the bug log said had never once run: goal → start → REC → stop → a published, host-owned
 * session folder whose session.json carries the goal the user typed.
 */
test("Teach a task from the computer view: the form is reachable, and the recording reaches the host", async () => {
  const { app, win } = await launch(`e2e-teach-${Date.now()}`);
  const api = gatewayApi(app);
  await createBot(win, "Scout");

  // A teach recording needs the Bot's own RUNNING screen (CMP-04; TEACH_NO_SCREEN otherwise), and in
  // FUZZ a seat comes up when the Bot first uses the computer — the same route as computer.e2e.ts.
  const composer = win.getByPlaceholder("Message Scout");
  await composer.fill("computer: hold the Denver fare");
  await composer.press("Enter");
  const card = win.getByRole("region", { name: "Computer" });
  await expect(card.getByText("Action needed")).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Take over" }).click();

  const view = win.getByRole("dialog", { name: "Bots' Computer" });
  await expect(view).toBeVisible();

  // Bug 42: this click used to set a flag whose only reader was mounted behind this very view.
  await view.getByRole("button", { name: "Teach a task" }).click();
  const goal = view.getByLabel("The result you want");
  await expect(goal).toBeVisible();
  await expect(view.getByText("Don't type passwords or other secrets while recording.")).toBeVisible();
  await goal.fill("File an expense report from the receipt in my inbox");
  await view.getByRole("button", { name: "Start recording" }).click();

  // TCH-02, on the surface the user has just been asked to demonstrate on.
  await expect(view.getByText(/● REC \d+:\d\d/)).toBeVisible();
  await expect(view.getByText("Scout is watching and taking notes")).toBeVisible();
  await expect(view.locator("[data-testid=teach-frame]")).toBeVisible();
  const running = await api<{ status: TeachStatus }>("getTeachRecordingStatus");
  expect(running.status.state).toBe("RECORDING");
  expect(running.status.goal).toBe("File an expense report from the receipt in my inbox");

  await view.getByRole("button", { name: "Stop & save" }).click();
  await expect(view.getByText(/● REC/)).toBeHidden();

  // Bug 5's "no recording has ever been produced" is only closed by a folder that exists.
  await expect.poll(async () => (await api<{ status: TeachStatus }>("getTeachRecordingStatus")).status.state, { timeout: 30_000 })
    .not.toBe("FINALIZING");
  const dir = (await api<{ status: TeachStatus }>("getTeachRecordingStatus")).status.sessionDir!;
  expect(dir).toContain(path.join(".host-out", "teach"));
  expect(fs.existsSync(dir)).toBe(true);
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")) as { goal: string; viewport: number[] };
  expect(session.goal).toBe("File an expense report from the receipt in my inbox");
  expect(session.viewport).toEqual([1280, 800]);
  expect(fs.existsSync(path.join(dir, "ffmpeg.log"))).toBe(true);

  await app.close();
});
