/**
 * mac-apps: the Mac's own authority for one MacApp action. The coordinator's local-exec daemon has already
 * checked this Mac's policy; this decides the rest against what is really on the Mac:
 *   - the consequential gate (send, delete, spend, security ALWAYS ask, whatever the Bot's mode);
 *   - contact resolution, so "text Sam" is one person or a question, never a guess;
 *   - credentials, which are never typed into anything;
 *   - the fast path (a script) or the Accessibility fallback (the helper), timed, and returned small.
 *
 * Nothing here polls, and nothing returns an image.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MACAPP_CONSEQUENCE_REASON,
  STRMA,
  contactQuestion,
  isHandle,
  macAppConsequence,
  macAppLabelConsequence,
  macAppSummary,
  isTrashPath,
  namesSynapseApp,
  MAX_CONTACT_OPTIONS,
  pickContact,
  resolveContacts,
  type ContactCandidate,
  type MacAppArgs,
  type MacAppReply,
} from "@synapse/shared";
import { axDiff, axOutline, staleRef, toRead, type AxRead } from "./ax";
import type { MacHelper } from "./helper";
import type { OsaRunner } from "./osa";
import { buildScript, expand } from "./scripts";

/** A path with every symlink resolved; for a path that doesn't exist (yet), its deepest existing parent's real
 *  path with the rest appended. */
function realWalk(p: string): string {
  let cur = p; const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) return p;
    tail.unshift(path.basename(cur)); cur = up;
  }
}

export interface MacAppCall {
  botId: string;
  botName: string;
  args: MacAppArgs;
  /** The user answered the card for exactly this call. */
  approved: boolean;
}
export type MacAppResult = { ok: true; reply: MacAppReply } | { ok: false; error: string; needsApproval?: boolean; summary?: string };

interface Session {
  /** The last Accessibility read, so an action can return only what changed. */
  ax: AxRead | null;
  /** The pages `ui.more` still holds. */
  rest: string[];
  /** Who this Bot has messaged lately, newest first: recency breaks a contact tie without asking. */
  recent: string[];
}

const MAX_RECENT = 12;

export class MacAppController {
  private sessions = new Map<string, Session>();
  private nicknames: Record<string, string>;

  constructor(private d: {
    helper: MacHelper;
    osa: OsaRunner;
    home: string;
    /** Where the learned nicknames live (a Bot never writes anywhere else). */
    userData: string;
    /** Bug 225: the app's whole data folder (the permission key lives there): never a MacApp target. */
    appData?: string;
    log(line: string): void;
    now?(): number;
  }) {
    this.nicknames = readNicknames(this.file());
  }

