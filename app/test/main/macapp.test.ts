import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRMA, isWebBrowserApp } from "@synapse/shared";
import { AX_MAX_CHARS, axDiff, axOutline, toRead, type AxNode, type AxRead } from "../../src/main/macapp/ax";
import { MacAppController } from "../../src/main/macapp/controller";
import type { HelperReply, HelperRequest, MacHelper } from "../../src/main/macapp/helper";
import { OsascriptRunner, osaError, parseResult, type OsaOutcome } from "../../src/main/macapp/osa";
import { buildScript } from "../../src/main/macapp/scripts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "macappt-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------- the AX outline

const node = (o: Partial<AxNode> & { ref: string; role: string }): AxNode => ({ name: "", depth: 0, y: 0, h: 20, interactive: false, ...o });
const read = (nodes: AxNode[], o: Partial<AxRead> = {}): AxRead => ({ app: "Figma", window: "Untitled", vh: 800, nodes, ...o });

describe("the Accessibility outline", () => {
  it("reads like the browser's, with the app in the header and stable refs on the controls", () => {
    const { text } = axOutline(read([
      node({ ref: "e1", role: "button", name: "Send", interactive: true }),
      node({ ref: "e2", role: "textbox", name: "Message", value: "hello", interactive: true, y: 40 }),
    ]));
    expect(text.split("\n")[0]).toBe("App: Figma — Untitled");
    expect(text).toContain('[e1] button "Send"');
    expect(text).toContain('[e2] textbox "Message" value="hello"');
  });

  it("a password field's value is never in the outline", () => {
    const { text } = axOutline(read([node({ ref: "e3", role: "textbox", name: "Password", value: "hunter2", sensitive: "password", interactive: true })]));
    expect(text).not.toContain("hunter2");
    expect(text).toContain("(password)");
  });

  it("prunes decoration and what is far off the window, and says how much is below", () => {
    const { text } = axOutline(read([
      node({ ref: "e1", role: "group" }),                                    // no name, not interactive: decoration
      node({ ref: "e2", role: "button", name: "Keep", interactive: true }),
      node({ ref: "e3", role: "button", name: "Far below", interactive: true, y: 5_000 }),
    ]));
    expect(text).toContain("Keep");
    expect(text).not.toContain("Far below");
    expect(text).toMatch(/1 more below/);
  });

  it("caps at about 3k tokens and pages the rest", () => {
    const many = Array.from({ length: 900 }, (_, i) => node({ ref: `e${i}`, role: "button", name: `Button number ${i} with a fairly long label`, interactive: true, y: i }));
    const { text, rest } = axOutline(read(many, { vh: 4_000 }));
    expect(text.length).toBeLessThanOrEqual(AX_MAX_CHARS + 200);
    expect(rest.length).toBeGreaterThan(0);
    expect(text).toMatch(/action "more" for the rest/);
  });

  it("after an action it returns only what changed", () => {
    const before = read([node({ ref: "e1", role: "button", name: "Send", interactive: true }), node({ ref: "e2", role: "text", name: "Draft", y: 40 })]);
    const after = read([node({ ref: "e1", role: "button", name: "Send", interactive: true, disabled: true }), node({ ref: "e2", role: "text", name: "Draft", y: 40 })]);
    const { text } = axDiff(before, after);
    expect(text).toContain('~ [e1] button "Send" disabled');
    expect(text).not.toContain("Draft");
  });

  it("no change says so rather than repeating the window", () => {
    const s = read([node({ ref: "e1", role: "button", name: "Send", interactive: true })]);
    expect(axDiff(s, s).text).toContain("No visible change.");
  });

  it("a different window returns a whole outline, not a meaningless diff", () => {
    const a = read([node({ ref: "e1", role: "button", name: "Send", interactive: true })]);
    const b = read([node({ ref: "e9", role: "button", name: "Close", interactive: true })], { window: "Preferences" });
    const { text } = axDiff(a, b);
    expect(text).toContain("(a different window)");
    expect(text).toContain('[e9] button "Close"');
  });

  it("trusts nothing off the wire: a malformed node is dropped, a malformed read is null", () => {
    expect(toRead({ nodes: [] })).toBeNull();
    const r = toRead({ app: "X", window: "W", vh: 600, nodes: [{ ref: "e1", role: "button" }, { role: "button" }, null] })!;
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.name).toBe("");
  });
});

