/**
 * SAFETY v2 — THE HARD CORE (docs/superpowers/specs/2026-09-30-safety-v2-design.md §1).
 *
 * Unbreakable in every mode (No limits included), by any rule, even when the reviewer is fooled. A hit is a deny the
 * owner can't approve from a card. It runs in ApprovalGate.preToolUse before rules, plans, trusted people, Full auto's
 * intent check and the reviewer. The kernel firewall (bots_mac_guard) and the guarded fetch enforce the network half
 * below the gate; this is the same promise at the level of what the Bot asks for, so a card never even offers it.
 *
 * Kept elsewhere and unchanged (also hard core): the host's private folder (classify.ts hardDeny), the fixed NEVER
 * walls on the Mac (keychain, secret stores, OrbStack's CLI, container engines: shared/perm-rules.ts), and the F7 /
 * F8-safety-controls cards no rule, mode or reviewer can skip (host/review/static.ts, reviewer S3).
 */
import path from "node:path";
import { hostListed, parseShell, netRequest, type ActionKind, type BotNetwork } from "@synapse/shared";
import type { ToolCall } from "../brain/types";
import type { Classification } from "./classify";

export interface HardCoreEnv {
  /** Synapse's own settings and rules live here (settings.json). */
  dataRoot: string;
  hostPrivate: string;
  workspace: string;
  /** Settings → Local network is on (box and Bots may reach RFC 1918 / ULA). */
  lanOpen(): boolean;
  /** The Bot's network list, or null when open. */
  network(botId: string): BotNetwork | null;
}

export const HARD = {
  secrets: "This touches Synapse's own settings, keys or private data. Bots can never do that.",
  mac: "Bots can't reach your Mac.",
  lan: "Bots can't reach your local network. Turn on Local network in Settings to allow it.",
  firewall: "This changes the Bots' firewall or network guard. Bots can never do that.",
  lockedUpload: (host: string) => `This Bot's network is limited to the sites you chose, and ${host} isn't one of them.`,
  lockedUnknown: "This Bot's network is limited to the sites you chose, and where this goes can't be read.",
  blocked: (host: string) => `You blocked ${host} for this Bot.`,
} as const;

