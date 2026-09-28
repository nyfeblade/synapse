/**
 * The frame recorder (motion check). Injected before the renderer loads; once `__motion.start()` is
 * called it samples, EVERY animation frame, the on-screen state of the elements motion touches — box,
 * effective opacity, whether a transform is applied, which animations are running — and logs the
 * events around them: CSS and Web Animations starts/cancels, View Transitions (start, abort, overlap),
 * user scroll input, layout shifts. detectors.ts turns the recording into glitches. A DOM sample per
 * rAF is exact where a screenshot every 16ms is not (headless screenshots take longer than a frame).
 */
import type { Frame, MotionEvent, Recording, Sample } from "./types";

const TRACK = [
  ".sidebar [data-bot]", ".chat-header", ".chat-header .morph-avatar", ".chat-header .morph-name", ".msg", ".bubble", ".file-card",
  ".menu", ".listbox", ".panel > *", ".settings-content > *", ".steps .step", ".new-pill", ".composer-input", ".modal > *",
  ".market .plain-list.skills > li", ".typing", ".event-row", ".main", ".activity",
].join(", ");

const ids = new WeakMap<Element, number>();
let nextId = 1;
const idOf = (el: Element) => { let i = ids.get(el); if (!i) { i = nextId++; ids.set(el, i); } return i; };
const keyOf = (el: Element): string => {
  const h = el as HTMLElement;
  const cls = (typeof h.className === "string" ? h.className : "").split(/\s+/).filter((c) => c && c !== "is-new" && c !== "glide-sel")[0] ?? el.tagName.toLowerCase();
  const k = h.dataset?.bot ?? h.dataset?.id ?? h.dataset?.entry ?? h.getAttribute("aria-label") ?? (h.textContent ?? "").trim().slice(0, 40);
  const entry = el.closest('[id^="entry-"]')?.id;
  return `${cls}:${entry ? `${entry}/` : ""}${k}`;
};

function opacityOf(el: Element): number {
  let o = 1;
  for (let n: Element | null = el, d = 0; n && d < 8; n = n.parentElement, d++) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return 0;
    o *= parseFloat(cs.opacity) || 0;
  }
  return Math.round(o * 1000) / 1000;
}

let frames: Frame[] = [];
let log: MotionEvent[] = [];
let on = false;
let vtActive = 0;
const now = () => Math.round(performance.now() * 10) / 10;
const ev = (e: Omit<MotionEvent, "t">) => { if (on) log.push({ t: now(), ...e } as MotionEvent); };

function sample(): void {
  if (!on) return;
  const els: Sample[] = [];
  for (const el of document.querySelectorAll(TRACK)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const anims = el.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getTiming().iterations ?? 1) !== Infinity);
    els.push({
      id: idOf(el), key: keyOf(el), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      op: opacityOf(el), tf: cs.transform !== "none" ? cs.transform : "", anim: anims.length,
      inTf: (el as HTMLElement).style?.transform ?? "", vtn: (el as HTMLElement).style?.viewTransitionName ?? "",
      cls: typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "",
      val: "value" in el ? String((el as HTMLTextAreaElement).value).length : -1,
      txt: el.classList.contains("bubble") ? (el.textContent ?? "").trim().length : -1,
    });
  }
  const tr = document.querySelector<HTMLElement>(".transcript");
  frames.push({ t: now(), vt: vtActive > 0, scroll: tr ? Math.round(tr.scrollTop) : -1, scrollMax: tr ? tr.scrollHeight - tr.clientHeight : -1, ch: tr ? tr.clientHeight : -1, els });
  requestAnimationFrame(sample);
}

// ---- Event hooks: installed at load so nothing started before start() is missed by identity. ----
document.addEventListener("animationstart", (e) => ev({ kind: "css-start", id: idOf(e.target as Element), key: keyOf(e.target as Element), name: (e as AnimationEvent).animationName }), true);
document.addEventListener("animationcancel", (e) => ev({ kind: "css-cancel", id: idOf(e.target as Element), key: keyOf(e.target as Element), name: (e as AnimationEvent).animationName }), true);
for (const t of ["wheel", "touchstart", "keydown", "pointerdown"] as const) window.addEventListener(t, () => ev({ kind: "input", name: t }), { capture: true, passive: true });

const animate = Element.prototype.animate;
Element.prototype.animate = function (this: Element, k: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
  const a = animate.call(this, k, o);
  const id = idOf(this);
  const key = keyOf(this);
  const pseudo = typeof o === "object" ? o.pseudoElement ?? "" : "";
  ev({ kind: "waapi-start", id, key, name: pseudo });
  a.addEventListener("cancel", () => ev({ kind: "waapi-cancel", id, key, name: pseudo }));
  a.addEventListener("finish", () => ev({ kind: "waapi-finish", id, key, name: pseudo }));
  return a;
};

type SVT = (cb: () => void) => ViewTransition;
const svt = (document as Document & { startViewTransition?: SVT }).startViewTransition;
if (svt) {
  (document as Document & { startViewTransition?: SVT }).startViewTransition = function (cb: () => void) {
    if (vtActive > 0) ev({ kind: "vt-overlap" });
    const names = [...document.querySelectorAll<HTMLElement>("[style*='view-transition-name']")].map((e) => e.style.viewTransitionName).filter(Boolean);
    ev({ kind: "vt-start", name: names.join(",") });
    const t = svt.call(document, cb);
    vtActive++;
    t.ready.catch((err: unknown) => ev({ kind: "vt-abort", name: String((err as Error)?.message ?? err).slice(0, 160) }));
    t.finished.finally(() => { vtActive--; ev({ kind: "vt-end" }); });
    return t;
  };
}
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) ev({ kind: "layout-shift", value: e.value }); })
    .observe({ type: "layout-shift", buffered: false });
} catch { /* unsupported */ }
window.addEventListener("error", (e) => ev({ kind: "error", name: String(e.message).slice(0, 200) }));
const cerr = console.error;
console.error = (...a: unknown[]) => { ev({ kind: "error", name: a.map(String).join(" ").slice(0, 200) }); cerr.apply(console, a); };

(window as unknown as { __motion: unknown }).__motion = {
  start(): void { frames = []; log = []; on = true; requestAnimationFrame(sample); },
  stop(): Recording { on = false; const r = { frames, events: log }; frames = []; log = []; return r; },
  mark(name: string): void { ev({ kind: "mark", name }); },
};
