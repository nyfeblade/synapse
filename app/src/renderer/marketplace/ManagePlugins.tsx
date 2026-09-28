import { useEffect, useState } from "react";
import { STR, STR5, normalizeMcpHeaderValue, type McpServerView, type PluginMarketplaceView, type SkillView } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { call, callQuiet } from "../bridge";
import { Async } from "../components/Async";
import { messageOf } from "../error-channel";
import { subscribeChannel } from "../feature-store";
import { registerManagePage } from "./MarketplaceModal";
import { authorize, useMarketplace } from "./store";
import { useOverlays } from "../overlays";
import { askConfirm } from "../components/ConfirmDialog";
import { GITHUB_HEADER, SLACK_HEADER, applyCustomMcpPreset, isComposioCustomServer, isGithubCustomServer, isSlackCustomServer } from "./custom-mcp-preset";

function isSlackServer(s: McpServerView): boolean {
  return s.catalogId === "curated:slack" || isSlackCustomServer(s.name, "");
}

function isGithubServer(s: McpServerView): boolean {
  return s.catalogId === "curated:github" || isGithubCustomServer(s.name, "");
}

function headerAuthPreset(s: McpServerView): string | null {
  if (isSlackServer(s)) return SLACK_HEADER;
  if (isGithubServer(s)) return GITHUB_HEADER;
  return null;
}

function headerHintFor(name: string, url = "", server?: McpServerView): string {
  if (server && isGithubServer(server)) return STR5.githubHeaderHint;
  if (server && isSlackServer(server)) return STR5.slackHeaderHint;
  if (isComposioCustomServer(name, url)) return STR5.composioHeaderHint;
  if (isSlackCustomServer(name, url)) return STR5.slackHeaderHint;
  if (isGithubCustomServer(name, url)) return STR5.githubHeaderHint;
  return STR5.headerHint;
}

/**
 * A remote server's request headers (PLG header auth). This is SecretsSection's shape, for the same
 * reason: the host seals the value, so all this component ever has is the header NAME and the
 * redaction the host put in its place. There is nothing to read back and no state here that holds a
 * value beyond the keystroke that sends it — `value` is cleared the moment the call returns, and a
 * Replace field starts empty because a full one would mean the host had handed the key back.
 */