// ------------------------------------------------------------------------------------- the scripts

describe("the fast-path scripts", () => {
  it("interpolates every Bot-supplied value as a literal, so a quote can't end the script", () => {
    const s = buildScript({ action: "notes.create", title: 'He said "hi"', text: "line1\nline2" } as never, { home: "/Users/alex" })!;
    expect(s.lang).toBe("js");
    expect(s.source).toContain(String.raw`"He said \"hi\""`);
    expect(s.source).not.toMatch(/\n\s*line2/);
  });

  it("a Messages send names the recipient and the text through AppleScript literals", () => {
    const s = buildScript({ action: "messages.send", target: "+15551234567", text: 'say "hello"' } as never, { home: "/Users/alex" })!;
    expect(s.lang).toBe("as");
    expect(s.app).toBe("Messages");
    expect(s.source).toContain(String.raw`"say \"hello\""`);
    expect(s.source).toContain("service type = iMessage");
  });

  it("expands ~ against the Mac's real home", () => {
    const s = buildScript({ action: "finder.reveal", target: "~/Documents/Plan.pdf" } as never, { home: "/Users/alex" })!;
    expect(s.source).toContain("/Users/alex/Documents/Plan.pdf");
  });

  it("has no script for the ui.* family — the Accessibility helper answers those", () => {
    for (const action of ["ui.outline", "ui.press", "ui.set", "ui.menu", "ui.key", "ui.focus"]) {
      expect(buildScript({ action } as never, { home: "/Users/alex" }), action).toBeNull();
    }
  });

  it("builds a script for every other action", () => {
    for (const action of ["open", "apps", "messages.send", "messages.threads", "mail.compose", "mail.send", "mail.search", "mail.read",
      "calendar.list", "calendar.create", "calendar.move", "calendar.cancel", "calendar.calendars", "reminders.create", "reminders.complete",
      "reminders.list", "notes.create", "notes.append", "notes.search", "contacts.find", "music", "finder.reveal", "finder.move", "finder.tag", "tabs", "shortcut"]) {
      expect(buildScript({ action, start: "2026-09-22T10:00:00" } as never, { home: "/Users/alex" }), action).not.toBeNull();
    }
  });
});

// ------------------------------------------------------------------------- osascript, stubbed in CI

/** The fake `osascript` CI uses: it prints what it was told to and exits with the code it was told to. */
function fakeOsascript(o: { stdout?: string; stderr?: string; code?: number }): string {
  const p = path.join(dir, "osascript");
  fs.writeFileSync(p, `#!/bin/sh\n${o.stdout ? `printf '%s' ${JSON.stringify(o.stdout)}\n` : ""}${o.stderr ? `printf '%s' ${JSON.stringify(o.stderr)} >&2\n` : ""}exit ${o.code ?? 0}\n`, { mode: 0o755 });
  return p;
}
const script = { lang: "js" as const, app: "Calendar", timeoutMs: 5_000, source: "1" };

