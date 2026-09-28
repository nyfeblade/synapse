import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS5, MCP_HEADER_REDACTED, normalizeMcpHeaderValue, type AddMcpServerArgs, type McpServerView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { HostSettingsStore } from "../store/host-settings";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { slugify } from "../util/text";
import { isReservedMcpId } from "./reserved";

export interface RegistryServer {
  id: string;
  name: string;
  label: string | null;
  kind: "remote" | "command";
  url?: string;
  transport?: "http" | "sse";
  /** Always {} on disk and in memory since the header-vault fix: the values live sealed in
   *  remote-headers.sealed.json. Kept on the type so a registry written before the fix still parses
   *  and can be migrated (see the constructor). */
  headers?: Record<string, string>;
  /** The header NAMES a remote server sends (values: headersFor()). Names are not secret. */
  headerNames?: string[];
  command?: string;
  args?: string[];
  /** Always {} on disk and in memory since the vault fix: the values live sealed in command-env.sealed.json. */
  env?: Record<string, string>;
  /** The env NAMES a command server needs (values: envFor()). */
  envNames?: string[];
  catalogId: string | null;
  source: "curated" | "marketplace" | "custom";
  enabled: boolean;
  createdAt: number;
}

export { slugify } from "../util/text";

/**
 * A per-server map of secret values, sealed at rest with a vault subkey (AES-256-GCM), or kept in
 * memory when the caller has no key (unit tests). Both credential-bearing fields of an MCP server
 * use it: a command server's env and a remote server's request headers. The registry's own
 * servers.json keeps only the NAMES, so the file the app reads, backs up and snapshots has nothing
 * in it worth stealing.
 */
class SealedMap {
  private mem = new Map<string, Record<string, string>>();

  constructor(private file: string, private key?: Uint8Array) {}

  all(): Record<string, Record<string, string>> {
    if (!this.key) return Object.fromEntries(this.mem);
    const raw = readJson<{ v?: number; iv?: string; tag?: string; ct?: string }>(this.file, {});
    if (raw.v !== 1 || !raw.iv || !raw.tag || !raw.ct) return {};
    try {
      const dc = createDecipheriv("aes-256-gcm", this.key, Buffer.from(raw.iv, "base64"));
      dc.setAuthTag(Buffer.from(raw.tag, "base64"));
      return JSON.parse(Buffer.concat([dc.update(Buffer.from(raw.ct, "base64")), dc.final()]).toString("utf8")) as Record<string, Record<string, string>>;
    } catch { return {}; }
  }

  get(id: string): Record<string, string> {
    return { ...(this.all()[id] ?? {}) };
  }

  set(id: string, values: Record<string, string>): void {
    const all = this.all();
    if (Object.keys(values).length) all[id] = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
    else delete all[id];
    if (!this.key) { this.mem = new Map(Object.entries(all)); return; }
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
    writeJsonAtomic(this.file, { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }, 0o600);
  }
}

/** RFC 9110 field-name: a token. Deliberately not echoed back in the error — a user who pasted their
 *  key into the name box must not then see it quoted in a message that lands in a screenshot. */
const HTTP_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Headers the transport owns. Letting a user set these lets them break framing, not authenticate. */
const TRANSPORT_OWNED = /^(host|content-length|connection|transfer-encoding|upgrade)$/i;

/**
 * PLG header auth: every header value a caller supplies is treated as a credential, so this only
 * checks that the pair is a header at all. It never puts a value (or a name) in the error text.
 */
export function checkMcpHeader(name: string, value: string): void {
  if (!HTTP_TOKEN.test(name) || name.length > LIMITS5.mcpHeaderNameMax) {
    throw new GatewayError("BAD_ARGS", "A header name has to be a token like Authorization or x-api-key — letters, digits and !#$%&'*+-.^_`|~, no spaces.");
  }
  if (TRANSPORT_OWNED.test(name)) throw new GatewayError("BAD_ARGS", "That header is set by the connection itself and can't be overridden here.");
  if (!value) throw new GatewayError("BAD_ARGS", "Give the header a value, or remove the header.");
  if (/[\r\n\0]/.test(value)) throw new GatewayError("BAD_ARGS", "A header value can't contain line breaks or null bytes.");
  if (value.length > LIMITS5.mcpHeaderValueMax) throw new GatewayError("BAD_ARGS", `A header value can be at most ${LIMITS5.mcpHeaderValueMax} characters.`);
}

const READ_ONLY_MCP_NAME = /(^|_)(get|list|search|read|fetch|find|query|lookup|describe)(_|$)/i;

/**
 * P5 review I6: whether a connector tool may skip Auto-review as read-only. Name matching (get_/list_/search_…)
 * applies only to curated and user-trusted servers; any other server needs the tool's own readOnlyHint
 * AND the user's trust flag. The default is reviewed.
 */
