import { expect } from "@playwright/test";
import { launch } from "./fuzz-helpers";
import { test } from "./page-errors";

// Added 11:10: the crawler clicks everything. A clicked external link must never open a window, navigate the
// app away, or reach shell.openExternal in FUZZ mode (the guarded openExternal path is a no-op there).
test("FUZZ: a clicked external link opens no window and calls no shell.openExternal", async () => {
  const { app, win } = await launch("e2e-link-guard");
  try {
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => { g.__opened.push(url); };
    });
    const before = win.url();
    await win.evaluate(() => {
      for (const [i, [id, target]] of ([["ext-blank", "_blank"], ["ext-self", ""]] as const).entries()) {
        const a = document.createElement("a");
        a.id = id;
        a.href = "https://claude.ai/oauth/authorize?fake=1";
        if (target) a.target = target;
        a.textContent = id;
        a.style.cssText = `position:fixed;top:${200 + i * 60}px;left:300px;z-index:99999;padding:8px;background:#fff`;
        document.body.appendChild(a);
      }
    });
    await win.locator("#ext-blank").click();
    await win.locator("#ext-self").click({ noWaitAfter: true });
    await win.evaluate(() => window.open("https://example.org/popup", "_blank"));
    await win.waitForTimeout(1000);
    expect(app.windows()).toHaveLength(1);
    expect(win.url()).toBe(before);
    expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([]);
  } finally {
    await app.close();
  }
});
