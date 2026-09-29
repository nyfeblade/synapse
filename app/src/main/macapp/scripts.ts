/**
 * mac-apps: the FAST PATHS. One AppleScript or JXA script per action, built as pure strings so they can be
 * unit-tested without a Mac and run either through the warm `bots-mac` helper (NSAppleScript, no spawn) or
 * through `osascript` (the fallback, and the fake binary CI stubs).
 *
 * Rules kept here, not in the caller:
 *   - every value the Bot supplied is interpolated as JSON (JXA) or through `asStr` (AppleScript), never raw;
 *   - a value that reaches a shell goes through `sq` (single quotes), never JSON: `$()` and backticks run inside double quotes;
 *   - every script's last expression is a JSON string, so one `osascript` run answers with one parseable line;
 *   - nothing polls: a script asks the app once and returns.
 */
import type { MacAppArgs } from "@synapse/shared";

export type ScriptLang = "js" | "as";
export interface MacScript {
  lang: ScriptLang;
  source: string;
  /** The app this drives (the activity row, the card and the Automation-consent check all name it). */
  app: string;
  /** Milliseconds this action may take before it is called stuck. */
  timeoutMs: number;
}

const FAST = 8_000;
const SLOW = 20_000;

/** An AppleScript string literal. */
export const asStr = (s: string): string => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '" & linefeed & "')}"`;
/** A JXA value literal (JSON is valid JavaScript for everything we pass). */
const j = (v: unknown): string => JSON.stringify(v ?? null);

/** Trim a list so one result is small; the Bot asks for more rather than being handed a mailbox. */
export const capped = (n: number | undefined, dflt: number, max: number): number => Math.max(1, Math.min(max, Math.floor(n ?? dflt)));

/** JXA preamble: a tiny helper set every script shares. `ISO` keeps dates comparable across the wire. */
const PRE = `
function ISO(d){ try { return d ? new Date(d).toISOString() : null; } catch(e){ return null; } }
function cut(s,n){ s = s == null ? "" : String(s); return s.length > n ? s.slice(0,n-1) + "\\u2026" : s; }
function ok(o){ return JSON.stringify(o); }
function first(a){ return a && a.length ? a[0] : null; }
function sq(s){ return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
`.trim();

const js = (app: string, body: string, timeoutMs = FAST): MacScript => ({ lang: "js", app, timeoutMs, source: `${PRE}\n(function(){\n${body}\n})()` });

/**
 * The script for one fast-path action, or null when the action is not a script fast path
 * (the ui.* family, which the Accessibility helper answers instead).
 */
