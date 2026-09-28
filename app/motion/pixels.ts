import type { Browser } from "@playwright/test";
import type { Shot } from "./harness";

export interface Box { x: number; y: number; w: number; h: number }

/**
 * INK per frame: the share of a region's pixels that are dark (text, icons, avatars on the light
 * theme). Decoded by the browser itself (no image library in the repo): a scratch page draws each
 * screencast JPEG to a canvas and counts. A region whose ink falls to nothing mid-transition has gone
 * BLANK on screen, whatever the DOM says.
 */
export async function inkSeries(browser: Browser, shots: Shot[], boxes: Record<string, Box>): Promise<{ t: number; ink: Record<string, number> }[]> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ shots, boxes }) => {
      const out: { t: number; ink: Record<string, number> }[] = [];
      const c = document.createElement("canvas");
      const g = c.getContext("2d", { willReadFrequently: true })!;
      for (const s of shots) {
        const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${s.jpeg}`)).blob());
        c.width = bmp.width; c.height = bmp.height;
        g.drawImage(bmp, 0, 0);
        const ink: Record<string, number> = {};
        for (const [k, b] of Object.entries(boxes)) {
          const d = g.getImageData(b.x, b.y, b.w, b.h).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]! < 150) n++;
          ink[k] = n / (d.length / 4);
        }
        out.push({ t: s.t, ink });
      }
      return out;
    }, { shots, boxes });
  } finally { await page.close(); }
}

/** Debug aid: the same region of several frames stacked into one PNG (base64), for eyeballing a glitch. */
export async function strip(browser: Browser, shots: Shot[], b: Box): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ shots, b }) => {
      const c = document.createElement("canvas");
      c.width = b.w; c.height = (b.h + 4) * shots.length;
      const g = c.getContext("2d")!;
      g.fillStyle = "#f00"; g.fillRect(0, 0, c.width, c.height);
      for (const [i, s] of shots.entries()) {
        const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${s.jpeg}`)).blob());
        g.drawImage(bmp, b.x, b.y, b.w, b.h, 0, i * (b.h + 4), b.w, b.h);
      }
      return c.toDataURL("image/png").split(",")[1]!;
    }, { shots, b });
  } finally { await page.close(); }
}
