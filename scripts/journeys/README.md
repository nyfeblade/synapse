# Journeys and latency budgets (battle plan 5.9)

"Speed is key": every key journey has a latency budget, and a regression fails.

```
npm run journeys                     # 5 runs each, judge medians, append history, exit 1 over budget
npm run journeys -- --report         # also write test-reports/journeys/<date>.md and <date>.html
npm run journeys -- --runs 7 --only switch-bot,search
npm run journeys -- --strict         # raw wall time, no load scaling
npm run journeys -- --set-budgets    # rewrite budgets.json from this run's medians plus the margin
npm run journeys -- --report-only    # rebuild the dashboard from history.jsonl, run nothing
```

## What runs

The real Electron app in FUZZ mode (fake brain, stub reviewer, never real Claude), with its app data in a temp
folder (`SYNAPSE_APP_DATA`), a temp `HOME`, and audio muted. FUZZ has no model, so what is timed is the app's own
latency: renderer, main process, IPC and the local host. One app window opens on screen while it runs (~2 minutes).

| Journey | Starts at | Ends when |
|---|---|---|
| `cold-start` | the launch call, onboarded profile with Bots | the Bot's composer is on screen and the host is connected |
| `first-launch` | the launch call, brand-new profile | onboarding walked (scripted), first message sent, "On it." shown |
| `first-reply` | Enter in the composer | the first reply text is painted |
| `switch-bot` | click on the other Bot's sidebar row | its composer is painted |
| `open-settings` | ⌘, | the Settings dialog is painted |
| `search` | ⌘K | the Search dialog's input is painted |
| `search-query` | typing "hello" | a message hit is painted (includes the palette's 120 ms debounce) |
| `approve-card` | click on Allow once | the settled "Approved action" row is painted |
| `long-reply`, `long-approve` | as `first-reply` and `approve-card`, in a chat preloaded with 100 demo turns | the same; must stay within ×1.5 of the short-chat journey, measured in the same run (bug 442) |
| `activity`, `usage` | click on the Settings section | the section's content is painted |
| `call-ui` | click on Start a voice call | the call screen is painted |
| `model-picker` | click on the composer's model pill | the Model menu is painted |

Click-level journeys are timed in the renderer: from the timestamp of the first trusted input event to the paint of
the first frame where the end state holds (`measure.ts`), so Playwright's own round trips are not counted. A
journey whose end state already holds before the input is an error, not a 0 ms pass. Each also records the renderer
main-thread CPU (CDP `ThreadTime`) and long tasks (>= 50 ms). Launch journeys are timed from the launch call.

## Why it's robust to load

The per-call p95 tests flaked whenever other agents had the Mac busy. Here:

- the **median** of N runs is judged, never a tail;
- a **calibration** workload (`scripts/perf/robust-timing.ts`) is timed before and after; its wall/CPU ratio is the
  current load, and each wall budget is stretched by it (capped at ×4, so a real regression can't hide);
- a **CPU budget** (renderer main-thread CPU) is checked too; load doesn't inflate CPU time, so more work fails
  even when the wall clock is noisy. CPU budgets are only scaled by the machine's speed against the calibration
  saved in `budgets.json` (between ×1 and ×2).

`host/test/perf/tool-loop-budget` and `shared/test/feedback-content` use the same helper (thread CPU time plus a
load-scaled wall check).

## The gate

Two halves, because the journeys launch Electron and take ~2 minutes (too slow and too visible for every
`npm test`, the same call as `motion:check` and `perf:idle`):

1. `npm test` (cheap, every run): `host/test/perf/journeys-budgets.test.ts` fails if a journey has no budget, and
   covers the median/load/CPU judging and the dashboard.
2. `npm run journeys` also fails when any launch leaves anything in its own temp folder (bug 443), and when a
   long-chat journey's median is over ×1.5 its short twin's (`relative` in `budgets.json`; a ratio measured in one
   run, so load cancels out).
3. `npm run journeys` (before merging anything that touches the renderer, main process, IPC or the host; CI-ready,
   headful macOS): exits 1 when any journey's median is over its wall limit or its CPU limit.

## Budgets

`budgets.json`: per journey, `wallMs` and `cpuMs`, set by `--set-budgets` from measured medians: ×1.5 (launch
journeys ×1.25), never tighter than median + 30 ms wall (two 60 Hz frames) or + 15 ms CPU, with the wall median
divided by the load seen while measuring. Raise a budget only with a reason in the commit.

History: every run appends a line to `test-reports/journeys/history.jsonl`; the dashboard draws each journey's
median across the last 30 runs, with its budget as a dashed line.