export function buildScript(a: MacAppArgs, ctx: { home: string }): MacScript | null {
  const limit = (d: number, max = 50) => capped(a.limit, d, max);
  switch (a.action) {
    // ---------------------------------------------------------------- any app
    case "open": {
      const what = a.app ?? a.target ?? "";
      return js("System Events", `
        var se = Application("System Events");
        var name = ${j(what)};
        var app = Application(name);
        app.includeStandardAdditions = true;
        app.activate();
        delay(0);
        return ok({ opened: name, frontmost: first(se.applicationProcesses.whose({frontmost: true})().map(function(p){ return p.name(); })) });
      `);
    }
    case "apps":
      return js("System Events", `
        var se = Application("System Events");
        var ps = se.applicationProcesses.whose({backgroundOnly: false})();
        return ok({ running: ps.map(function(p){ return { name: p.name(), frontmost: p.frontmost() }; }) });
      `);

    // ---------------------------------------------------------------- Messages
    case "messages.send": {
      // The proven recipe (host/prompts/skills/mac-quick-actions): the handle is already resolved by the
      // caller (contacts.ts), so this script never searches Contacts and never guesses a person.
      const svc = /^\+?[\d\s().-]+$/.test(a.target ?? "") && a.value === "SMS" ? "SMS" : "iMessage";
      return {
        lang: "as", app: "Messages", timeoutMs: FAST,
        source: `tell application "Messages" to send ${asStr(a.text ?? "")} to participant ${asStr(a.target ?? "")} of (1st account whose service type = ${svc})\nreturn "{\\"sent\\":true}"`,
      };
    }
    case "messages.threads":
      return js("Messages", `
        var M = Application("Messages");
        var n = ${limit(10, 25)};
        var chats = M.chats();
        var out = [];
        for (var i = 0; i < chats.length && out.length < n; i++) {
          var c = chats[i];
          var ms = c.textMessages();
          var last = ms.length ? ms[ms.length - 1] : null;
          out.push({ id: c.id(), with: c.name(), last: last ? cut(last.text(), 200) : null, at: last ? ISO(last.timeSent()) : null });
        }
        return ok({ threads: out });
      `, SLOW);

    // ---------------------------------------------------------------- Mail
    case "mail.compose":
    case "mail.send": {
      const send = a.action === "mail.send";
      return js("Mail", `
        var Ma = Application("Mail");
        var m = Ma.OutgoingMessage({ subject: ${j(a.title ?? "")}, content: ${j(a.text ?? "")}, visible: ${send ? "false" : "true"} });
        Ma.outgoingMessages.push(m);
        (${j(String(a.target ?? "").split(",").map((s) => s.trim()).filter(Boolean))}).forEach(function(x){ m.toRecipients.push(Ma.Recipient({ address: x })); });
        (${j(String(a.people ?? "").split(",").map((s) => s.trim()).filter(Boolean))}).forEach(function(x){ m.ccRecipients.push(Ma.Recipient({ address: x })); });
        ${send ? "m.send();" : "Ma.activate();"}
        return ok({ ${send ? "sent" : "drafted"}: true, subject: ${j(a.title ?? "")}, to: ${j(a.target ?? "")} });
      `);
    }
    case "mail.search":
      return js("Mail", `
        var Ma = Application("Mail");
        var q = ${j(a.query ?? "")}, n = ${limit(10, 25)};
        var box = ${a.list ? `Ma.accounts().reduce(function(f,ac){ return f || ac.mailboxes.whose({name: ${j(a.list)}})()[0]; }, null) || Ma.inbox` : "Ma.inbox"};
        var ms = box.messages.whose({ _or: [{ subject: { _contains: q } }, { sender: { _contains: q } }] })();
        var out = [];
        for (var i = 0; i < ms.length && out.length < n; i++) {
          out.push({ id: String(ms[i].id()), from: ms[i].sender(), subject: cut(ms[i].subject(), 160), at: ISO(ms[i].dateReceived()), unread: ms[i].readStatus() === false });
        }
        return ok({ messages: out, mailbox: box.name() });
      `, SLOW);
    case "mail.read":
      return js("Mail", `
        var Ma = Application("Mail");
        var id = ${j(a.ref ?? "")};
        var m = first(Ma.inbox.messages.whose({ id: parseInt(id, 10) })());
        if (!m) return ok({ error: "No message " + id + " in the inbox." });
        return ok({ id: id, from: m.sender(), to: m.toRecipients().map(function(r){ return r.address(); }), subject: m.subject(), at: ISO(m.dateReceived()), body: cut(m.content(), 4000) });
      `, SLOW);

    // ---------------------------------------------------------------- Calendar
    case "calendar.calendars":
      return js("Calendar", `
        var C = Application("Calendar");
        return ok({ calendars: C.calendars().map(function(c){ return { name: c.name(), writable: c.writable() }; }) });
      `);
    case "calendar.list":
      return js("Calendar", `
        var C = Application("Calendar");
        var from = new Date(${j(a.start ?? "")} || Date.now());
        var to = new Date(${j(a.end ?? "")} || (from.getTime() + 7*24*3600*1000));
        var cals = ${a.list ? `C.calendars.whose({name: ${j(a.list)}})()` : "C.calendars()"};
        var out = [];
        for (var i = 0; i < cals.length; i++) {
          var evs = cals[i].events.whose({ _and: [{ startDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }] })();
          for (var k = 0; k < evs.length; k++) out.push({ id: evs[k].uid(), title: evs[k].summary(), start: ISO(evs[k].startDate()), end: ISO(evs[k].endDate()), calendar: cals[i].name(), where: evs[k].location() || null });
        }
        out.sort(function(x,y){ return (x.start||"") < (y.start||"") ? -1 : 1; });
        return ok({ events: out.slice(0, ${limit(20, 100)}), from: from.toISOString(), to: to.toISOString() });
      `, SLOW);
    case "calendar.create":
      return js("Calendar", `
        var C = Application("Calendar");
        var cal = ${a.list ? `first(C.calendars.whose({name: ${j(a.list)}})())` : "first(C.calendars.whose({writable: true})())"};
        if (!cal) return ok({ error: "No writable calendar" + ${j(a.list ? ` named ${a.list}` : "")} + "." });
        var s = new Date(${j(a.start ?? "")});
        var e = ${a.end ? `new Date(${j(a.end)})` : "new Date(s.getTime() + 3600*1000)"};
        var ev = C.Event({ summary: ${j(a.title ?? "")}, startDate: s, endDate: e, description: ${j(a.text ?? "")} });
        cal.events.push(ev);
        var invited = [], failed = [];
        (${j(String(a.people ?? "").split(",").map((s) => s.trim()).filter(Boolean))}).forEach(function(x){
          try { ev.attendees.push(C.Attendee({ email: x })); invited.push(x); } catch (err) { failed.push(x); }
        });
        return ok({ id: ev.uid(), title: ev.summary(), start: ISO(ev.startDate()), end: ISO(ev.endDate()), calendar: cal.name(), invited: invited, couldNotInvite: failed });
      `);
    case "calendar.move":
      return js("Calendar", `
        var C = Application("Calendar");
        var id = ${j(a.ref ?? "")};
        var ev = null, cal = null, cals = C.calendars();
        for (var i = 0; i < cals.length && !ev; i++) { ev = first(cals[i].events.whose({uid: id})()); if (ev) cal = cals[i]; }
        if (!ev) return ok({ error: "No event " + id + "." });
        var oldStart = ISO(ev.startDate());
        ${a.start ? `var ns = new Date(${j(a.start)}); var len = ev.endDate().getTime() - ev.startDate().getTime(); ev.startDate = ns; ev.endDate = ${a.end ? `new Date(${j(a.end)})` : "new Date(ns.getTime() + len)"};` : ""}
        return ok({ id: id, title: ev.summary(), was: oldStart, start: ISO(ev.startDate()), end: ISO(ev.endDate()), calendar: cal.name() });
      `);
    case "calendar.cancel":
      return js("Calendar", `
        var C = Application("Calendar");
        var id = ${j(a.ref ?? "")};
        var cals = C.calendars();
        for (var i = 0; i < cals.length; i++) {
          var ev = first(cals[i].events.whose({uid: id})());
          if (ev) { var t = ev.summary(), s = ISO(ev.startDate()); ev.delete(); return ok({ cancelled: t, was: s, calendar: cals[i].name() }); }
        }
        return ok({ error: "No event " + id + "." });
      `);

    // ---------------------------------------------------------------- Reminders
    case "reminders.list":
      return js("Reminders", `
        var R = Application("Reminders");
        var l = ${a.list ? `first(R.lists.whose({name: ${j(a.list)}})())` : "R.defaultList()"};
        if (!l) return ok({ error: "No list" + ${j(a.list ? ` named ${a.list}` : "")} + "." });
        var rs = l.reminders.whose({ completed: false })();
        var out = [];
        for (var i = 0; i < rs.length && out.length < ${limit(25, 100)}; i++) out.push({ id: rs[i].id(), title: rs[i].name(), due: ISO(rs[i].dueDate()) });
        return ok({ list: l.name(), reminders: out });
      `, SLOW);
    case "reminders.create":
      return js("Reminders", `
        var R = Application("Reminders");
        var l = ${a.list ? `first(R.lists.whose({name: ${j(a.list)}})())` : "R.defaultList()"};
        if (!l) return ok({ error: "No list" + ${j(a.list ? ` named ${a.list}` : "")} + "." });
        var props = { name: ${j(a.title ?? a.text ?? "")} };
        ${a.start ? `props.dueDate = new Date(${j(a.start)});` : ""}
        ${a.text && a.title ? `props.body = ${j(a.text)};` : ""}
        var r = R.Reminder(props);
        l.reminders.push(r);
        return ok({ id: r.id(), title: r.name(), due: ISO(r.dueDate()), list: l.name() });
      `);
    case "reminders.complete":
      return js("Reminders", `
        var R = Application("Reminders");
        var want = ${j(a.ref ?? a.title ?? "")};
        var ls = ${a.list ? `R.lists.whose({name: ${j(a.list)}})()` : "R.lists()"};
        for (var i = 0; i < ls.length; i++) {
          var r = first(ls[i].reminders.whose({ _or: [{ id: want }, { name: want }] })());
          if (r) { r.completed = true; return ok({ completed: r.name(), list: ls[i].name() }); }
        }
        return ok({ error: "No reminder matching " + want + "." });
      `, SLOW);

    // ---------------------------------------------------------------- Notes
    case "notes.search":
      return js("Notes", `
        var N = Application("Notes");
        var q = ${j(a.query ?? "")};
        var ns = N.notes.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] })();
        var out = [];
        for (var i = 0; i < ns.length && out.length < ${limit(10, 25)}; i++) out.push({ id: ns[i].id(), title: ns[i].name(), at: ISO(ns[i].modificationDate()), preview: cut(ns[i].plaintext(), 200) });
        return ok({ notes: out });
      `, SLOW);
    case "notes.create":
      return js("Notes", `
        var N = Application("Notes");
        var f = ${a.list ? `first(N.folders.whose({name: ${j(a.list)}})())` : "N.defaultAccount.defaultFolder()"};
        if (!f) return ok({ error: "No folder" + ${j(a.list ? ` named ${a.list}` : "")} + "." });
        var n = N.Note({ name: ${j(a.title ?? "")}, body: ${j(`<div><b>${a.title ?? ""}</b></div>`)} + ${j(a.text ?? "")} });
        f.notes.push(n);
        return ok({ id: n.id(), title: n.name(), folder: f.name() });
      `);
    case "notes.append":
      return js("Notes", `
        var N = Application("Notes");
        var want = ${j(a.ref ?? a.title ?? "")};
        var n = first(N.notes.whose({ _or: [{ id: want }, { name: want }] })());
        if (!n) return ok({ error: "No note matching " + want + "." });
        n.body = n.body() + "<div>" + ${j(a.text ?? "")} + "</div>";
        return ok({ id: n.id(), title: n.name(), appended: ${j((a.text ?? "").length)} });
      `, SLOW);

    // ---------------------------------------------------------------- Contacts
    case "contacts.find":
      // A coarse Contacts query (the first few characters, so a typo later in the name still matches);
      // the fuzzy ranking itself is done in TypeScript, where it is testable (shared/src/macapp.ts).
      return js("Contacts", `
        var C = Application("Contacts");
        var q = ${j((a.query ?? a.target ?? "").trim())};
        var stem = q.slice(0, 3);
        var ps = C.people.whose({ _or: [{ name: { _contains: stem } }, { nickname: { _contains: stem } }, { organization: { _contains: stem } }] })();
        var out = [];
        for (var i = 0; i < ps.length && out.length < ${limit(30, 60)}; i++) {
          var p = ps[i];
          out.push({
            name: p.name(),
            nickname: p.nickname() || undefined,
            company: p.organization() || undefined,
            phones: p.phones().map(function(x){ return x.value(); }),
            emails: p.emails().map(function(x){ return x.value(); }),
          });
        }
        return ok({ people: out, query: q });
      `, SLOW);

    // ---------------------------------------------------------------- the rest
    case "music": {
      const cmd = (a.value ?? "play").toLowerCase();
      const verb = cmd === "pause" ? "pause()" : cmd === "next" ? "nextTrack()" : cmd === "previous" ? "previousTrack()" : "play()";
      return js("Music", `
        var M = Application("Music");
        ${a.query ? `var t = first(M.playlists.whose({name: ${j(a.query)}})()) || first(M.tracks.whose({name: {_contains: ${j(a.query)}}})()); if (t) t.play(); else M.${verb};` : `M.${verb};`}
        var c = null; try { c = M.currentTrack(); } catch (e) {}
        return ok({ state: String(M.playerState()), track: c ? c.name() : null, artist: c ? c.artist() : null });
      `);
    }
    case "finder.reveal":
      return js("Finder", `
        var F = Application("Finder");
        var p = ${j(expand(a.target ?? a.value ?? "", ctx.home))};
        F.reveal(Path(p));
        F.activate();
        return ok({ revealed: p });
      `);
    case "finder.move":
      return js("Finder", `
        var F = Application("Finder");
        var src = ${j(expand(a.target ?? "", ctx.home))}, dst = ${j(expand(a.value ?? a.list ?? "", ctx.home))};
        var moved = F.move(Path(src), { to: Path(dst) });
        return ok({ moved: src, to: dst, now: String(moved.url ? moved.url() : dst) });
      `);
    case "finder.tag": {
      // No shell: the tag list is read and written through Foundation, so any name or path stays plain text.
      // A newline would split a tag into name and colour, so it becomes a space. Existing tags are kept.
      const tag = String(a.value ?? "").replace(/[\r\n]+/g, " ");
      return js("Finder", `
        ObjC.import("Foundation");
        var p = ${j(expand(a.target ?? "", ctx.home))}, tag = ${j(tag)};
        function tagsOf(path){ var r = Ref(); $.NSURL.fileURLWithPath(path).getResourceValueForKeyError(r, $.NSURLTagNamesKey, null); var v = r[0]; return v && !v.isNil() ? ObjC.deepUnwrap(v) || [] : []; }
        var tags = tagsOf(p);
        if (tags.indexOf(tag) < 0) tags.push(tag);
        if (!$.NSURL.fileURLWithPath(p).setResourceValueForKeyError($(tags), $.NSURLTagNamesKey, null)) throw new Error("Couldn't tag " + p);
        return ok({ tagged: p, tag: tag, tags: tags });
      `);
    }
    case "tabs": {
      const browser = /chrome/i.test(a.app ?? "") ? "Google Chrome" : "Safari";
      const v = (a.value ?? "list").trim();
      const open = /^open\s+(.+)$/i.exec(v);
      const close = /^close\s+(\d+)$/i.exec(v);
      return js(browser, `
        var B = Application(${j(browser)});
        var w = first(B.windows());
        ${open ? `B.activate(); if (w) { ${browser === "Safari" ? `var t = B.Tab({url: ${j(open[1])}}); w.tabs.push(t); w.currentTab = t;` : `w.tabs.push(B.Tab({url: ${j(open[1])}}));`} } else { B.Document ? B.Document().make() : 0; }` : ""}
        ${close ? `if (w) w.tabs()[${Number(close[1]) - 1}].close();` : ""}
        if (!w) return ok({ browser: ${j(browser)}, tabs: [] });
        return ok({ browser: ${j(browser)}, tabs: w.tabs().slice(0, ${limit(20, 40)}).map(function(t, i){ return { n: i + 1, title: cut(t.name(), 120), url: t.url() }; }) });
      `);
    }
    case "shortcut":
      return js("Shortcuts Events", `
        var app = Application.currentApplication(); app.includeStandardAdditions = true;
        var name = ${j(a.title ?? a.target ?? "")};
        if (!name) return ok({ shortcuts: app.doShellScript("/usr/bin/shortcuts list").split("\\r").slice(0, ${limit(40, 100)}) });
        var input = ${j(a.text ?? "")};
        var cmd = "/usr/bin/shortcuts run -- " + sq(name) + (input ? " <<< " + sq(input) : "");
        return ok({ ran: name, output: cut(app.doShellScript(cmd), 2000) });
      `, SLOW);

    default:
      return null;
  }
}

/** `~` and `~/x` against the Mac user's real home; anything else is left alone. */
export function expand(p: string, home: string): string {
  const s = String(p ?? "").trim();
  if (s === "~") return home;
  if (s.startsWith("~/")) return `${home}/${s.slice(2)}`;
  return s;
}
