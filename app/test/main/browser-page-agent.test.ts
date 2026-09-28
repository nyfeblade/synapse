// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_HINT_SOURCE, pageAgent, type PageAgent } from "../../src/main/browser/page-agent";

/** jsdom has no layout: every element sits at data-y (default 10) and is 100×20 unless data-zero. */
function layout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const y = Number((this as HTMLElement).dataset?.y ?? 10);
    const zero = (this as HTMLElement).dataset?.zero !== undefined;
    return { x: 0, y, top: y, left: 0, bottom: y + (zero ? 0 : 20), right: zero ? 0 : 100, width: zero ? 0 : 100, height: zero ? 0 : 20, toJSON() {} } as DOMRect;
  };
}

let syn: PageAgent;
beforeEach(() => {
  layout();
  document.body.innerHTML = "";
  delete (globalThis as { __syn?: unknown }).__syn;
  pageAgent();
  syn = (globalThis as unknown as { __syn: PageAgent }).__syn;
});
const collect = (base = 0) => syn.collect(base, { card: CARD_HINT_SOURCE });

describe("the page agent's outline", () => {
  it("lists controls with names from labels, and text blocks, in document order", () => {
    document.body.innerHTML = `
      <h1>Sign in</h1>
      <form method="post" action="/login">
        <label for="em">Email</label><input id="em" type="email" value="a@b.c">
        <label>Password <input type="password" value="hunter2"></label>
        <label><input type="checkbox" checked> Remember me</label>
        <select aria-label="Plan"><option>Free</option><option selected>Pro</option></select>
        <button>Sign in</button>
      </form>
      <p>New here? <a href="/join">Create an account</a></p>`;
    const nodes = collect().nodes;
    const brief = nodes.map((x) => `${x.role}:${x.name}`);
    expect(brief).toEqual(expect.arrayContaining(["heading:Sign in", "form:", "textbox:Email", "textbox:Password", "checkbox:Remember me", "combobox:Plan", "button:Sign in", "link:Create an account"]));
    expect(nodes.find((x) => x.name === "Email" && x.role === "textbox")!.value).toBe("a@b.c");
    expect(nodes.find((x) => x.name === "Plan")!.value).toBe("Pro");
    expect(nodes.find((x) => x.name === "Remember me" && x.role === "checkbox")!.checked).toBe(true);
    // form children sit one level under the form
    expect(nodes.find((x) => x.name === "Email" && x.role === "textbox")!.depth).toBe(1);
  });

  it("never lets a password or card value leave the page", () => {
    document.body.innerHTML = `<input type="password" aria-label="Password" value="hunter2"><input aria-label="Card number" value="4242424242424242">`;
    const nodes = collect().nodes;
    expect(JSON.stringify(nodes)).not.toContain("hunter2");
    expect(JSON.stringify(nodes)).not.toContain("4242");
    expect(nodes.map((x) => x.sensitive)).toEqual(["password", "card"]);
  });

  it("skips hidden, aria-hidden and zero-size things", () => {
    document.body.innerHTML = `
      <button style="display:none">Hidden</button>
      <div aria-hidden="true"><button>Also hidden</button></div>
      <button data-zero>Zero</button>
      <script>var x = 1</script>
      <button>Shown</button>`;
    expect(collect().nodes.map((x) => x.name)).toEqual(["Shown"]);
  });
});

describe("ref stability", () => {
  it("keeps an element's ref across snapshots and never reuses a ref", () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
    const first = collect();
    const refA = first.nodes.find((x) => x.name === "A")!.ref;
    const refB = first.nodes.find((x) => x.name === "B")!.ref;
    // insert before A, remove B
    const c = document.createElement("button");
    c.textContent = "C";
    document.body.prepend(c);
    document.getElementById("b")!.remove();
    const second = collect(first.next);
    expect(second.nodes.find((x) => x.name === "A")!.ref).toBe(refA);
    const refC = second.nodes.find((x) => x.name === "C")!.ref;
    expect([refA, refB]).not.toContain(refC);
    expect(Number(refC.slice(1))).toBeGreaterThan(Number(refB.slice(1)));
    expect(syn.facts(refB)).toEqual({ ok: false });
  });

  it("continues numbering from the controller's counter on a new document", () => {
    document.body.innerHTML = `<button>A</button>`;
    expect(collect(40).nodes[0]!.ref).toBe("e41");
  });

  it("the same document keeps one doc id; a new agent (new document) gets a new one", () => {
    const d1 = collect().doc;
    expect(collect().doc).toBe(d1);
    delete (globalThis as { __syn?: unknown }).__syn;
    pageAgent();
    expect((globalThis as unknown as { __syn: PageAgent }).__syn.collect(0, { card: CARD_HINT_SOURCE }).doc).not.toBe(d1);
  });
});

describe("element facts for the classifier", () => {
  it("reports submit controls, the form's method/action and search forms", () => {
    document.body.innerHTML = `
      <form method="post" action="https://pay.example/charge"><input name="amt"><button>Pay now</button></form>
      <form role="search" action="/s"><input name="q"><button>Go</button></form>`;
    const nodes = collect().nodes;
    const pay = syn.facts(nodes.find((x) => x.name === "Pay now")!.ref);
    expect(pay).toMatchObject({ ok: true, isSubmit: true, inForm: true, formMethod: "post", formAction: "https://pay.example/charge", searchForm: false });
    const go = syn.facts(nodes.find((x) => x.name === "Go")!.ref);
    expect(go).toMatchObject({ ok: true, isSubmit: true, searchForm: true, formMethod: "get" });
  });
});

describe("the window bar and take-over", () => {
  it("shows the Bot's name and a Stop button, and reports Stop and user input", () => {
    const events: string[] = [];
    (globalThis as { __synapseEvent?: (p: string) => void }).__synapseEvent = (p) => events.push(JSON.parse(p).kind);
    syn.bar({ bot: "Ava", mode: "active", text: { active: "Ava is using this window", paused: "Paused", stopped: "Stopped", stop: "Stop", resume: "Let it continue" } });
    const host = document.getElementById("__synapse_bar")!;
    expect(host).not.toBeNull();
    const root = syn.barRoot()!;
    expect(root.textContent).toContain("Ava is using this window");
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(events).toContain("stop");
    // the bar is never part of the outline
    expect(collect().nodes.some((x) => x.name.includes("Ava"))).toBe(false);
  });

  it("treats a trusted key or mouse press on the page as the user taking over (and ignores untrusted ones)", () => {
    const events: string[] = [];
    (globalThis as { __synapseEvent?: (p: string) => void }).__synapseEvent = (p) => events.push(JSON.parse(p).kind);
    // By default only a real (isTrusted) event counts, and a script can't make one.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(events).toEqual([]);
    // jsdom can't make a trusted event either, so the test marks "t" as the user's.
    syn._trusted = (e) => (e as KeyboardEvent).key === "t";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    expect(events).toEqual(["input"]);
    vi.restoreAllMocks();
  });
});
