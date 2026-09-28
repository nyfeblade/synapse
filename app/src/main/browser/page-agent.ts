/**
 * mac-browser: the in-page half, evaluated in an ISOLATED world (the page's own scripts can't see or patch it; it
 * shares only the DOM). `pageAgent` must stay self-contained: it is serialized with Function.prototype.toString.
 *
 * - collect(): a flat, document-order list of meaningful nodes (controls, headings, landmarks, short text blocks)
 *   with STABLE refs: an element keeps its ref for the document's life and a ref is never reused (the controller
 *   carries the counter across documents).
 * - facts()/point(): what the Mac's classifier needs about one element, and where to click it (refusing when
 *   something else covers it, so a page can't redirect a click onto a different button).
 * - bar(): the slim "<Bot> is using this window · Stop" bar; trusted user input on the page means the user took over.
 * Password and card values never leave the page.
 */
import type { PageNode } from "./outline";
import type { ElementFacts } from "./classify";

export const CARD_HINT_SOURCE = String.raw`\b(card ?num(?:ber)?|cardnumber|cc-?num(?:ber)?|credit ?card|debit ?card|cvv|cvc|csc|cvn|security ?code|card ?code|expir(?:y|ation)|exp(?:iry)? ?date|mm ?\/ ?yy)\b`;

export interface BarText { active: string; paused: string; stopped: string; stop: string; resume: string }
export interface PageAgent {
  collect(base: number, o: { card: string }): { url: string; title: string; doc: string; vh: number; next: number; nodes: PageNode[] };
  facts(ref: string): ({ ok: true } & ElementFacts) | { ok: false };
  point(ref: string): { ok: true; x: number; y: number } | { ok: false; covered?: string };
  focus(ref: string): boolean;
  select(ref: string, option: string): { ok: boolean; chosen?: string; options?: string[] };
  checked(ref: string): boolean | null;
  text(ref: string | null, max: number): string;
  scrollInto(ref: string): boolean;
  /** The focused element's ref (press Enter is judged on it). */
  activeRef(): string | null;
  bar(o: { bot: string; mode: "active" | "paused" | "stopped" | "off"; text: BarText }): void;
  barRoot(): ShadowRoot | null;
  /** Tests only: jsdom can't make a trusted event. */
  _trusted?: (e: Event) => boolean;
}