export function mcpReadOnly(reg: McpRegistry, hint: (serverId: string, tool: string) => boolean | undefined): (serverId: string, tool: string) => boolean {
  return (serverId, tool) => {
    const s = reg.get(serverId);
    if (s?.source === "curated") return READ_ONLY_MCP_NAME.test(tool);
    return !!s && reg.isTrusted(serverId) && hint(serverId, tool) === true;
  };
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

export class McpRegistry {
  private servers: RegistryServer[];
  private session = new Map<string, Set<string>>();
  private file: string;

  private envStore: SealedMap;
  private headerStore: SealedMap;

  /** envKey / headerKey: the vault's HKDF subkeys for command-MCP env (open item 1) and for a remote
   *  server's request headers. Without one (unit tests) that store is kept in memory only. */
  constructor(private d: { dir: string; settings: HostSettingsStore; now(): number; onChange?(): void; envKey?: Uint8Array; headerKey?: Uint8Array }) {
    fs.mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(d.dir, 0o700);
    this.file = path.join(d.dir, "servers.json");
    this.envStore = new SealedMap(path.join(d.dir, "command-env.sealed.json"), d.envKey);
    this.headerStore = new SealedMap(path.join(d.dir, "remote-headers.sealed.json"), d.headerKey);
    this.servers = readJson<{ servers: RegistryServer[] }>(this.file, { servers: [] }).servers;
    // Migration: plaintext env from before the vault fix moves into the sealed store.
    const legacyEnv = this.servers.filter((s) => s.kind === "command" && s.env && Object.keys(s.env).length);
    for (const s of legacyEnv) { this.envStore.set(s.id, s.env!); s.envNames = Object.keys(s.env!).sort(); s.env = {}; }
    // The same migration for headers: a servers.json written before header auth was sealed has the
    // key sitting in it in clear text. Move it into the vault and erase it from the file on sight —
    // the old bytes only stop existing once this rewrite happens.
    const legacyHeaders = this.servers.filter((s) => s.kind === "remote" && s.headers && Object.keys(s.headers).length);
    for (const s of legacyHeaders) { this.headerStore.set(s.id, s.headers!); s.headerNames = Object.keys(s.headers!).sort(); s.headers = {}; }
    if (legacyEnv.length || legacyHeaders.length) this.save();
  }

  /** Open item 1: a command server's env values, from the vault; only the host-proxied server process gets them. */
  envFor(id: string): Record<string, string> {
    return this.envStore.get(id);
  }

  /** PLG header auth: a remote server's header values, from the vault; only its own outbound
   *  request gets them. Never published, never written to servers.json, never logged. */
  headersFor(id: string): Record<string, string> {
    return this.headerStore.get(id);
  }

  /** Every sealed value this server holds, for scrubbing an error string that quoted one back. */
  sealedValues(id: string): string[] {
    return [...Object.values(this.envFor(id)), ...Object.values(this.headersFor(id))].filter(Boolean);
  }

  list(): RegistryServer[] {
    return [...this.servers];
  }

  get(id: string): RegistryServer | undefined {
    return this.servers.find((s) => s.id === id);
  }

  byCatalogId(catalogId: string): RegistryServer[] {
    return this.servers.filter((s) => s.catalogId === catalogId);
  }

  add(a: AddMcpServerArgs & { label?: string | null }, source: RegistryServer["source"], catalogId: string | null = null): RegistryServer {
    const name = a.name?.trim();
    if (!name) throw new GatewayError("BAD_ARGS", "Give the server a name.");
    // Final secfix item 4: google, bot, computer, probe and claude_ai_* belong to the app itself.
    if (isReservedMcpId(name)) throw new GatewayError("BAD_ARGS", `“${name.slice(0, 60)}” is a reserved server name. Pick another name.`);
    if (!!a.url === !!a.command) throw new GatewayError("BAD_ARGS", "Give either a url or command.");
    if (a.url && !/^https:\/\//.test(a.url)) throw new GatewayError("BAD_ARGS", "Remote MCP servers must use https.");
    // Header auth is a property of the HTTP transport. Checked before the id is minted so a rejected
    // server leaves nothing behind, and after the https check so a credential can never be paired
    // with a plaintext url even momentarily.
    const headers = Object.entries(a.headers ?? {}).map(([k, v]) => [k, normalizeMcpHeaderValue(k, String(v))] as const);
    if (headers.length && !a.url) throw new GatewayError("BAD_ARGS", "Headers are for remote (https) MCP servers. A local command server takes env instead.");
    if (headers.length > LIMITS5.mcpHeadersMax) throw new GatewayError("BAD_ARGS", `An MCP server can have at most ${LIMITS5.mcpHeadersMax} headers.`);
    for (const [k, v] of headers) checkMcpHeader(k, v);
    const label = a.label?.trim() || null;
    let id = slugify(label ? `${name}-${label}` : name);
    for (let n = 2; this.get(id); n++) id = `${slugify(label ? `${name}-${label}` : name)}-${n}`;
    if (isReservedMcpId(id)) throw new GatewayError("BAD_ARGS", `“${id}” is a reserved server name. Pick another name.`);
    const s: RegistryServer = {
      id,
      name,
      label,
      kind: a.url ? "remote" : "command",
      catalogId: catalogId ?? a.catalogId ?? null,
      source,
      enabled: true,
      createdAt: this.d.now(),
      ...(a.url
        ? { url: a.url, transport: "http" as const, headers: {}, headerNames: headers.map(([k]) => k).sort() }
        : { command: a.command!.trim(), args: a.args ?? [], env: {}, envNames: Object.keys(a.env ?? {}).sort() }),
    };
    // Sealing happens HERE, at the one door every caller comes through — the add-server form, a
    // plugin marketplace's .mcp.json (plugin-marketplaces.ts) and the Bot-facing AddMcpServer tool.
    // None of them has to know it is handling a credential for the credential to end up sealed.
    if (a.url) this.headerStore.set(id, Object.fromEntries(headers.map(([k, v]) => [k, String(v)])));
    else this.envStore.set(id, a.env ?? {});
    this.servers.push(s);
    this.save();
    return s;
  }

  rename(id: string, label: string): RegistryServer {
    const s = this.require(id);
    s.label = label.trim().slice(0, 40) || null;
    this.save();
    return s;
  }

  /**
   * Set, replace or (value === null) remove one request header on a remote server. The value goes
   * straight into the sealed store; only the name is written to servers.json, and nothing here
   * returns a value to the caller — replacing a key is a write-only operation, the way a Bot secret
   * is (SecretsSection).
   */
  setHeader(id: string, name: string, value: string | null): RegistryServer {
    const s = this.require(id);
    if (s.kind !== "remote") throw new GatewayError("BAD_ARGS", "Headers are for remote (https) MCP servers. A local command server takes env instead.");
    const current = this.headersFor(id);
    if (value === null) {
      delete current[name];
    } else {
      const stored = normalizeMcpHeaderValue(name, value);
      checkMcpHeader(name, stored);
      if (!(name in current) && Object.keys(current).length >= LIMITS5.mcpHeadersMax) throw new GatewayError("BAD_ARGS", `An MCP server can have at most ${LIMITS5.mcpHeadersMax} headers.`);
      current[name] = stored;
    }
    this.headerStore.set(id, current);
    s.headerNames = Object.keys(current).sort();
    s.headers = {};
    this.save();
    return s;
  }

  remove(id: string): void {
    this.require(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    this.envStore.set(id, {});
    this.headerStore.set(id, {});
    const disabled = { ...this.disabledMap() };
    delete disabled[id];
    this.d.settings.setExtra("mcpDisabledToolsByServerId", disabled);
    const instructions = { ...this.d.settings.extra<Record<string, string>>("mcpCustomInstructions", {}) };
    delete instructions[id];
    this.d.settings.setExtra("mcpCustomInstructions", instructions);
    this.d.settings.setExtra("mcpTrustedServerIds", this.d.settings.extra<string[]>("mcpTrustedServerIds", []).filter((x) => x !== id));
    this.save();
  }

  setEnabled(id: string, on: boolean): void {
    this.require(id).enabled = on;
    this.save();
  }

  /** I6: the user marks a non-curated server as trusted (its readOnlyHint tools may then skip review). */
  setTrusted(serverId: string, trusted: boolean): void {
    this.require(serverId);
    const set = new Set(this.d.settings.extra<string[]>("mcpTrustedServerIds", []));
    if (trusted) set.add(serverId);
    else set.delete(serverId);
    this.d.settings.setExtra("mcpTrustedServerIds", [...set].sort());
    this.d.onChange?.();
  }

  isTrusted(serverId: string): boolean {
    return this.d.settings.extra<string[]>("mcpTrustedServerIds", []).includes(serverId);
  }

  setToolEnabled(serverId: string, tool: string, enabled: boolean): void {
    const map = { ...this.disabledMap() };
    const set = new Set(map[serverId] ?? []);
    if (enabled) set.delete(tool);
    else set.add(tool);
    if (set.size) map[serverId] = [...set].sort();
    else delete map[serverId];
    this.d.settings.setExtra("mcpDisabledToolsByServerId", map);
    this.d.onChange?.();
  }

  disabledTools(serverId: string): string[] {
    return this.disabledMap()[serverId] ?? [];
  }

  setInstructions(serverId: string, text: string): void {
    const map = { ...this.d.settings.extra<Record<string, string>>("mcpCustomInstructions", {}) };
    const t = text.trim().slice(0, LIMITS5.mcpInstructionsMax);
    if (t) map[serverId] = t;
    else delete map[serverId];
    this.d.settings.setExtra("mcpCustomInstructions", map);
    this.d.onChange?.();
  }

  instructions(serverId: string): string {
    return this.d.settings.extra<Record<string, string>>("mcpCustomInstructions", {})[serverId] ?? "";
  }

  /** Open item 1: a command server that needs env (API keys) is host-proxied like a remote one, so the values reach
   *  only its own process and never the Bot's CLI config or env. */
  hostProxied(s: RegistryServer): boolean {
    return s.kind === "remote" || (s.kind === "command" && (s.envNames?.length ?? 0) > 0);
  }

  /** PLG-08: local `command` servers WITHOUT env run as user box under the CLI; the rest go through the host proxy. */
  commandServerConfigs(): Record<string, McpStdioServerConfig> {
    return Object.fromEntries(
      this.servers
        .filter((s) => s.enabled && s.kind === "command" && !this.hostProxied(s))
        .map((s) => [s.id, { type: "stdio" as const, command: s.command!, args: s.args ?? [], env: {} }]),
    );
  }

  /** PLG-02 toggles for servers the CLI connects itself (command). Proxied remote servers filter their own lists. */
  disallowedToolNames(): string[] {
    return Object.entries(this.disabledMap())
      .filter(([id]) => { const s = this.get(id); return !!s && s.kind === "command" && !this.hostProxied(s); })
      .flatMap(([id, tools]) => tools.map((t) => `mcp__${id}__${t}`));
  }

  /** CT-12 flag "hook": the tool stays listed, so a PreToolUse deny enforces the toggle. */
  guardTool(toolName: string): string | null {
    const p = parseMcpToolName(toolName);
    if (!p || p.server === "bot") return null;
    return this.disabledTools(p.server).includes(p.tool) ? `The user turned off ${p.tool} for ${this.displayName(p.server)}. Don't use it.` : null;
  }

  systemAppendExtra(): string {
    // Bug 54: a server the user turned off is left out of the Bot's spawn, so its note would tell the
    // Bot how to use a connector it cannot reach.
    const lines = this.servers.filter((s) => s.enabled).map((s) => s.id)
      .map((id) => [id, this.instructions(id)] as const)
      .filter(([, t]) => t)
      .map(([id, t]) => `- ${this.displayName(id)}: ${t}`);
    return lines.length ? `# Connector notes\n${lines.join("\n")}` : "";
  }

  noteSessionTools(tools: string[]): void {
    const next = new Map<string, Set<string>>();
    for (const t of tools) {
      const p = parseMcpToolName(t);
      if (!p || p.server === "bot") continue;
      if (this.get(p.server)?.kind !== "command") continue;
      if (!next.has(p.server)) next.set(p.server, new Set());
      next.get(p.server)!.add(p.tool);
    }
    const changed = JSON.stringify([...next].map(([k, v]) => [k, [...v]])) !== JSON.stringify([...this.session].map(([k, v]) => [k, [...v]]));
    this.session = next;
    if (changed) this.d.onChange?.();
  }

  sessionTools(serverId: string): string[] {
    return [...(this.session.get(serverId) ?? [])].sort();
  }

  view(id: string, status: McpServerView["status"], toolDescriptions: Map<string, string> = new Map(), error: string | null = null): McpServerView {
    const s = this.get(id);
    const off = new Set(this.disabledTools(id));
    const names = toolDescriptions.size ? [...toolDescriptions.keys()] : this.sessionTools(id);
    return {
      id,
      name: s ? s.name : id,
      label: s?.label ?? null,
      kind: s ? s.kind : "command",
      status: s && !s.enabled ? "disabled" : status,
      catalogId: s?.catalogId ?? null,
      tools: names.sort().map((n) => ({ name: n, description: toolDescriptions.get(n) ?? "", enabled: !off.has(n) })),
      instructions: this.instructions(id),
      error,
      trusted: this.isTrusted(id),
      // Built from the NAMES on disk, never from the sealed store: there is no code path from
      // headersFor() to a view, so a view cannot carry a value even by mistake.
      ...(s?.kind === "remote" ? { headers: (s.headerNames ?? []).map((name) => ({ name, value: MCP_HEADER_REDACTED })) } : {}),
    };
  }

  private displayName(id: string): string {
    const s = this.get(id);
    return s ? (s.label ? `${s.name} (${s.label})` : s.name) : id;
  }

  private disabledMap(): Record<string, string[]> {
    return this.d.settings.extra<Record<string, string[]>>("mcpDisabledToolsByServerId", {});
  }

  private require(id: string): RegistryServer {
    const s = this.get(id);
    if (!s) throw new GatewayError("NOT_FOUND", `No MCP server ${id}`, 404);
    return s;
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, servers: this.servers }, 0o600);
    this.d.onChange?.();
  }
}