  /** Bug 225: any path-like field (a Finder target or destination, a file to open) inside the app's data folder. */
  private touchesAppData(a: MacAppCall["args"]): boolean {
    const root = this.d.appData;
    if (!root) return false;
    const fold = (p: string) => p.normalize("NFC").toLowerCase();
    const roots = new Set([path.resolve(root)]);
    try { roots.add(fs.realpathSync.native(root)); } catch { /* not there */ }
    const real = realWalk;
    for (const v of [a.target, a.value, a.list]) {
      if (typeof v !== "string" || !v.trim()) continue;
      if (fold(v).includes("local-policy.key")) return true;
      const s = v.trim().replace(/^file:\/\//i, "");
      if (!s.startsWith("/") && !s.startsWith("~")) continue;
      const abs = path.resolve(s === "~" ? this.d.home : s.startsWith("~/") ? path.join(this.d.home, s.slice(2)) : s);
      for (const p of [abs, real(abs)]) for (const r of roots) if (fold(p) === fold(r) || fold(p).startsWith(fold(r) + path.sep)) return true;
    }
    return false;
  }

  /**
   * A Finder move from or into a Trash folder, judged on the path the script will really use: trimmed and ~-expanded
   * exactly as scripts.ts expand() does, resolved, and with symlinks followed (Finder follows them), so "~/.Trash ",
   * "~/.Trash\n" or a link to ~/.Trash can't skip the delete card.
   */
  private movesTrash(a: MacAppCall["args"]): boolean {
    if (a.action !== "finder.move") return false;
    for (const raw of [a.target ?? "", a.value ?? a.list ?? ""]) {
      const s = expand(raw, this.d.home);
      if (!s) continue;
      const abs = path.resolve(s);
      if (isTrashPath(s) || isTrashPath(abs) || isTrashPath(realWalk(abs))) return true;
    }
    return false;
  }

  /** Fix round: whether this MacApp action names Synapse's own app (the one driving its UI would target). ui.* with no
   *  app names the frontmost app; that case is caught in the ui path once the outline says which app it read. */
  private targetsSynapse(a: MacAppCall["args"]): boolean {
    return [a.app, a.target].some((v) => typeof v === "string" && namesSynapseApp(v));
  }

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private file(): string { return path.join(this.d.userData, "macapp-nicknames.json"); }

  private session(botId: string): Session {
    let s = this.sessions.get(botId);
    if (!s) { s = { ax: null, rest: [], recent: [] }; this.sessions.set(botId, s); }
    return s;
  }

  /** Warm the helper so the first real action doesn't pay the launch. */
  warm(): Promise<boolean> { return this.d.helper.warm(); }
  close(): void { this.d.helper.close(); }

  async handle(call: MacAppCall): Promise<MacAppResult> {
    const started = this.now();
    const a = call.args;
    const s = this.session(call.botId);
    const done = (text: string, app: string, rest?: number): MacAppResult =>
      ({ ok: true, reply: { text, app, action: a.action, ms: this.now() - started, ...(rest ? { rest } : {}) } });

    // --- paging costs nothing and changes nothing ------------------------------------------------
    if (a.action === "ui.more") {
      const next = s.rest.shift();
      return done(next ?? "Nothing more: that was the whole window.", s.ax?.app ?? "the front app", s.rest.length);
    }

    // --- bug 225: the app's own data (the permission key and records) is never a MacApp target ---------
    if (this.touchesAppData(a)) return { ok: false, error: "Blocked on this Mac by a fixed safety rule that no mode or setting can lift: the app's own data (its permission key and records) is never a MacApp target." };

    // --- fix round (review of bug 258): a Bot may never drive Synapse's own app, in any mode, so it can't click its
    //     own approval cards, its settings or the No limits confirm. Refuse by name or bundle id before anything runs.
    if (this.targetsSynapse(a)) return { ok: false, error: STRMA.synapseRefused };

    // --- the consequential gate, before anything happens -----------------------------------------
    const gated = await this.gate(call, s);
    if (gated) return gated;

    // --- the Accessibility fallback ---------------------------------------------------------------
    if (a.action.startsWith("ui.")) return this.ui(call, s, done);

    // --- a fast path ------------------------------------------------------------------------------
    const resolved = await this.resolveRecipient(call, s);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    // A lookup is ALREADY answered by the resolution above; running the Contacts script a second time
    // would double its cost for the same rows.
    if ("answer" in resolved) return done(resolved.answer, "Contacts");
    const script = buildScript(resolved.args, { home: this.d.home });
    if (!script) return { ok: false, error: `MacApp has no action "${a.action}".` };
    const r = await this.d.osa.run(script);
    if (!r.ok) return { ok: false, error: r.error };
    if (resolved.remember) this.remember(s, resolved.remember);
    const j = r.json as Record<string, unknown>;
    if (typeof j?.error === "string") return { ok: false, error: `${script.app}: ${j.error}` };
    return done(summarise(resolved.args, j), script.app);
  }

  // -------------------------------------------------------------------------------------------- gate

  /**
   * Send, delete, spend and security always ask — the Full-auto policy, applied on the Mac so a host that
   * disagrees cannot skip it. Answering the card is what makes `approved` true for exactly this call.
   */
  private async gate(call: MacAppCall, s: Session): Promise<MacAppResult | null> {
    const a = call.args;
    let why = macAppConsequence(a);
    if (!why && this.movesTrash(a)) why = "destruction";
    // The generic fallback presses a ref, not a word: resolve its on-screen label and judge THAT too, so
    // pressing [e9] "Delete everything" is gated exactly as choosing the menu item would be.
    if (!why && (a.action === "ui.press" || a.action === "ui.focus")) {
      const node = s.ax?.nodes.find((n) => n.ref === a.ref);
      if (node) why = macAppLabelConsequence(node.name);
    }
    if (!why) return null;
    if (call.approved) return null;
    const summary = macAppSummary(a);
    return { ok: false, needsApproval: true, summary, error: `${summary}. ${MACAPP_CONSEQUENCE_REASON[why]}` };
  }

  // ------------------------------------------------------------------------------------- the UI path

  private async ui(call: MacAppCall, s: Session, done: (t: string, app: string, rest?: number) => MacAppResult): Promise<MacAppResult> {
    const a = call.args;
    // Never type a credential, whatever the Bot was told or read.
    if (a.action === "ui.set") {
      const node = s.ax?.nodes.find((n) => n.ref === a.ref);
      if (node?.sensitive) return { ok: false, error: STRMA.credentialsRefused };
    }
    const action = a.action.slice(3); // outline | press | set | menu | key | focus
    const req = { op: "ax" as const, action, ...(a.app ? { app: a.app } : {}), ...(a.ref ? { ref: a.ref } : {}), ...(a.value !== undefined ? { value: a.value } : {}) };
    const r = await this.d.helper.request(req, 20_000);
    if (!r.ok) return { ok: false, error: r.code === "notfound" && a.ref ? staleRef(a.ref) : r.error };
    const read = toRead(r as Record<string, unknown>);
    if (!read) return { ok: false, error: "The Mac sent back an unreadable window outline." };
    // Fix round: a ui.* with no app read whatever was frontmost; if that turned out to be Synapse, refuse now.
    if (namesSynapseApp(read.app)) return { ok: false, error: STRMA.synapseRefused };
    const fresh = a.action === "ui.outline";
    const out = fresh ? axOutline(read) : axDiff(s.ax, read);
    s.ax = read;
    s.rest = out.rest;
    return done(out.text, read.app, out.rest.length);
  }

  // ------------------------------------------------------------------------------ contact resolution

  /**
   * "text Sam" → one person. A handle is taken as itself; a name goes to Contacts, is ranked with the
   * user's own nickname memory and this Bot's recent recipients, and an ambiguous name comes back as a
   * question rather than a message to the wrong Sam.
   */
  private async resolveRecipient(call: MacAppCall, s: Session): Promise<{ args: MacAppArgs; remember?: { query: string; name: string } } | { answer: string } | { error: string }> {
    const a = call.args;
    if (a.action !== "messages.send" && a.action !== "contacts.find") return { args: a };
    const query = String((a.action === "contacts.find" ? a.query ?? a.target : a.target) ?? "").trim();
    if (!query) return { error: "Name the person to reach." };
    if (a.action === "messages.send" && isHandle(query)) return { args: a };

    const find = buildScript({ action: "contacts.find", query, limit: 60 } as MacAppArgs, { home: this.d.home });
    const r = await this.d.osa.run(find!);
    if (!r.ok) return { error: r.error };
    const people = ((r.json as { people?: ContactCandidate[] })?.people ?? []).filter((p) => typeof p?.name === "string");
    const pick = pickContact(query, people, { recent: s.recent, nicknames: this.nicknames });

    if (a.action === "contacts.find") {
      // A lookup answers with everyone it found, RANKED and with the reason each one matched; it is a
      // read, so it never picks for the user and never remembers anything.
      if (pick.kind === "none") return { error: `No one in Contacts matches “${query}”.` };
      const ranked = resolveContacts(query, people, { recent: s.recent, nicknames: this.nicknames }).slice(0, MAX_CONTACT_OPTIONS);
      return { answer: JSON.stringify({ query, people: ranked.map((m) => ({ ...m.candidate, why: m.why })) }) };
    }
    switch (pick.kind) {
      case "handle": return { args: { ...a, target: pick.handle } };
      case "none": return { error: `No one in Contacts matches “${query}”. Give a number or an email address instead.` };
      case "several": return { error: contactQuestion(query, pick.options) };
      case "one": {
        const c = pick.match.candidate;
        const handle = c.phones[0] ?? c.emails[0];
        if (!handle) return { error: `${c.name} has no phone number or email address in Contacts.` };
        return { args: { ...a, target: handle, title: c.name }, remember: { query, name: c.name } };
      }
    }
  }

  /** What the user let through is what the Mac learns: the nickname they used, and who it turned out to be. */
  private remember(s: Session, m: { query: string; name: string }): void {
    s.recent = [m.name, ...s.recent.filter((n) => n !== m.name)].slice(0, MAX_RECENT);
    const key = m.query.toLowerCase();
    if (this.nicknames[key] === m.name) return;
    this.nicknames = { ...this.nicknames, [key]: m.name };
    writeNicknames(this.file(), this.nicknames);
  }
}

// ------------------------------------------------------------------------------------------- helpers

/** What the Bot reads: the app's own answer, small, with the recipient's real name where one was resolved. */
export function summarise(a: MacAppArgs, j: Record<string, unknown>): string {
  if (a.action === "messages.send") return `Sent to ${a.title ?? a.target}: “${a.text ?? ""}”`;
  const s = JSON.stringify(j);
  return s.length > 12_000 ? `${s.slice(0, 11_999)}…` : s;
}

function readNicknames(file: string): Record<string, string> {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => typeof k === "string" && typeof v === "string")) as Record<string, string>;
  } catch { return {}; }
}

function writeNicknames(file: string, o: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
  } catch { /* best effort: the memory is a convenience, never the answer */ }
}