describe("osascript (the fallback, and what CI stubs)", () => {
  it("parses the one JSON line a script answers with", async () => {
    const r = await new OsascriptRunner({ binary: fakeOsascript({ stdout: '{"events":[]}' }) }).run(script);
    expect(r).toMatchObject({ ok: true, json: { events: [] } });
  });

  it("a macOS Automation denial becomes a plain sentence naming the app and where to fix it", async () => {
    const r = await new OsascriptRunner({ binary: fakeOsascript({ stderr: "execution error: Not authorized to send Apple events to Calendar. (-1743)", code: 1 }) }).run(script) as { ok: false; error: string; code: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("permission");
    expect(r.error).toContain("Calendar");
    expect(r.error).toContain("Settings → Computer → Apps");
  });

  it("a missing app and an app's own refusal are told apart, and neither throws", async () => {
    const missing = await new OsascriptRunner({ binary: fakeOsascript({ stderr: "Can't get application \"Nope\". (-1728)", code: 1 }) }).run(script) as { ok: false; code: string };
    expect(missing.code).toBe("notfound");
    const refused = await new OsascriptRunner({ binary: fakeOsascript({ stderr: "execution error: something went wrong (-17)", code: 1 }) }).run(script) as { ok: false; code: string; error: string };
    expect(refused.code).toBe("script");
    expect(refused.error).toContain("something went wrong");
  });

  it("output that isn't JSON is reported, never guessed at", async () => {
    const r = await new OsascriptRunner({ binary: fakeOsascript({ stdout: "who knows" }) }).run(script) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("who knows");
  });

  it("the error mapper is pure and testable on its own", () => {
    expect(osaError("-1743", "Mail").code).toBe("permission");
    expect(parseResult("", "Mail")).toMatchObject({ ok: true, json: {} });
  });
});

// ---------------------------------------------------------------------------------- the controller

const PEOPLE = {
  people: [
    { name: "Sam Lee", phones: ["+15551110001"], emails: ["sam.lee@x.test"] },
    { name: "Sam Okafor", phones: ["+15551110002"], emails: [] },
    { name: "Priya Nair", phones: ["+15551110003"], emails: [] },
  ],
};

function controller(o: { osa?(s: { app: string; source: string }): OsaOutcome; helper?(r: HelperRequest): HelperReply } = {}) {
  const calls: { app: string; source: string }[] = [];
  const osa = {
    run: async (s: { app: string; source: string }) => {
      calls.push({ app: s.app, source: s.source });
      if (o.osa) return o.osa(s);
      return { ok: true as const, json: s.app === "Contacts" ? PEOPLE : { done: true }, raw: "" };
    },
  };
  const helper = { request: async (r: HelperRequest) => o.helper?.(r) ?? { ok: true as const }, warm: async () => true, close: () => {}, alive: () => true } as unknown as MacHelper;
  const c = new MacAppController({ helper, osa: osa as never, home: "/Users/alex", userData: dir, log: () => {}, now: () => 1_000 });
  return { c, calls };
}
const call = (args: Record<string, unknown>, approved = false) => ({ botId: "b1", botName: "Ava", args: args as never, approved });

describe("bug 225: the app's own data folder is never a MacApp target, even with the card answered", () => {
  it("Finder reveal/move/tag and open refuse the permission key and the data folder; nothing runs", async () => {
    const helper = { request: async () => ({ ok: true as const }), warm: async () => true, close: () => {}, alive: () => true } as unknown as MacHelper;
    const calls: unknown[] = [];
    const osa = { run: async (s: unknown) => { calls.push(s); return { ok: true as const, json: { done: true }, raw: "" }; } };
    const appData = "/Users/alex/Library/Application Support/Synapse";
    const c = new MacAppController({ helper, osa: osa as never, home: "/Users/alex", userData: dir, appData, log: () => {}, now: () => 1_000 });
    for (const args of [
      { action: "finder.move", target: `${appData}/local-policy.key`, value: "/Users/alex/Desktop" },
      { action: "finder.move", target: "/Users/alex/Desktop/evil.json", value: appData },
      { action: "finder.reveal", target: "~/Library/Application Support/Synapse/local-tool-grants.json" },
      { action: "finder.tag", target: `${appData}/local-bot-modes.json`, value: "x" },
      { action: "open", app: "TextEdit", target: "/Users/alex/LIBRARY/application support/synapse/local-policy.key" },
    ]) {
      const r = await c.handle(call(args, true)) as { ok: boolean; error?: string };
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.error).toMatch(/never a MacApp target/);
    }
    expect(calls).toHaveLength(0);
    expect((await c.handle(call({ action: "finder.reveal", target: "/Users/alex/Desktop" }))).ok).toBe(true);
  });
});

