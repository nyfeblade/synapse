import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { startRig, type Shot } from "./harness";

/**
 * FRAME STRIPS (bug 444): the screen the user sees, frame by frame, for a motion worth looking at — 24 consecutive
 * compositor frames of three quick sends, cropped to the conversation, as one PNG. Off unless asked for:
 * `STRIP_OUT=<dir> npx playwright test -c motion/motion.config.ts motion/frame-strip.motion.ts` (from app/).
 */
const OUT = process.env.STRIP_OUT;
test.skip(!OUT, "set STRIP_OUT=<dir> to record frame strips");
test("frame strip: three quick sends, and a streamed reply landing", async () => {
  const rig = await startRig(); const page = rig.page;
  await rig.call("createAgent", { name: "Ada" });
  await page.getByRole("link", { name: /Ada/ }).first().click();
  const c = page.getByRole("textbox", { name: "Message Ada" }); await c.waitFor(); await page.waitForTimeout(900);
  const send = async (t: string) => { await c.fill(t); await c.press("Enter"); };
  const shots = await rig.film(async () => { await send("first message"); await page.waitForTimeout(250); await send("second quick"); await send("third quicker"); await page.waitForTimeout(900); });
  const box = await page.locator(".transcript").boundingBox();
  // 24 consecutive frames starting where the second send goes out, cropped to the conversation.
  const start = Math.max(0, shots.findIndex((s) => s.t - shots[0]!.t > 180));
  await strip(rig.browser, shots.slice(start, start + 24), box!, path.join(OUT!, "send-strip.png"));
  await rig.close();
});

async function strip(browser: import("@playwright/test").Browser, shots: Shot[], box: { x: number; y: number; width: number; height: number }, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const p = await browser.newPage({ viewport: { width: 1800, height: 1400 } });
  const w = 290, scale = w / box.width;
  const cells = shots.map((s, i) => `<figure><div style="width:${w}px;height:${Math.round(box.height * scale)}px;overflow:hidden;position:relative"><img src="data:image/jpeg;base64,${s.jpeg}" style="position:absolute;left:${-box.x * scale}px;top:${-box.y * scale}px;width:${1280 * scale}px"></div><figcaption>${i} · ${Math.round(s.t - shots[0]!.t)} ms</figcaption></figure>`).join("");
  await p.setContent(`<body style="margin:0;background:#fff;font:11px -apple-system"><div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px">${cells}</div></body>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: file, fullPage: true });
  await p.close();
}