export function pageAgent(): void {
  const G = globalThis as unknown as { __syn?: PageAgent; __synapseEvent?: (p: string) => void };
  if (G.__syn) return;
  const refs = new WeakMap<Element, number>();
  const byRef = new Map<number, WeakRef<Element>>();
  const st = { next: 0, doc: Math.random().toString(36).slice(2, 10), bar: null as HTMLElement | null, root: null as ShadowRoot | null, lastInput: 0 };
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "canvas", "iframe", "object", "embed"]);
  const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
  const CONTAINERS = new Set(["form", "dialog", "alertdialog", "alert", "navigation", "main", "search"]);
  const INLINE = new Set(["b", "i", "em", "strong", "span", "code", "small", "mark", "sup", "sub", "abbr", "cite", "q", "u", "s", "time", "kbd", "var", "bdi", "bdo", "data", "font", "br", "wbr"]);
  const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const refOf = (el: Element): string => {
    let r = refs.get(el);
    if (r === undefined) { r = ++st.next; refs.set(el, r); byRef.set(r, new WeakRef(el)); }
    return `e${r}`;
  };
  const elOf = (ref: string): Element | null => {
    const el = byRef.get(Number(String(ref).replace(/^e/, "")))?.deref() ?? null;
    return el && el.isConnected ? el : null;
  };
  const visible = (el: Element): boolean => {
    const h = el as HTMLElement;
    if (h.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const cv = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (typeof cv === "function") return cv.call(el, { checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const roleOf = (el: Element, tag: string): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0]!.toLowerCase();
    const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
    switch (tag) {
      case "a": case "area": return el.hasAttribute("href") ? "link" : "";
      case "button": case "summary": return "button";
      case "input":
        if (type === "hidden") return "";
        if (["checkbox", "radio"].includes(type)) return type;
        if (["submit", "button", "reset", "image"].includes(type)) return "button";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        return "textbox";
      case "textarea": return "textbox";
      case "select": return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return "img";
      case "nav": return "navigation";
      case "main": return "main";
      case "form": return "form";
      case "dialog": return (el as HTMLDialogElement).open === false ? "" : "dialog";
      default: return (el as HTMLElement).isContentEditable ? "textbox" : "";
    }
  };
  const byIds = (ids: string) => collapse(ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const labelText = (el: Element): string => {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      return collapse([...labels].map((l) => {
        const c = l.cloneNode(true) as Element;
        c.querySelectorAll("input,select,textarea,button").forEach((x) => x.remove());
        return c.textContent ?? "";
      }).join(" "));
    }
    return "";
  };
  const nameOf = (el: Element, tag: string, role: string): string => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = byIds(lb); if (t) return t; }
    const al = collapse(el.getAttribute("aria-label"));
    if (al) return al;
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
      if (["submit", "button", "reset"].includes(type)) return collapse((el as HTMLInputElement).value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      if (type === "image") return collapse(el.getAttribute("alt")) || "Submit";
      return labelText(el) || collapse(el.getAttribute("placeholder")) || collapse(el.getAttribute("title")) || collapse(el.getAttribute("name"));
    }
    if (tag === "img" || tag === "area") return collapse(el.getAttribute("alt"));
    if (["link", "button", "heading", "tab", "menuitem", "option", "treeitem", "switch", "checkbox", "radio"].includes(role) || tag === "summary") {
      const t = collapse((el as HTMLElement).innerText ?? el.textContent);
      if (t) return t;
      const img = el.querySelector("img[alt]");
      if (img) return collapse(img.getAttribute("alt"));
    }
    return collapse(el.getAttribute("title"));
  };
  const hintOf = (el: Element): string => [el.getAttribute("name"), el.id, labelText(el), el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("autocomplete")].filter(Boolean).join(" ");
  const sensitiveOf = (el: Element, card: RegExp): "password" | "card" | undefined => {
    const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (type === "password" || /\b(current|new)-password\b/.test(ac)) return "password";
    if (/\bcc-(number|csc|exp|exp-month|exp-year|type)\b/.test(ac) || card.test(hintOf(el))) return "card";
    return undefined;
  };
  const ownText = (el: Element): boolean => [...el.childNodes].some((c) => c.nodeType === 3 && /\S/.test(c.textContent ?? ""));
  /** The block's own text: its text nodes and inline descendants, minus controls (their own lines) and nested blocks (walked on their own). */
  const blockText = (el: Element): string => {
    let out = "";
    const walk = (n: Node) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) out += c.textContent;
        else if (c.nodeType === 1) {
          const e = c as Element;
          const t = e.tagName.toLowerCase();
          if (SKIP.has(t) || !visible(e)) continue;
          if (INTERACTIVE.has(roleOf(e, t)) || !INLINE.has(t)) continue;
          if (t === "br") out += " ";
          walk(e);
        }
      }
    };
    walk(el);
    return collapse(out);
  };
  const isBlockish = (el: Element) => !INLINE.has(el.tagName.toLowerCase());

  function collect(base: number, o: { card: string }) {
    st.next = Math.max(st.next, base);
    const card = new RegExp(o.card, "i");
    const nodes: PageNode[] = [];
    const vh = window.innerHeight || 800;
    const emit = (el: Element, role: string, name: string, depth: number, extra: Partial<PageNode> = {}) => {
      const r = el.getBoundingClientRect();
      nodes.push({ ref: refOf(el), role, name: cut(name, 200), depth, y: Math.round(r.top), h: Math.round(r.height), interactive: INTERACTIVE.has(role), ...extra });
    };
    const zero = (el: Element) => { const r = el.getBoundingClientRect(); return r.width === 0 && r.height === 0; };
    const visit = (el: Element, depth: number, inText: boolean): void => {
      if (el === st.bar) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag) || !visible(el)) return;
      const role = roleOf(el, tag);
      if (INTERACTIVE.has(role)) {
        if (zero(el)) return;
        const extra: Partial<PageNode> = {};
        const inp = el as HTMLInputElement;
        const sens = tag === "input" || tag === "textarea" ? sensitiveOf(el, card) : undefined;
        if (sens) { extra.sensitive = sens; extra.value = inp.value ? "•••" : ""; }
        else if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider") extra.value = cut(collapse(tag === "input" || tag === "textarea" ? inp.value : el.textContent), 120);
        if (role === "checkbox" || role === "radio" || role === "switch") extra.checked = tag === "input" ? inp.checked : el.getAttribute("aria-checked") === "true";
        if (tag === "select") {
          const s = el as HTMLSelectElement;
          extra.value = cut(collapse(s.selectedOptions?.[0]?.textContent), 80);
          extra.options = [...s.options].slice(0, 12).map((x) => cut(collapse(x.textContent), 40));
        }
        if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") extra.disabled = true;
        const ex = el.getAttribute("aria-expanded");
        if (ex === "true" || ex === "false") extra.expanded = ex === "true";
        if (document.activeElement === el) extra.focused = true;
        emit(el, role, nameOf(el, tag, role), depth, extra);
        return; // a control's text is its name
      }
      if (role === "heading") {
        if (zero(el)) return;
        const lvl = el.getAttribute("aria-level") ?? tag.slice(1);
        emit(el, "heading", nameOf(el, tag, role), depth, { level: Number(lvl) || 2 });
        // a heading can hold a link
        for (const c of [...el.children]) visit(c, depth, true);
        return;
      }
      if (role === "img") { if (!inText && !zero(el)) { const n = nameOf(el, tag, role); if (n) emit(el, "img", n, depth); } return; }
      let d = depth;
      if (CONTAINERS.has(role)) { emit(el, role, collapse(el.getAttribute("aria-label")) || (el.getAttribute("aria-labelledby") ? byIds(el.getAttribute("aria-labelledby")!) : ""), depth); d = depth + 1; }
      let consumed = inText;
      if (!inText && isBlockish(el) && ownText(el) && !zero(el)) {
        const t = blockText(el);
        if (t) emit(el, "text", t, d);
        consumed = true;
      }
      // Inline children were read as part of this block's text; nested blocks are walked on their own.
      for (const c of [...el.children]) visit(c, d, consumed && !isBlockish(c));
    };
    if (document.body) visit(document.body, 0, false);
    return { url: location.href, title: document.title, doc: st.doc, vh, next: st.next, nodes };
  }

  function facts(ref: string): ({ ok: true } & ElementFacts) | { ok: false } {
    const el = elOf(ref);
    if (!el) return { ok: false };
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el, tag);
    const type = tag === "input" ? ((el as HTMLInputElement).type ?? "").toLowerCase() : tag === "button" ? ((el as HTMLButtonElement).type ?? "submit").toLowerCase() : "";
    const form = ((el as HTMLInputElement).form ?? el.closest("form")) as HTMLFormElement | null;
    const isSubmit = !!form && ((tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image")));
    const searchForm = !!form && (form.getAttribute("role") === "search" || !!form.closest("[role=search]") || !!form.querySelector("input[type=search],input[name=q],input[name=query],input[name=search],input[name=s]"));
    let action = "";
    try { action = form ? new URL(form.getAttribute("action") ?? "", location.href).href : ""; } catch { action = form?.getAttribute("action") ?? ""; }
    return {
      ok: true, tag, role, name: nameOf(el, tag, role), type: tag === "button" ? "" : type, inForm: !!form,
      formMethod: (form?.getAttribute("method") ?? "get").toLowerCase(), formAction: form ? action : "", isSubmit, searchForm,
      autocomplete: el.getAttribute("autocomplete") ?? "", fieldHint: hintOf(el),
    };
  }

  function point(ref: string): { ok: true; x: number; y: number } | { ok: false; covered?: string } {
    const el = elOf(ref);
    if (!el) return { ok: false };
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > (window.innerHeight || 800) || r.left < 0 || r.right > (window.innerWidth || 1280)) {
      (el as HTMLElement).scrollIntoView?.({ block: "center", inline: "center" });
      r = el.getBoundingClientRect();
    }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    if (hit && hit !== el && !el.contains(hit)) {
      const label = hit.closest("label") as HTMLLabelElement | null;
      if (!(label && label.control === el) && !(hit.contains(el) && hit.tagName.toLowerCase() === "label")) {
        return { ok: false, covered: `${hit.tagName.toLowerCase()} ${JSON.stringify(cut(collapse(hit.textContent), 60))}` };
      }
    }
    return { ok: true, x, y };
  }

  function bar(o: { bot: string; mode: "active" | "paused" | "stopped" | "off"; text: BarText }): void {
    if (o.mode === "off") { st.bar?.remove(); st.bar = null; st.root = null; return; }
    if (!st.bar || !st.bar.isConnected) {
      st.bar = document.createElement("div");
      st.bar.id = "__synapse_bar";
      st.bar.setAttribute("style", "all:initial;position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;");
      st.root = st.bar.attachShadow({ mode: "closed" });
      (document.documentElement ?? document.body).appendChild(st.bar);
    }
    const root = st.root!;
    const label = o.mode === "active" ? o.text.active : o.mode === "paused" ? o.text.paused : o.text.stopped;
    const btn = o.mode === "active" ? o.text.stop : o.text.resume;
    root.innerHTML = `<style>
      .b{box-sizing:border-box;height:28px;display:flex;align-items:center;justify-content:center;gap:10px;font:500 12px/1 -apple-system,system-ui,sans-serif;color:#fff;background:#111;border-bottom:1px solid #2a2a2a;letter-spacing:.01em}
      .d{width:6px;height:6px;border-radius:3px;background:${o.mode === "active" ? "#3ddc84" : "#f5a623"}}
      button{all:unset;cursor:pointer;padding:3px 10px;border-radius:6px;background:#fff;color:#111;font-weight:600}
      button:hover{background:#e6e6e6}</style>
      <div class="b" role="status"><span class="d"></span><span class="t"></span><span aria-hidden="true">·</span><button type="button"></button></div>`;
    root.querySelector(".t")!.textContent = label;
    const b = root.querySelector("button")!;
    b.textContent = btn;
    b.addEventListener("click", (e) => { e.stopPropagation(); send(o.mode === "active" ? "stop" : "resume"); });
  }

  const send = (kind: string) => { try { G.__synapseEvent?.(JSON.stringify({ kind })); } catch { /* the controller went away */ } };
  const agent: PageAgent = {
    collect, facts, point, bar,
    barRoot: () => st.root,
    focus(ref) {
      const el = elOf(ref) as HTMLElement | null;
      if (!el) return false;
      el.focus();
      const i = el as HTMLInputElement;
      if (typeof i.select === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) i.select();
      else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
      return document.activeElement === el;
    },
    select(ref, option) {
      const s = elOf(ref) as HTMLSelectElement | null;
      if (!s || s.tagName !== "SELECT") return { ok: false };
      const want = collapse(option).toLowerCase();
      const opts = [...s.options];
      const hit = opts.find((x) => collapse(x.textContent).toLowerCase() === want || x.value.toLowerCase() === want) ?? opts.find((x) => collapse(x.textContent).toLowerCase().includes(want));
      if (!hit) return { ok: false, options: opts.slice(0, 30).map((x) => collapse(x.textContent)) };
      s.value = hit.value;
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, chosen: collapse(hit.textContent) };
    },
    checked(ref) {
      const el = elOf(ref) as HTMLInputElement | null;
      if (!el) return null;
      return el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
    },
    text(ref, max) {
      const el = ref ? elOf(ref) : (document.querySelector("main, article, [role=main]") ?? document.body);
      if (!el) return "";
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
      return t.slice(0, max);
    },
    activeRef() {
      const el = document.activeElement;
      return el && el !== document.body && el !== document.documentElement ? refOf(el) : null;
    },
    scrollInto(ref) {
      const el = elOf(ref) as HTMLElement | null;
      el?.scrollIntoView?.({ block: "center" });
      return !!el;
    },
  };
  G.__syn = agent;
  // Take-over: a real (trusted) press, key or wheel on the page, outside the bar, while the Bot isn't acting.
  const onInput = (e: Event) => {
    if (!(agent._trusted ? agent._trusted(e) : e.isTrusted)) return;
    if (st.bar && e.composedPath().includes(st.bar)) return;
    const now = Date.now();
    if (now - st.lastInput < 400) return;
    st.lastInput = now;
    send("input");
  };
  for (const t of ["mousedown", "keydown", "wheel", "touchstart"]) window.addEventListener(t, onInput, { capture: true, passive: true });
}