describe("the consequential gate on the Mac (send, delete, spend, security ALWAYS ask)", () => {
  it("a send asks before anything is sent, and says who gets what", async () => {
    const { c, calls } = controller();
    const r = await c.handle(call({ action: "messages.send", target: "+15551110001", text: "running late" })) as { ok: false; needsApproval: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.needsApproval).toBe(true);
    expect(r.error).toContain("+15551110001");
    expect(r.error).toContain("running late");
    expect(calls, "nothing ran").toHaveLength(0);
  });

  it("the answered card lets exactly that call through", async () => {
    const { c, calls } = controller();
    const r = await c.handle(call({ action: "messages.send", target: "+15551110001", text: "running late" }, true));
    expect(r.ok).toBe(true);
    expect(calls.map((x) => x.app)).toEqual(["Messages"]);
  });

  it("cancelling an event asks; listing events does not", async () => {
    const { c } = controller();
    expect((await c.handle(call({ action: "calendar.cancel", ref: "ev1" }))).ok).toBe(false);
    expect((await c.handle(call({ action: "calendar.list" }))).ok).toBe(true);
  });

  it("an event with attendees asks (invitations go out); one without runs", async () => {
    const { c } = controller();
    expect((await c.handle(call({ action: "calendar.create", title: "Sync", start: "2026-09-22T10:00:00", people: "sam@x.test" }))).ok).toBe(false);
    expect((await c.handle(call({ action: "calendar.create", title: "Gym", start: "2026-09-22T10:00:00" }))).ok).toBe(true);
  });

  it("pressing a button asks on the button's OWN label, not on what the Bot called it", async () => {
    const outline: AxRead = read([node({ ref: "e9", role: "button", name: "Delete everything", interactive: true })]);
    const { c } = controller({ helper: () => ({ ok: true, ...outline }) as never });
    await c.handle(call({ action: "ui.outline", app: "Figma" }));
    const r = await c.handle(call({ action: "ui.press", ref: "e9", app: "Figma" })) as { ok: false; needsApproval: boolean };
    expect(r.ok).toBe(false);
    expect(r.needsApproval).toBe(true);
  });

  it("google-setup: nothing is pressed in a Google sign-in/consent window, even approved", async () => {
    const outline: AxRead = read([node({ ref: "e5", role: "button", name: "Allow", interactive: true })], { app: "Google Chrome", window: "Sign in - Google Accounts - Google Chrome" });
    const { c } = controller({ helper: () => ({ ok: true, ...outline }) as never });
    await c.handle(call({ action: "ui.outline", app: "Google Chrome" }));
    for (const approved of [false, true]) {
      const r = await c.handle(call({ action: "ui.press", ref: "e5", app: "Google Chrome" }, approved));
      expect(r).toMatchObject({ ok: false, error: STRMA.browserRefused }); // security fix 3: browsers are refused outright
    }
    expect(await c.handle(call({ action: "ui.key", value: "return", app: "Google Chrome" }, true))).toMatchObject({ ok: false });
  });

  it("google-setup security fix 3: no ui.* action in a web browser, whatever the window title says", async () => {
    const sent: HelperRequest[] = [];
    for (const app of ["Google Chrome", "Safari", "Microsoft Edge", "Arc", "Firefox", "Brave Browser"]) {
      const outline: AxRead = read([node({ ref: "e5", role: "button", name: "Weiter", interactive: true })], { app, window: "Untitled" });
      const { c } = controller({ helper: (r) => { sent.push(r); return { ok: true, ...outline } as never; } });
      for (const a of [{ action: "ui.outline", app }, { action: "ui.press", ref: "e5", app }, { action: "ui.key", value: "return", app }, { action: "ui.set", ref: "e5", value: "x", app }, { action: "ui.menu", value: "File > Print", app }]) {
        expect(await c.handle(call(a, true))).toEqual({ ok: false, error: STRMA.browserRefused });
      }
    }
    expect(sent).toEqual([]);
  });

  it("google-setup security fix 3: a ui.* action with no app never lands on a browser", async () => {
    const outline: AxRead = read([node({ ref: "e5", role: "button", name: "Allow", interactive: true })], { app: "Safari", window: "Untitled" });
    const { c } = controller({ helper: () => ({ ok: true, ...outline }) as never });
    // The frontmost app turned out to be a browser: the read is dropped, and nothing can act on it.
    expect(await c.handle(call({ action: "ui.outline" }))).toEqual({ ok: false, error: STRMA.browserRefused });
    expect(await c.handle(call({ action: "ui.key", value: "return" }, true))).toMatchObject({ ok: false });
    expect(await c.handle(call({ action: "ui.press", ref: "e5" }, true))).toMatchObject({ ok: false });
  });

  it("re-review 2: an app whose outline holds a web area (a browser or a web view) takes no ui.* action", async () => {
    const sent: HelperRequest[] = [];
    const web: AxRead = { ...read([node({ ref: "e5", role: "button", name: "Allow", interactive: true }), node({ ref: "e6", role: "webarea", name: "", interactive: false })], { app: "Notion" }) };
    const { c } = controller({ helper: (r) => { sent.push(r); return { ok: true, ...web } as never; } });
    expect(await c.handle(call({ action: "ui.outline", app: "Notion" }))).toEqual({ ok: false, error: STRMA.browserRefused });
    sent.length = 0;
    expect(await c.handle(call({ action: "ui.press", ref: "e5", app: "Notion" }, true))).toMatchObject({ ok: false });
    expect(await c.handle(call({ action: "ui.key", value: "return", app: "Notion" }, true))).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    // The helper's own flag counts too (a web area pruned from the node list).
    const flagged = { ...read([node({ ref: "e5", role: "button", name: "OK", interactive: true })], { app: "Slack" }), web: true };
    const k = controller({ helper: () => ({ ok: true, ...flagged }) as never });
    expect(await k.c.handle(call({ action: "ui.outline", app: "Slack" }))).toEqual({ ok: false, error: STRMA.browserRefused });
  });

  it("re-review 2: an acting ui.* call needs this session's outline of that app first", async () => {
    const sent: HelperRequest[] = [];
    const { c } = controller({ helper: (r) => { sent.push(r); return { ok: true, ...read([]) } as never; } });
    expect(await c.handle(call({ action: "ui.key", value: "cmd+s", app: "Figma" }, true))).toEqual({ ok: false, error: STRMA.uiNeedsApp });
    expect(sent).toEqual([]);
  });

  it("re-review 2: the newer browsers are refused by name or bundle id", () => {
    for (const n of ["Comet", "Dia", "company.thebrowser.dia", "ChatGPT Atlas", "SigmaOS", "DuckDuckGo", "Yandex", "LibreWolf", "Waterfox", "Floorp"]) expect(isWebBrowserApp(n)).toBe(true);
    for (const n of ["Figma", "Notes", "Calculator", "Diagrams", "Arcade Tool"]) expect(isWebBrowserApp(n)).toBe(false);
  });

  it("an ordinary button is pressed without a card", async () => {
    const outline: AxRead = read([node({ ref: "e4", role: "button", name: "Zoom in", interactive: true })]);
    const { c } = controller({ helper: () => ({ ok: true, ...outline }) as never });
    await c.handle(call({ action: "ui.outline", app: "Figma" }));
    expect((await c.handle(call({ action: "ui.press", ref: "e4", app: "Figma" }))).ok).toBe(true);
  });
});