/** The Mac as the box sees it: OrbStack's names and addresses (bots-ports MAC_NAMES, MAC4_FIXED, ORB4, ORB6). */
const MAC_REF = /(^|[^\w.-])(host\.docker\.internal|gateway\.docker\.internal|host\.orb\.internal|host\.internal|docker\.for\.mac\.(?:host\.)?internal)(?=$|[^\w-])|(^|[^\d.])0\.250\.250\.\d{1,3}(?=$|[^\d])|(^|[^\d.])198\.19\.249\.1(?=$|[^\d])|fd07:b51a:cc66:/i;
const FIREWALL_PROG = /^(nft|iptables|ip6tables|iptables-(?:save|restore|legacy|nft)|ip6tables-(?:save|restore|legacy|nft)|ebtables|arptables|ufw|firewall-cmd|bots-ports)$/;
const FIREWALL_TEXT = /\/etc\/bots(\/|\b)|\/etc\/nftables|\/usr\/local\/lib\/bots\/bots-ports|bots_mac_guard|bots_auth_proxy|bots-auth-proxy|net-guard\.conf/;
const IPV4 = /(?:^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^\d.])/g;
const IPV6_LOCAL = /(?:^|[^\w:])((?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*)/gi;

/** A private IPv4 literal: the LAN (RFC 1918), link-local and CGNAT/Tailscale. Loopback is the box's own. */
function lanV4(ip: string): "lan" | "never" | null {
  const o = ip.split(".").map(Number);
  if (o.some((x) => !(x >= 0 && x <= 255))) return null;
  const [a, b] = o as [number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if ((a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return "never";
  return null;
}

/** What an action's words say it does, not what it carries: a file's contents, a message's body or a task's prompt
 *  can mention anything without doing it. */
const CARRIED = /^(content|contents|body|text|message|message_body|new_string|old_string|edits|description|summary|subject|html|markdown|markdown_text|prompt|notes?|comment|caption|title|query|instructions)$/i;
/** Every string an action carries (command, paths, URLs, connector arguments), capped. */
function textOf(call: ToolCall): string {
  const out: string[] = [];
  const walk = (v: unknown, d: number, key: string | null) => {
    if (d > 5 || out.length > 200 || (key && CARRIED.test(key))) return;
    if (typeof v === "string") out.push(v.slice(0, 20_000));
    else if (Array.isArray(v)) v.slice(0, 100).forEach((x) => walk(x, d + 1, key));
    else if (v && typeof v === "object") Object.entries(v as Record<string, unknown>).slice(0, 100).forEach(([k, x]) => walk(x, d + 1, k));
  };
  walk(call.input, 0, null);
  return out.join("\n");
}

/**
 * The sites an action names: hosts from curl/wget/httpie/xh (null when one can't be read), URLs anywhere in its
 * text, and scp/rsync style `host:path`. `unknown` means a network command whose target couldn't be read.
 */
export function hostsOf(call: ToolCall, cls: Classification, home = "/home/box"): { hosts: string[]; unknown: boolean } {
  const hosts = new Set<string>();
  let unknown = false;
  const text = textOf(call);
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[0-9a-f:]+\]|[^\s/'"?#:]+)/gi)) hosts.add(m[1]!.toLowerCase().replace(/^\[|\]$/g, ""));
  const command = cls.target?.action === "shell" ? String(cls.target.arguments.command ?? "") : "";
  if (command) {
    for (const m of command.matchAll(/(?:^|\s)(?:[\w.-]+@)?((?:[a-z0-9-]+\.)+[a-z]{2,}):(?!\/\/)/gi)) hosts.add(m[1]!.toLowerCase());
    try {
      const cwd = typeof cls.target?.arguments.working_directory === "string" ? cls.target.arguments.working_directory : null;
      for (const c of parseShell(command, { cwd, home }).cmds) {
        if (!/^(curl|wget|http|https|xh|xhs)$/.test(c.program)) continue;
        for (const h of netRequest(c).hosts) { if (h === null) unknown = true; else hosts.add(h); }
      }
    } catch { unknown = true; }
  }
  return { hosts: [...hosts].filter((h) => h && h !== "localhost"), unknown };
}

/** The hard core's verdict for one call: a deny reason, or null. `kinds` are the classifier's (No limits never lifts them). */
export function hardCore(botId: string, call: ToolCall, cls: Classification, kinds: readonly ActionKind[], env: HardCoreEnv): string | null {
  if (!cls.surface || !cls.target) return null;
  const text = textOf(call);
  // 1. Synapse's own settings and rules (settings.json is in the data root; the rest is the host's private folder).
  const settingsFile = path.join(env.dataRoot, "settings.json");
  if (text.includes(settingsFile) || text.includes(env.hostPrivate)) return HARD.secrets;
  // …however it's spelled: a relative path, `~`, doubled slashes, or `cd agent-data && … settings.json`.
  const norm = text.replace(/\/{2,}/g, "/");
  if (norm.includes(settingsFile) || (/(^|[\s/'"])settings\.json\b/.test(norm) && norm.includes(path.basename(env.dataRoot)))) return HARD.secrets;
  // The network half is about the Bots' own connections from the box (its shell, its browser, its screen). The Mac's
  // own tools act on the Mac by design, and connector calls go out through the host's guarded fetch.
  const box = cls.surface === "box_shell" || cls.surface === "computer" || cls.target.action === "browser";
  if (box) {
    // 2. The Mac and the LAN, from the box.
    if (MAC_REF.test(text)) return HARD.mac;
    let open: boolean | null = null;
    const lanOpen = (): boolean => (open ??= env.lanOpen()); // read only when an address is named (a file read per call otherwise)
    for (const m of text.matchAll(IPV4)) {
      const v = lanV4(m[1]!);
      if (v === "never" || (v === "lan" && !lanOpen())) return v === "never" ? HARD.mac : HARD.lan;
    }
    for (const m of text.matchAll(IPV6_LOCAL)) {
      const a = m[1]!.toLowerCase();
      if (a.startsWith("fe") || !lanOpen()) return a.startsWith("fe") ? HARD.mac : HARD.lan;
    }
    if (/\b[a-z0-9-]+\.local(?=$|[^\w.-])/i.test(text) && !lanOpen() && /:\/\/|@|\bping\b|\bssh\b|\bcurl\b|\bwget\b|\bnc\b/.test(text)) return HARD.lan;
    // 3. The Bots' firewall and network guard.
    if (cls.surface === "box_shell") {
      const command = cls.target.action === "shell" ? String(cls.target.arguments.command ?? "") : "";
      const p = String(cls.target.arguments.path ?? call.input.file_path ?? "");
      if (FIREWALL_TEXT.test(command) || FIREWALL_TEXT.test(p)) return HARD.firewall;
      if (command) {
        try {
          for (const c of parseShell(command, { cwd: env.workspace, home: "/home/box" }).cmds) {
            const progs = [c.program, ...c.argv.slice(0, 3).map((w) => path.basename(w.text))];
            if (progs.some((x) => FIREWALL_PROG.test(x))) return HARD.firewall;
          }
        } catch { /* unparseable: the text check above still ran */ }
        if (/(^|[\s;&|`(])(sudo\s+)?(nft|iptables|ip6tables|ufw|bots-ports)(\s|$)/.test(command)) return HARD.firewall;
      }
    }
  }
  // 4. A locked network: uploads to, and fetch-and-run from, anywhere outside the list. A block list stops any
  //    request the gate can read to a blocked site.
  const net = env.network(botId);
  if (net && net.mode !== "open" && box) {
    const { hosts, unknown } = hostsOf(call, cls);
    if (net.mode === "block") {
      const hit = hosts.find((h) => hostListed(h, net.hosts));
      if (hit) return HARD.blocked(hit);
    } else if (kinds.includes("upload") || kinds.includes("fetch-run")) {
      const out = hosts.find((h) => !hostListed(h, net.hosts));
      if (out) return HARD.lockedUpload(out);
      if (unknown || !hosts.length) return HARD.lockedUnknown;
    }
  }
  return null;
}
