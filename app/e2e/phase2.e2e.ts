import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { completeOnboarding } from "./onboarding";
import { test, watchPageErrors } from "./page-errors";
import { openPrivateSkills } from "./fuzz-helpers";

// ESM has no __dirname; this repo is "type": "module".
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const shots = path.join(__dirname, "shots");

test("Phase 2 journey (FUZZ)", async () => {
  fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({ args: ["."], cwd: appDir, env: { ...process.env, FUZZ: "1", APP_PROFILE: `e2e-p2-${Date.now()}` } });
  const win = await app.firstWindow();
  watchPageErrors(app, win, "phase2 journey");
  await completeOnboarding(win); // Phase 5: a fresh FUZZ profile opens on onboarding
  await win.getByRole("button", { name: "New chat" }).click();
  await win.getByLabel("To:").fill("Piper");
  await win.keyboard.press("Enter");
  const composer = win.getByRole("textbox", { name: "Message Piper" });
  await expect(composer).toBeVisible();
  // Scope message-content checks to the transcript: the sidebar row also mirrors the latest text.
  const transcript = win.getByRole("log", { name: "Conversation transcript" });

  // memory + palette search → jump
  await composer.fill("remember: The user's landlord is Mark Ellis.");
  await composer.press("Enter");
  await expect(transcript.getByText("Noted.")).toBeVisible();
  await win.keyboard.press("Meta+k");
  const palette = win.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await win.screenshot({ path: path.join(shots, "phase2-palette.png") });
  await palette.getByRole("textbox", { name: "Search" }).fill("landlord");
  await palette.getByRole("option", { name: /Piper.*landlord/ }).first().click();
  await expect(palette).toBeHidden();

  // theme row cycles without closing
  await win.keyboard.press("Meta+k");
  await palette.getByRole("textbox", { name: "Search" }).fill("theme");
  await win.keyboard.press("Enter");
  await expect(palette.getByText(/Theme: (Light|Dark|Follow System)/)).toBeVisible();
  await win.keyboard.press("Escape");

  // attachment in, file card out
  const file = path.join(os.tmpdir(), `notes-${Date.now()}.md`);
  fs.writeFileSync(file, "# Notes\n- one\n");
  await win.getByRole("button", { name: "Attach file" }).click();
  const chooser = win.waitForEvent("filechooser");
  await win.getByRole("menuitem", { name: "Attach files…" }).click();
  await (await chooser).setFiles(file);
  await expect(win.getByText(path.basename(file))).toBeVisible();
  // `.host-out/uploads/`, not `uploads/` — commit b4ad7fd (secfix round 3, ruling 4) moved attachment
  // staging out of the box-writable /workspace/uploads into the host-owned /workspace/.host-out/uploads
  // and updated host/test/app-phase2-journey.test.ts, but no e2e spec (bug 39 (4)). Against the old
  // path the demo brain's SendMessage found no file, the turn produced nothing, and the nudge reply
  // "Sorry, here it is: done." arrived in place of the file card — so the Bot's card never existed.
  await composer.fill(`send back: .host-out/uploads/${path.basename(file)}`);
  await composer.press("Enter");
  await expect(win.getByRole("button", { name: `Save ${path.basename(file)}` })).toBeVisible();
  await win.getByRole("button", { name: `Open ${path.basename(file)}` }).last().click();
  await expect(win.getByRole("dialog", { name: path.basename(file) })).toBeVisible();
  await win.keyboard.press("Escape");

  // widget
  await composer.fill("ask: Which flight?|7 AM|6 PM");
  await composer.press("Enter");
  await win.getByRole("button", { name: "6 PM" }).click();
  await expect(transcript.getByText("Got it: 6 PM.")).toBeVisible();

  // hover actions: reply + react
  const bubble = win.locator(".msg.bot").last();
  await bubble.hover();
  await bubble.getByRole("button", { name: "Reply" }).click();
  await expect(win.getByText("Replying to:")).toBeVisible();
  await bubble.hover();
  await bubble.getByRole("button", { name: "React" }).click();
  await bubble.getByRole("button", { name: "React 👍" }).click();
  await expect(bubble.getByRole("button", { name: /👍 1/ })).toBeVisible();

  // save a skill, then the sidebar footer entry → Private skills (C5 ruling: the footer label stays "Marketplace")
  await composer.fill("save skill: Weekly report");
  await composer.press("Enter");
  await expect(transcript.getByText("Saved skill")).toBeVisible();
  await openPrivateSkills(win); // Phase 5: the Marketplace footer opens the full Marketplace
  const skillsDlg = win.getByRole("dialog", { name: "Manage plugins and skills" });
  await expect(skillsDlg.getByText("Weekly report", { exact: true })).toBeVisible();
  await win.screenshot({ path: path.join(shots, "phase2-private-skills.png") });
  await win.keyboard.press("Escape");

  // hide → Hidden Bots → Unhide
  await win.getByRole("link", { name: /Piper/ }).click({ button: "right" });
  await win.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await win.getByRole("button", { name: "Hidden Bots" }).click();
  await win.getByRole("button", { name: "Unhide Piper" }).click();
  await win.keyboard.press("Escape");
  await expect(win.getByRole("link", { name: /Piper/ })).toBeVisible();

  await app.close();
});
