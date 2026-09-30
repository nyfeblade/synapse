/**
 * The journeys dashboard (battle plan 5.9): test-reports/journeys/<date>.md and <date>.html, built from every run in
 * history.jsonl. One row per journey: the latest median, its budget and limit, CPU, long tasks, and a sparkline of
 * the median across runs (the dashed line is the budget). Self-contained: no scripts, no external assets.
 */
import fs from "node:fs";
import path from "node:path";

export interface JourneyResult {
  id: string; title: string; runs: number;
  wallMs: number; cpuMs: number; longTasks: number; longTaskMs: number;
  samples?: number[];
  budget?: { wallMs: number; cpuMs: number };
  wallLimit?: number; cpuLimit?: number; pass?: boolean;
  /** Median over the median of the journey it is relative to (budgets.json `relative`), and its limit. */
  ratio?: number; ratioLimit?: number;
}
export interface HistoryRow {
  at: string; commit: string; branch: string; runs: number; strict: boolean;
  calibration: { cpuMs: number; wallMs: number; load: number };
  journeys: JourneyResult[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const f0 = (x: number | undefined) => (x === undefined ? "–" : x >= 100 ? x.toFixed(0) : x.toFixed(1));

/** An inline SVG sparkline of `ys` (oldest first) with the budget as a dashed line; <title> per point is the hover. */
function sparkline(points: { y: number; label: string }[], budget: number | undefined): string {
  const W = 160, H = 32, P = 4;
  if (!points.length) return "";
  const max = Math.max(...points.map((p) => p.y), budget ?? 0) * 1.05 || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${i === points.length - 1 ? 2.5 : 6}" class="${i === points.length - 1 ? "last" : "hit"}"><title>${esc(p.label)}</title></circle>`).join("");
  const b = budget !== undefined ? `<line x1="${P}" x2="${W - P}" y1="${y(budget).toFixed(1)}" y2="${y(budget).toFixed(1)}" class="budget"/>` : "";
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="median across runs">${b}<path d="${line}" class="spark"/>${dots}</svg>`;
}

export function writeReport(rows: HistoryRow[], outDir: string): { md: string; html: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const last = rows[rows.length - 1]!;
  const date = last.at.slice(0, 10);
  const recent = rows.slice(-30);
  const ids = last.journeys.map((j) => j.id);
  const status = (j: JourneyResult) => `${j.pass === undefined ? "no budget" : j.pass ? "pass" : "OVER"}${j.ratio !== undefined ? ` (×${j.ratio.toFixed(2)} of short, max ×${j.ratioLimit})` : ""}`;

  const md = [
    `# Journeys — ${date}`,
    "",
    `Latest run: ${last.at} on \`${last.branch}\` @ \`${last.commit}\`, ${last.runs} runs per journey, calibration ${last.calibration.cpuMs.toFixed(1)} ms CPU, load ×${last.calibration.load.toFixed(2)}${last.strict ? " (strict)" : ""}.`,
    "Wall = input to painted result (renderer clock); launch journeys are timed from the launch call. CPU = renderer main-thread CPU. Limit = budget stretched by the measured load.",
    "",
    "| Journey | Median | Budget | Limit | CPU / limit | Long tasks | Status | Last runs (medians) |",
    "|---|---:|---:|---:|---:|---:|---|---|",
    ...last.journeys.map((j) => {
      const trend = recent.map((r) => r.journeys.find((x) => x.id === j.id)?.wallMs).filter((v): v is number => v !== undefined).slice(-8).map(f0).join(" → ");
      return `| ${j.title} (\`${j.id}\`) | ${f0(j.wallMs)} ms | ${j.budget ? `${j.budget.wallMs} ms` : "–"} | ${f0(j.wallLimit)} ms | ${f0(j.cpuMs)} / ${f0(j.cpuLimit)} ms | ${j.longTasks} (${f0(j.longTaskMs)} ms) | ${status(j)} | ${trend} |`;
    }),
    "",
    `History: ${rows.length} runs in \`history.jsonl\`. Rebuild: \`npm run journeys -- --report-only\`.`,
    "",
  ].join("\n");

  const trs = ids.map((id) => {
    const j = last.journeys.find((x) => x.id === id)!;
    const pts = recent.flatMap((r) => { const x = r.journeys.find((y) => y.id === id); return x ? [{ y: x.wallMs, label: `${r.at.slice(0, 16).replace("T", " ")} ${r.commit}: ${f0(x.wallMs)} ms (load ×${r.calibration.load.toFixed(2)})` }] : []; });
    const st = status(j);
    return `<tr><th scope="row">${esc(j.title)}<span class="id">${esc(id)}</span></th><td class="num">${f0(j.wallMs)} ms</td><td class="num">${j.budget ? `${j.budget.wallMs} ms` : "–"}</td><td class="num">${f0(j.wallLimit)} ms</td><td class="num">${f0(j.cpuMs)} / ${f0(j.cpuLimit)} ms</td><td class="num">${j.longTasks}</td><td><span class="st ${st.startsWith("OVER") ? "over" : st.startsWith("pass") ? "ok" : ""}">${esc(st.replace(/^OVER/, "✕ over").replace(/^pass/, "✓ pass"))}</span></td><td>${sparkline(pts, j.budget?.wallMs)}</td></tr>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synapse journeys</title>
<style>
:root{--bg:#fff;--ink:#111;--muted:#6b6b6b;--line:#e6e6e6;--spark:#3a3a3a;--budget:#9a9a9a;--over:#b3261e;--ok:#2e6b3a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111;--ink:#eee;--muted:#9a9a9a;--line:#2a2a2a;--spark:#d0d0d0;--budget:#6a6a6a;--over:#f2b8b5;--ok:#9bd3a5}}
:root[data-theme="dark"]{--bg:#111;--ink:#eee;--muted:#9a9a9a;--line:#2a2a2a;--spark:#d0d0d0;--budget:#6a6a6a;--over:#f2b8b5;--ok:#9bd3a5}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
p.meta{color:var(--muted);margin:0 0 24px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:760px}
th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;white-space:nowrap}
thead th{font-weight:500;color:var(--muted);font-size:12px}
tbody th{font-weight:500}
.id{display:block;color:var(--muted);font-size:12px;font-weight:400;font-family:ui-monospace,Menlo,monospace}
.num{text-align:right;font-variant-numeric:tabular-nums}
.st{font-size:12px}.st.ok{color:var(--ok)}.st.over{color:var(--over);font-weight:600}
.spark{fill:none;stroke:var(--spark);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.budget{stroke:var(--budget);stroke-width:1;stroke-dasharray:3 3}
circle.last{fill:var(--spark)}circle.hit{fill:transparent}
</style></head><body><main>
<h1>Journeys</h1>
<p class="meta">${esc(last.at.slice(0, 16).replace("T", " "))} · ${esc(last.branch)} @ ${esc(last.commit)} · ${last.runs} runs each · load ×${last.calibration.load.toFixed(2)} · ${rows.length} runs in history</p>
<div class="wrap"><table>
<thead><tr><th>Journey</th><th class="num">Median</th><th class="num">Budget</th><th class="num">Limit</th><th class="num">CPU / limit</th><th class="num">Long tasks</th><th>Status</th><th>Median, last ${recent.length} runs</th></tr></thead>
<tbody>
${trs}
</tbody></table></div>
</main></body></html>
`;
  const mdPath = path.join(outDir, `${date}.md`);
  const htmlPath = path.join(outDir, `${date}.html`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(htmlPath, html);
  return { md: mdPath, html: htmlPath };
}