describe("credentials are never typed", () => {
  it("setting a password field is refused outright, card or no card", async () => {
    const outline: AxRead = read([node({ ref: "e2", role: "textbox", name: "Password", sensitive: "password", interactive: true })]);
    const { c } = controller({ helper: () => ({ ok: true, ...outline }) as never });
    await c.handle(call({ action: "ui.outline", app: "Bank" }));
    const r = await c.handle(call({ action: "ui.set", ref: "e2", value: "hunter2" }, true)) as { ok: false; error: string; needsApproval?: boolean };
    expect(r.ok).toBe(false);
    expect(r.error).toBe(STRMA.credentialsRefused);
    expect(r.needsApproval).toBeUndefined();
  });
});

describe("contact resolution", () => {
  it("a lookup reads Contacts ONCE and answers ranked, with why each one matched", async () => {
    const { c, calls } = controller();
    const r = await c.handle(call({ action: "contacts.find", query: "Sam" })) as { ok: true; reply: { text: string; app: string } };
    expect(calls.map((x) => x.app), "one round trip, not two").toEqual(["Contacts"]);
    expect(r.reply.app).toBe("Contacts");
    const out = JSON.parse(r.reply.text) as { query: string; people: { name: string; why: string }[] };
    expect(out.query).toBe("Sam");
    expect(out.people.map((p) => p.name)).toEqual(["Sam Lee", "Sam Okafor"]);
    expect(out.people[0]!.why).toBeTruthy();
  });

  it("a lookup is a read: it picks nobody and remembers nothing", async () => {
    const { c } = controller();
    await c.handle(call({ action: "contacts.find", query: "Priya" }));
    expect(fs.existsSync(path.join(dir, "macapp-nicknames.json"))).toBe(false);
  });

  it("a handle is used as it stands — Contacts is never read", async () => {
    const { c, calls } = controller();
    await c.handle(call({ action: "messages.send", target: "+15559999999", text: "hi" }, true));
    expect(calls.map((x) => x.app)).toEqual(["Messages"]);
  });

  it("one match runs, and the reply names the person rather than the number", async () => {
    const { c, calls } = controller();
    const r = await c.handle(call({ action: "messages.send", target: "Priya", text: "hi" }, true)) as { ok: true; reply: { text: string } };
    expect(calls.map((x) => x.app)).toEqual(["Contacts", "Messages"]);
    expect(calls[1]!.source).toContain("+15551110003");
    expect(r.reply.text).toContain("Priya Nair");
  });

  it("two people of the same name ask which, and send nothing", async () => {
    const { c, calls } = controller();
    const r = await c.handle(call({ action: "messages.send", target: "Sam", text: "hi" }, true)) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Sam Lee");
    expect(r.error).toContain("Sam Okafor");
    expect(calls.map((x) => x.app)).toEqual(["Contacts"]);
  });

  it("nobody matching is said plainly, with what to do instead", async () => {
    const { c } = controller();
    const r = await c.handle(call({ action: "messages.send", target: "Zoltan", text: "hi" }, true)) as { ok: false; error: string };
    expect(r.error).toContain("Zoltan");
    expect(r.error).toMatch(/number or an email/);
  });

  it("a person with no number and no email is reported, not silently skipped", async () => {
    const { c } = controller({ osa: (s) => ({ ok: true, json: s.app === "Contacts" ? { people: [{ name: "Ghost Ng", phones: [], emails: [] }] } : {}, raw: "" }) });
    const r = await c.handle(call({ action: "messages.send", target: "Ghost", text: "hi" }, true)) as { ok: false; error: string };
    expect(r.error).toContain("Ghost Ng");
  });

  it("once a nickname is confirmed it is remembered, and the ambiguity goes away next time", async () => {
    const { c } = controller();
    await c.handle(call({ action: "messages.send", target: "Priya", text: "hi" }, true));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "macapp-nicknames.json"), "utf8")) as Record<string, string>;
    expect(saved.priya).toBe("Priya Nair");
    // A NEW controller over the same data still knows it.
    const { c: c2, calls } = controller();
    const r = await c2.handle(call({ action: "messages.send", target: "Priya", text: "again" }, true));
    expect(r.ok).toBe(true);
    expect(calls[1]!.source).toContain("+15551110003");
  });
});