function HeaderRows({ s }: { s: McpServerView }) {
  // Slack's hosted MCP does not complete our generic Authorize flow. Open the token field on a
  // Slack card that has no Authorization header so the user pastes xoxp- instead of bouncing
  // into the Slack app.
  const preset = headerAuthPreset(s);
  const needsToken = Boolean(preset) && !(s.headers ?? []).some((h) => /^authorization$/i.test(h.name));
  // null = closed, "" = adding a new header, otherwise the name of the header being replaced.
  const [editing, setEditing] = useState<string | null>(needsToken ? "" : null);
  const [name, setName] = useState(needsToken ? preset ?? "" : "");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => { setEditing(null); setName(""); setValue(""); };
  const send = (headerName: string, v: string | null) => {
    setError(null);
    const stored = v === null ? null : normalizeMcpHeaderValue(headerName, v);
    call("setMcpServerHeader", { serverId: s.id, name: headerName, value: stored }).then(close, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="manage-headers">
      <span className="muted">{STR5.serverHeaders}</span>
      {(s.headers ?? []).map((h) => (
        <div key={h.name} className="settings-row">
          <span style={{ flexGrow: 1 }}>{h.name}</span>
          <span className="muted">{h.value}</span>
          {editing !== h.name && (
            <>
              <button type="button" className="btn-outline small" aria-label={STR5.replaceHeader(h.name)} onClick={() => { setName(h.name); setValue(""); setError(null); setEditing(h.name); }}>{STR5.replace}</button>
              <button type="button" className="btn-outline small" aria-label={STR5.removeHeader(h.name)} onClick={() => send(h.name, null)}>{STR5.remove}</button>
            </>
          )}
        </div>
      ))}
      {editing === null ? (
        <button type="button" className="btn-outline small" onClick={() => { setName(preset ?? ""); setValue(""); setError(null); setEditing(""); }}>{STR5.addHeader}</button>
      ) : (
        <div className="settings-row">
          {editing === "" && (
            <>
              <label htmlFor={`hdr-name-${s.id}`}>{STR5.headerName}</label>
              <input id={`hdr-name-${s.id}`} className="text-input narrow" value={name} onChange={(e) => setName(e.target.value)} />
            </>
          )}
          <label htmlFor={`hdr-value-${s.id}`}>{STR5.headerValue}</label>
          <input id={`hdr-value-${s.id}`} type="password" autoComplete="off" className="text-input" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="btn-primary" disabled={!name.trim() || !value} onClick={() => send(name.trim(), value)}>{STR5.saveHeader}</button>
          <button type="button" className="btn-outline small" onClick={close}>{STR.cancel}</button>
        </div>
      )}
      <span className="muted small">{headerHintFor(s.name, "", s)}</span>
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

/**
 * Bug 53: this row used to render `statusLabel[s.status]` and a Remove button, and nothing else.
 * A server the user added by hand never appears in the catalog, so `MarketplaceModal`'s Authorize
 * pill could not render for it, and "Needs sign-in" was a dead end whose only exit was deleting the
 * server. Every status that reports a PROBLEM now carries the control that resolves it, and each
 * one goes through a command that already existed — `authorize()` (startMcpAuth + the browser tab,
 * the same call the catalog pill and the connect card make) and `restartMcpServers`.
 *
 * `server-row-actions.test.tsx` holds the rule for the whole set: every McpServerStatus is declared
 * as either an action proven by pressing it here, or a reason it needs none.
 */
function Server({ s }: { s: McpServerView }) {
  const [label, setLabel] = useState(s.label ?? "");
  const [instr, setInstr] = useState(s.instructions);
  // A sign-in whose browser tab we just opened. The host's `waiting-auth` publish is a round trip
  // away, and a row still reading "Needs sign-in" over an open sign-in page is the same defect in a
  // new costume — so the row says so itself and lets the host confirm it.
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (s.status !== "needs-auth") setStarting(false); }, [s.status]);
  const status = starting && s.status === "needs-auth" ? "waiting-auth" : s.status;
  const title = s.label ? `${s.name} (${s.label})` : s.name;
  // A refusal belongs in the row that asked for it: the user pressed a button on THIS server.
  const run = (p: Promise<unknown>) => { setError(null); p.catch((e: unknown) => { setStarting(false); setError(e instanceof Error ? e.message : String(e)); }); };
  const signIn = () => { setStarting(true); run(authorize(s.id)); };
  return (
    <div role="group" aria-label={title} className="settings-card manage-server">
      <div className="settings-row"><span style={{ flexGrow: 1 }}>{title}</span><span className="muted">{STR5.statusLabel[status]}</span>
        {status === "needs-auth" && <button type="button" className="btn-outline small" aria-label={`${STR5.authorize} ${title}`} onClick={signIn}>{STR5.authorize}</button>}
        {status === "waiting-auth" && <button type="button" className="btn-outline small" aria-label={`${STR5.reopen} ${title}`} onClick={signIn}>{STR5.reopen}</button>}
        {status === "failed" && <button type="button" className="btn-outline small" aria-label={`${STR.retry} ${title}`} onClick={() => run(call("restartMcpServers", { serverId: s.id }))}>{STR.retry}</button>}
        <button
          type="button"
          role="switch"
          aria-checked={status !== "disabled"}
          aria-label={`${status === "disabled" ? STR5.turnOn : STR5.turnOff} ${title}`}
          className={status !== "disabled" ? "switch on" : "switch"}
          onClick={() => run(call("setMcpServerEnabled", { serverId: s.id, enabled: status === "disabled" }))}
        />
        <button type="button" className="danger-btn" onClick={() => void askConfirm({ title: `Remove ${s.name}?`, verb: STR5.remove }).then((ok) => { if (ok) void call("removeMcpServer", { serverId: s.id }); })}>{STR5.remove}</button></div>
      {error && <span className="error" role="alert">{error}</span>}
      {s.error && <span className="error">{s.error}</span>}
      {s.tools.map((t) => (
        <div key={t.name} className="settings-row tool-row">
          <span style={{ flexGrow: 1 }} title={t.description}>{t.name}</span>
          <button type="button" role="switch" aria-checked={t.enabled} aria-label={t.name} className={t.enabled ? "switch on" : "switch"}
            onClick={() => void call("setMcpToolEnabled", { serverId: s.id, tool: t.name, enabled: !t.enabled })} />
        </div>
      ))}
      {s.kind === "remote" && !s.catalogId?.startsWith("curated:") && (
        <div className="settings-row">
          <span style={{ flexGrow: 1 }} className="muted">{STR5.trustServer}</span>
          <button type="button" role="switch" aria-checked={!!s.trusted} aria-label={STR5.trustServer} className={s.trusted ? "switch on" : "switch"}
            onClick={() => void call("setMcpServerTrusted", { serverId: s.id, trusted: !s.trusted })} />
        </div>
      )}
      {s.kind === "remote" && <HeaderRows s={s} />}
      <div className="settings-row">
        <label htmlFor={`label-${s.id}`}>{STR5.accountLabel}</label>
        <input id={`label-${s.id}`} className="text-input narrow" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className="btn-outline small" disabled={label === (s.label ?? "")} onClick={() => void call("renameMcpAccount", { serverId: s.id, label })}>{STR5.rename}</button>
      </div>
      <label htmlFor={`instr-${s.id}`} className="muted">{STR5.instructions}</label>
      <textarea id={`instr-${s.id}`} className="text-area" maxLength={500} value={instr} onChange={(e) => setInstr(e.target.value)}
        onBlur={() => { if (instr !== s.instructions) void call("setMcpInstructions", { serverId: s.id, instructions: instr }); }} />
    </div>
  );
}

function AddServer({ onDone }: { onDone(): void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  // One header pair, because the real shape of this is one auth header. More than one is set on the
  // server's own card afterwards; that path is the same gateway command.
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const halfHeader = !headerName.trim() !== !headerValue;
  const applyPreset = (nextName: string, nextUrl: string, nextHeader: string) => {
    const next = applyCustomMcpPreset(nextName, nextUrl, nextHeader);
    if (next.url !== nextUrl) setUrl(next.url);
    if (next.headerName !== nextHeader) setHeaderName(next.headerName);
  };
  const submit = async () => {
    try {
      const parts = command.trim().split(/\s+/).filter(Boolean);
      const headers = headerName.trim() && headerValue ? { headers: { [headerName.trim()]: normalizeMcpHeaderValue(headerName.trim(), headerValue) } } : {};
      await call("addMcpServer", url.trim() ? { name: name.trim(), url: url.trim(), ...headers } : { name: name.trim(), command: parts[0]!, args: parts.slice(1) });
      onDone();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="settings-card">
      <label htmlFor="srv-name">{STR5.serverName}</label><input id="srv-name" className="text-input" value={name} onChange={(e) => { const v = e.target.value; setName(v); applyPreset(v, url, headerName); }} />
      <label htmlFor="srv-url">{STR5.serverUrl}</label><input id="srv-url" className="text-input" placeholder="https://" value={url} onChange={(e) => { const v = e.target.value; setUrl(v); applyPreset(name, v, headerName); }} />
      <label htmlFor="srv-hdr-name">{STR5.headerName}</label><input id="srv-hdr-name" className="text-input" value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
      <label htmlFor="srv-hdr-value">{STR5.headerValue}</label><input id="srv-hdr-value" type="password" autoComplete="off" className="text-input" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} />
      <span className="muted small">{headerHintFor(name, url)}</span>
      <label htmlFor="srv-cmd">{STR5.serverCommand}</label><input id="srv-cmd" className="text-input" value={command} onChange={(e) => setCommand(e.target.value)} />
      {error && <span className="error" role="alert">{error}</span>}
      <button type="button" className="btn-primary" disabled={!name.trim() || (!url.trim() && !command.trim()) || halfHeader} onClick={() => void submit()}>{STR5.add}</button>
    </div>
  );
}

/**
 * A list read that fails says WHICH list it was. <Async /> renders the message as the alert, and
 * two lists on one tab each failing with the host's bare "Could not reach the computer" would not
 * tell the user which one to retry.
 */
const readList = <T,>(what: string, p: Promise<T>): Promise<T> => p.catch((e: unknown) => { throw new Error(`${what} ${messageOf(e)}`); });

/**
 * Bug 37: this used to hold three lists as `useState([])` / `null` and turn every failed read into
 * an empty list, so "still loading", "you have none" and "the host said no" were one blank pane.
 * Each list is now its own `useAsync` resource rendered through <Async />, which owns the loading
 * and error arms (named per list, with a Retry that re-reads only that list); the ready arm writes
 * the deliberate empty copy. Reads are `callQuiet` because the failure is presented here, in place
 * of the list it replaces — a banner as well would say it twice.
 */
export function ManagePlugins() {
  const [tab, setTab] = useState<"installed" | "skills">("installed");
  const servers = useAsync(() => readList(STR5.serversLoadFailed, callQuiet("listMcpServers", {}).then((r) => r.servers)), []);
  const markets = useAsync(() => readList(STR5.marketplacesLoadFailed, callQuiet("listPluginMarketplaces", {}).then((r) => r.marketplaces)), []);
  // Read when the tab is first opened, and again on each re-open (skills are edited in another overlay).
  const skills = useAsync(() => readList(STR5.skillsLoadFailed, callQuiet("getWorkflows", {}).then((r) => r.workflows)), [], { enabled: tab === "skills" });
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState("");
  const [marketError, setMarketError] = useState<string | null>(null);
  // Task 34 fuzz: a rejected source (file:///, http://) used to fail silently as an uncaught rejection.
  const marketCall = (p: Promise<unknown>, after: () => void) => { setMarketError(null); p.then(after, (e: unknown) => setMarketError(e instanceof Error ? e.message : String(e))); };
  // The host publishes the whole list on every status change; a publish is a fresh answer, so it
  // also replaces a failed read.
  useEffect(() => subscribeChannel("mcp-servers", (p) => servers.setValue(p.servers)), [servers.setValue]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-label={STR5.managePlugins} className="manage">
      <h3>{STR5.managePlugins}</h3>
      <div role="tablist" className="tabs">
        <button role="tab" type="button" aria-selected={tab === "installed"} onClick={() => setTab("installed")}>{STR5.installedTab}</button>
        <button role="tab" type="button" aria-selected={tab === "skills"} onClick={() => setTab("skills")}>{STR5.privateSkillsTab}</button>
      </div>
      {tab === "installed" && (
        <div role="tabpanel" className="manage-list">
          <Async resource={servers} label={STR5.installedTab}>
            {(list: McpServerView[]) => (
              <>
                {list.length === 0 && !adding && <p className="muted">{STR5.noServers}</p>}
                {list.map((s) => <Server key={s.id} s={s} />)}
              </>
            )}
          </Async>
          {adding ? <AddServer onDone={() => { setAdding(false); servers.reload(); }} /> : <button type="button" className="btn-outline" onClick={() => setAdding(true)}>{STR5.addCustomServer}</button>}
          <h4>{STR5.marketplaces}</h4>
          <Async resource={markets} label={STR5.marketplaces}>
            {(list: PluginMarketplaceView[]) => (
              <>
                {list.length === 0 && <p className="muted">{STR5.noMarketplaces}</p>}
                {list.map((m) => <div key={m.name} className="settings-row"><span style={{ flexGrow: 1 }}>{m.name}</span><span className="muted">{m.pluginCount}</span><button type="button" className="danger-btn" onClick={() => marketCall(call("removePluginMarketplace", { name: m.name }), markets.reload)}>{STR5.remove}</button></div>)}
              </>
            )}
          </Async>
          <div className="settings-row">
            <input aria-label={STR5.marketplaceSource} placeholder={STR5.marketplaceSource} className="text-input" value={source} onChange={(e) => setSource(e.target.value)} />
            <button type="button" className="btn-outline small" disabled={!source.trim()} onClick={() => marketCall(call("addPluginMarketplace", { source }), () => { setSource(""); markets.reload(); })}>{STR5.addMarketplace}</button>
          </div>
          {marketError && <span className="error" role="alert">{marketError}</span>}
        </div>
      )}
      {tab === "skills" && (
        <div role="tabpanel" className="manage-list">
          <Async resource={skills} label={STR5.privateSkillsTab}>
            {(list: SkillView[]) => (
              <>
                {list.length === 0 && <p className="muted">{STR5.noSkills}</p>}
                {list.map((s) => <div key={s.id} className="settings-row"><span style={{ display: "flex", flexDirection: "column" }}><span>{s.name}</span><span className="muted">{s.description}</span></span></div>)}
              </>
            )}
          </Async>
          {/* Integration: new / edit / delete / import and per-Bot switches live in Phase 2's private-skills manager. */}
          <button type="button" className="btn-outline" onClick={() => { useMarketplace.getState().close(); useOverlays.getState().openOverlay("skills"); }}>Edit private skills</button>
        </div>
      )}
    </section>
  );
}

registerManagePage(ManagePlugins);
