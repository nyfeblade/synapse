/**
 * Before/after contact sheets for the look harness (dev only). Pairs `<before>/<name>-<theme>.png`
 * with `<after>/<name>-<theme>.png` and lays each pair side by side, one sheet per area.
 *
 *   node app/look/contact-sheet.mjs <beforeDir> <afterDir> <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const [beforeDir, afterDir, outDir] = process.argv.slice(2).map((p) => path.resolve(p));
fs.mkdirSync(outDir, { recursive: true });

const AREAS = {
  "chat": ["01-chat-idle", "02-chat-streaming", "03-composer-typed", "09-header-more", "44-empty-chat"],
  "sidebar": ["04-sidebar-hover"],
  "account-menu": ["05-account-menu"],
  "palette": ["06-palette", "07-palette-typed"],
  "new-chat": ["08-new-chat"],
  "code-card": ["10-code-card"],
  "panel": ["11-panel", "12-panel-tab0", "12-panel-tab1", "12-panel-tab2", "13-bot-panel"],
  "settings": ["20-settings-general", "20b-settings-general-bottom", "21-settings-account", "21-settings-voice", "21-settings-computer", "21-settings-schedules", "21-settings-system", "22-settings-search", "22-settings-search-miss"],
  "connectors": ["30-connectors", "31-connectors-miss"],
  "computer": ["40-computer-none", "41-computer-waiting", "41-computer-unreachable", "41-computer-dial-failed", "41-computer-connecting", "42-computer-connecting-11s", "43-computer-cursor"],
};

const uri = (p) => (fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` : null);
const browser = await chromium.launch({ headless: true });
try {
  for (const [area, names] of Object.entries(AREAS)) {
    const rows = [];
    for (const name of names) for (const theme of ["dark", "light"]) {
      const b = uri(path.join(beforeDir, `${name}-${theme}.png`));
      const a = uri(path.join(afterDir, `${name}-${theme}.png`));
      if (!b && !a) continue;
      const cell = (src, label) => src ? `<figure><img src="${src}"><figcaption>${label}</figcaption></figure>` : `<figure class="none"><div>not shot</div><figcaption>${label}</figcaption></figure>`;
      rows.push(`<h2>${name} · ${theme}</h2><div class="pair">${cell(b, "before")}${cell(a, "after")}</div>`);
    }
    if (!rows.length) continue;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 24px; background: #F2F2F2; font: 14px -apple-system, "SF Pro Text", sans-serif; color: #111; }
      h1 { margin: 0 0 16px; font-size: 20px; font-weight: 600; } h2 { margin: 20px 0 8px; font-size: 13px; font-weight: 500; color: #555; }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      figure { margin: 0; } img { display: block; width: 100%; border-radius: 6px; box-shadow: 0 0 0 1px #D8D8D8; }
      figcaption { margin-top: 4px; font-size: 12px; color: #666; } .none div { aspect-ratio: 16/10; display: grid; place-items: center; background: #E6E6E6; border-radius: 6px; color: #888; }
    </style><h1>${area}: before | after</h1>${rows.join("")}`;
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const out = path.join(outDir, `${area}.jpg`);
    await page.screenshot({ path: out, fullPage: true, type: "jpeg", quality: 82 });
    await page.close();
    console.log("sheet", out);
  }
} finally {
  await browser.close();
}