describe("paging and failures", () => {
  it("ui.more hands back the next page and nothing else runs", async () => {
    const many = Array.from({ length: 900 }, (_, i) => node({ ref: `e${i}`, role: "button", name: `Button number ${i} with a fairly long label`, interactive: true, y: i }));
    const { c } = controller({ helper: () => ({ ok: true, ...read(many, { vh: 4_000 }) }) as never });
    const first = await c.handle(call({ action: "ui.outline", app: "Figma" })) as { ok: true; reply: { rest?: number } };
    expect(first.reply.rest).toBeGreaterThan(0);
    const more = await c.handle(call({ action: "ui.more" })) as { ok: true; reply: { text: string } };
    expect(more.reply.text.length).toBeGreaterThan(0);
  });

  it("a stale ref says exactly how to recover", async () => {
    const figma = read([node({ ref: "e1", role: "button", name: "Zoom in", interactive: true })]);
    const { c } = controller({ helper: (r) => (r.action === "outline" ? { ok: true, ...figma } as never : { ok: false, code: "notfound", error: "gone" }) });
    await c.handle(call({ action: "ui.outline", app: "Figma" }));
    const r = await c.handle(call({ action: "ui.focus", ref: "e12", app: "Figma" })) as { ok: false; error: string };
    expect(r.error).toContain("e12 is no longer on screen");
    expect(r.error).toContain("ui.outline");
  });

  it("a denied app is a sentence, never a crash", async () => {
    const { c } = controller({ osa: () => ({ ok: false, code: "permission", error: "macOS hasn't allowed Synapse to control Calendar." }) });
    const r = await c.handle(call({ action: "calendar.list" })) as { ok: false; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("hasn't allowed");
  });

  it("every reply carries how long the Mac took", async () => {
    const { c } = controller();
    const r = await c.handle(call({ action: "calendar.list" })) as { ok: true; reply: { ms: number; app: string } };
    expect(typeof r.reply.ms).toBe("number");
    expect(r.reply.app).toBe("Calendar");
  });
});
