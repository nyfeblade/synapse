// @vitest-environment jsdom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, type McpServerStatus, type McpServerView, type SseEvent } from "@synapse/shared";
import { ManagePlugins } from "../../src/renderer/marketplace/ManagePlugins";

/**
 * Bug 53, THE CLASS — "a surface reports a state and offers no action for it."
 *
 * Five bugs of this shape (#37, #44, #46, #48, #53) say the one-at-a-time fix is not working. #53
 * is the sharpest instance: Manage plugins → Installed rendered `STR5.statusLabel[s.status]` for a
 * custom MCP server and nothing else, so a server in `needs-auth` read "Needs sign-in" beside a
 * `Remove` button and the OAuth flow that the host implements in full (`host/mcp/oauth.ts`,
 * reachable as `startMcpAuth`) could not be started from anywhere. The Authorize button existed
 * only in `MarketplaceModal.tsx`'s catalog pill, which a self-added server never appears in.
 *
 * THE RULE, guarded here: every status an installed-server row can RENDER is declared exactly once
 * as either
 *   - an ACTION — a control the user can reach in that row, named, and the gateway command pressing
 *     it issues — which this file then proves by rendering the row in that status, pressing the
 *     control, and watching the command go out; or
 *   - NO_ACTION with a reason, which has to answer "and what is the user supposed to do instead?".
 *
 * NO_ACTION is not an allowlist. It is a declaration, and it is measured:
 *   - the statuses come from the `McpServerStatus` union PARSED FROM SOURCE, not from a list typed
 *     here, so a status added to the union with no decision fails this file rather than shipping;
 *   - a declaration for a status that no longer exists fails as stale;
 *   - `disabled`'s reason is a claim about the codebase ("nothing can turn a server off, so there
 *     is nothing to turn back on"), and the claim itself is re-checked below — the day a
 *     `setMcpServerEnabled` command is added, this file demands the control.
 *
 * Why it renders instead of reading the source: a grep for "authorize" in the component, or an
 * assertion about a prop or a class name, would have passed on the broken code the day #53 was
 * found. Only "put the row in this state and press the thing" cannot.
 */

// Concatenated on purpose (readout-affordance.test.tsx hit this too): Vite rewrites
// `new URL("<literal>", import.meta.url)` into an asset URL, which under jsdom resolves against the
// document and is not a file: URL.
const PHASE5_SRC = fs.readFileSync(fileURLToPath(new URL("../../../shared/src/" + "phase5.ts", import.meta.url)), "utf8");

/** The `McpServerStatus` union, read from the type itself. */
export function statusUnion(src: string): string[] {
  const m = /export type McpServerStatus\s*=([^;]+);/.exec(src);
  if (!m) return [];
  return [...m[1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!);
}
const STATUSES = statusUnion(PHASE5_SRC);

interface Action {
  /** The accessible name of the control, minus the row's own title. */
  control: string;
  /** The gateway command pressing it issues, with this server's id. */
  command: string;
  /** True when the control must also hand the user off to the browser (the OAuth tab). */
  opensBrowser?: true;
  why: string;
}
interface NoAction {
  noAction: string;
}
type Decision = Action | NoAction;
const isAction = (d: Decision): d is Action => "control" in d;

/**
 * Written as `Record<McpServerStatus, …>` on purpose: a status added to the union is a TYPE error
 * here before it is a test failure, and the test failure is the backstop for a widened union that
 * typecheck has not run over yet.
 */
const DECIDED: Record<McpServerStatus, Decision> = {
  connected: {
    noAction:
      "the healthy state, and the row is already the place its management lives — the per-tool switches, the account label, the instructions box and Remove are all right there. There is nothing to recover from, so an action here would be a control for a problem the user does not have.",
  },
  "needs-auth": {
    control: STR5.authorize,
    command: "startMcpAuth",
    opensBrowser: true,
    why: "bug 53 itself. The host has a complete OAuth flow behind startMcpAuth; the only thing missing was a way to ask for it from the list the server actually appears in.",
  },
  "waiting-auth": {
    control: STR5.reopen,
    command: "startMcpAuth",
    opensBrowser: true,
    why: "the browser tab is the only place the flow can be finished, and a tab is closed, lost behind a window or opened on the wrong account all the time. Reopen restarts the same authorization — the catalog pill and the connect card both already offer exactly this.",
  },
  failed: {
    control: STR.retry,
    command: "restartMcpServers",
    why: "a failed connection is almost always transient (the endpoint was down, the laptop was asleep, a header was just replaced). restartMcpServers drops the dead connection and reconnects that one server, which is the whole of what the user would otherwise reach for Remove-and-add-again to do.",
  },
  disabled: {
    control: STR5.turnOn,
    command: "setMcpServerEnabled",
    why: "bug 54. McpRegistry.setEnabled existed with no caller, so Off was a state the host could store and the row could render with no way back on. The switch issues setMcpServerEnabled; the same control turns a connected server off so Off is a state the app can produce on purpose.",
  },
  unknown: {
    noAction:
      "\"Not checked yet\" is not a fault: the host connects a server lazily (McpProxyPool.ensure, on the first tool listing) and publishes the real status the moment it does, so the state resolves itself without the user doing anything. It is also the permanent, correct reading for a CLI-run command server the host never connects at all, where a Check now button would do nothing at all.",
  },
};

const SERVER_ID = "composio";
const TITLE = "Composio";
const AUTH_URL = "https://auth.example/authorize?x=1";

const server = (status: McpServerStatus, over: Partial<McpServerView> = {}): McpServerView => ({
  id: SERVER_ID, name: TITLE, label: null, kind: "remote", status, catalogId: null, instructions: "",
  error: status === "failed" ? "The endpoint returned 503." : null,
  tools: [], headers: [], ...over,
});

const calls: [string, unknown][] = [];
let listeners: ((e: SseEvent) => void)[] = [];
const emit = (servers: McpServerView[]) => { for (const fn of [...listeners]) fn({ channel: "mcp-servers", payload: { servers } } as SseEvent); };

function mockBridge(servers: McpServerView[]): void {
  const results: Record<string, unknown> = {
    listMcpServers: { servers },
    listPluginMarketplaces: { marketplaces: [] },
    startMcpAuth: { authorizationUrl: AUTH_URL },
    restartMcpServers: {},
    getWorkflows: { workflows: [] },
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: results[cmd] ?? {} }; }),
    onEvent: (cb: (e: SseEvent) => void) => { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb); }; },
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
}

/** The row for a server in this status, as the Installed list renders it. */
async function rowFor(status: McpServerStatus, over: Partial<McpServerView> = {}): Promise<HTMLElement> {
  mockBridge([server(status, over)]);
  render(<ManagePlugins />);
  return screen.findByRole("group", { name: over.label ? `${TITLE} (${over.label})` : TITLE });
}

/**
 * A control the user can actually reach in this row: present, a control (not a readout), not
 * disabled, not hidden. Deliberately NOT `getByRole(...)` — the self-tests below pin what this
 * rejects, and a helper whose rejections are pinned is what keeps the guard from going green on a
 * button that is rendered but unpressable.
 */
export function reachableControl(row: HTMLElement, name: string): HTMLElement | null {
  const named = [...row.querySelectorAll<HTMLElement>("button, a[href], [role='button']")]
    .filter((el) => ((el.getAttribute("aria-label") ?? el.textContent) ?? "").trim() === name);
  return named.find((el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true" && !el.hasAttribute("hidden")) ?? null;
}

beforeEach(() => { calls.length = 0; listeners = []; mockBridge([]); });
afterEach(cleanup);

describe("bug 53, the class — every state an installed-server row shows is a decision about an action", () => {
  it("reads the real status list from the type (the guard's own smoke test)", () => {
    // A zero from a source parse is a claim about the regex, not about the code. If this parse
    // breaks, every per-status assertion below disappears and the guard silently stops guarding.
    expect(STATUSES, "the McpServerStatus union did not parse — this guard is now blind").toContain("needs-auth");
    expect(STATUSES.length).toBeGreaterThanOrEqual(5);
    expect(statusUnion('export type McpServerStatus = "connected" | "needs-auth";')).toEqual(["connected", "needs-auth"]);
  });

  it("every status in the union is declared, and every status can be shown at all", () => {
    const undeclared = STATUSES.filter((s) => !DECIDED[s as McpServerStatus]);
    expect(
      undeclared,
      `A new server status reaches the Installed row by default — it is rendered as a label and nothing else, which is bug 53.\nDeclare each one: an ACTION (a control in the row and the gateway command it issues) or NO_ACTION with a reason saying what the user does instead:\n  ${undeclared.join("\n  ")}`,
    ).toEqual([]);
    // A status with no label renders as an empty span: the row would report nothing to decide about.
    expect(STATUSES.filter((s) => !STR5.statusLabel[s])).toEqual([]);
  });

  it("holds no stale declarations — a status that no longer exists is deleted, not kept", () => {
    expect(Object.keys(DECIDED).filter((s) => !STATUSES.includes(s))).toEqual([]);
  });

  it("every reason is a sentence, not a shrug (self-test on the declarations themselves)", () => {
    for (const [s, d] of Object.entries(DECIDED)) {
      expect(isAction(d) ? d.why.length : d.noAction.length, `${s}'s reason is too thin`).toBeGreaterThan(80);
    }
  });

  for (const status of STATUSES as McpServerStatus[]) {
    const d = DECIDED[status];
    if (!d) continue; // reported by the declaration test above; nothing to render against here.

    if (isAction(d)) {
      it(`${status}: the user can reach ${d.control} in the row, and it starts ${d.command}`, async () => {
        const row = await rowFor(status);
        const btn = reachableControl(row, `${d.control} ${TITLE}`);
        expect(
          btn,
          `The row says "${STR5.statusLabel[status]}" and offers no way out of it — bug 53.\nGive the row a reachable "${d.control}" control that calls ${d.command}, or change this declaration to NO_ACTION with a reason.\nThe row rendered:\n${row.textContent}`,
        ).toBeTruthy();
        fireEvent.click(btn!);
        await vi.waitFor(() => expect(calls.map((c) => c[0]), `pressing ${d.control} issued no ${d.command}`).toContain(d.command));
        expect(calls.find((c) => c[0] === d.command)![1]).toMatchObject({ serverId: SERVER_ID });
        if (d.opensBrowser) {
          // The command alone is not the flow: the authorization page has to be handed to the
          // browser, or the user is left with a row that changed its label and nothing else.
          await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: AUTH_URL }]));
        }
      });
    } else {
      it(`${status}: reports itself and needs no control`, async () => {
        const row = await rowFor(status);
        expect(within(row).getByText(STR5.statusLabel[status]!), `a ${status} row does not even say so`).toBeTruthy();
      });
    }

    it(`${status}: shows no control belonging to another state`, async () => {
      // Without this, "render every button always" is a passing fix — and a Retry on a connected
      // server or an Authorize on a waiting one is the same lie in the other direction.
      const row = await rowFor(status);
      const mine = isAction(d) ? d.control : null;
      for (const other of Object.values(DECIDED)) {
        if (!isAction(other) || other.control === mine) continue;
        expect(reachableControl(row, `${other.control} ${TITLE}`), `a ${status} row offers "${other.control}"`).toBeNull();
      }
    });
  }

  // Bug 54, the other half of the rule. The per-status decisions above are about RECOVERING from a
  // state; on/off is a choice the user can make from ANY state, and before #54 no row offered it at
  // all — so Off was reachable only by hand-editing servers.json, and then permanent. Every status a
  // user-owned row can render therefore also offers the switch, set to the truth, and pressing it
  // asks for the opposite. Parsed statuses again, so a new status is covered the day it is added.
  for (const status of STATUSES as McpServerStatus[]) {
    const on = status !== "disabled";
    const name = `${on ? STR5.turnOff : STR5.turnOn} ${TITLE}`;
    it(`${status}: the row offers "${name}", and pressing it asks the host for enabled: ${!on}`, async () => {
      const row = await rowFor(status);
      const sw = reachableControl(row, name);
      expect(sw, `a ${status} row has no reachable on/off control named "${name}".\nThe row rendered:\n${row.textContent}`).toBeTruthy();
      expect(sw!.getAttribute("role")).toBe("switch");
      expect(sw!.getAttribute("aria-checked"), `a ${status} server is ${on ? "on" : "off"}; the switch must say so`).toBe(String(on));
      // The opposite label must not be offered too: "Turn on" on a server that is on is the lie in reverse.
      expect(reachableControl(row, `${on ? STR5.turnOn : STR5.turnOff} ${TITLE}`)).toBeNull();
      fireEvent.click(sw!);
      await vi.waitFor(() => expect(calls).toContainEqual(["setMcpServerEnabled", { serverId: SERVER_ID, enabled: !on }]));
    });
  }

  it("setMcpServerEnabled exists, so disabled is an ACTION with a reachable way back on", () => {
    const cmds = /interface GatewayCommands \{([\s\S]*?)\n\}/.exec(PHASE5_SRC)?.[1] ?? PHASE5_SRC;
    const toggles = [...cmds.matchAll(/^\s*(set[A-Za-z]*Mcp[A-Za-z]*(?:Enabled|Disabled)|setMcpServerOn)\s*:/gm)].map((m) => m[1]!)
      .filter((c) => c !== "setMcpToolEnabled");
    expect(toggles).toContain("setMcpServerEnabled");
    expect(isAction(DECIDED.disabled), "Off is a state the app can produce — declare the Turn on control").toBe(true);
  });

  it("the reachability check rejects a row with no control at all (self-test on the detector)", () => {
    const { container } = render(<div role="group" aria-label={TITLE}><span>{STR5.statusLabel["needs-auth"]}</span><button type="button">Remove</button></div>);
    const row = within(container).getByRole("group", { name: TITLE });
    // This is exactly the row bug 53 was reported against. If the detector found something here,
    // every assertion above would pass on the broken code.
    expect(reachableControl(row, `${STR5.authorize} ${TITLE}`)).toBeNull();
    expect(reachableControl(row, "Remove")).toBeTruthy();
  });

  it("the reachability check rejects a control that is present but unpressable (self-test)", () => {
    const { container } = render(
      <div role="group" aria-label={TITLE}>
        <button type="button" disabled aria-label={`${STR5.authorize} ${TITLE}`}>Authorize</button>
        <span role="button" aria-disabled="true" aria-label={`${STR.retry} ${TITLE}`}>Retry</span>
      </div>,
    );
    const row = within(container).getByRole("group", { name: TITLE });
    expect(reachableControl(row, `${STR5.authorize} ${TITLE}`)).toBeNull();
    expect(reachableControl(row, `${STR.retry} ${TITLE}`)).toBeNull();
  });
});

describe("bug 53, the instance — a custom MCP server the user added can be signed in to", () => {
  it("Composio, added by hand and needing OAuth, offers Authorize in Manage plugins → Installed", async () => {
    // The user's report, verbatim: catalogId null (it is in no catalog), so the Marketplace pill
    // that carried the only Authorize button in the app could never render for it.
    const row = await rowFor("needs-auth", { catalogId: null });
    expect(within(row).getByText("Needs sign-in")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: `Authorize ${TITLE}` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["startMcpAuth", { serverId: SERVER_ID }]));
    // Awaited separately: the browser hand-off is one `await` past the command, so asserting it in
    // the same tick passes only by accident of scheduling.
    await vi.waitFor(() => expect(calls).toContainEqual(["native:openExternal", { url: AUTH_URL }]));
  });

  it("stops saying Needs sign-in the moment the flow is started, and says Connected when it finishes", async () => {
    const row = await rowFor("needs-auth");
    fireEvent.click(within(row).getByRole("button", { name: `Authorize ${TITLE}` }));
    // Optimistic, because the host's waiting-auth publish is a round trip away and a row that still
    // reads "Needs sign-in" over an open sign-in tab is the same defect in a new costume.
    await vi.waitFor(() => expect(within(row).getByText("Waiting for authorization")).toBeTruthy());
    expect(reachableControl(row, `${STR5.reopen} ${TITLE}`), "no way back to a lost sign-in tab").toBeTruthy();
    emit([server("connected")]);
    await vi.waitFor(() => expect(within(row).getByText("Connected")).toBeTruthy());
    expect(reachableControl(row, `${STR5.authorize} ${TITLE}`)).toBeNull();
    expect(reachableControl(row, `${STR5.reopen} ${TITLE}`)).toBeNull();
  });

  it("a sign-in the host refuses is shown in the row, not swallowed", async () => {
    mockBridge([server("needs-auth")]);
    (window.synapse as unknown as { call: unknown }).call = vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "startMcpAuth") return { ok: false, error: { code: "OAUTH_FAILED", message: "The server didn't provide a sign-in page." } };
      return { ok: true, result: cmd === "listMcpServers" ? { servers: [server("needs-auth")] } : cmd === "listPluginMarketplaces" ? { marketplaces: [] } : {} };
    });
    render(<ManagePlugins />);
    const row = await screen.findByRole("group", { name: TITLE });
    fireEvent.click(within(row).getByRole("button", { name: `Authorize ${TITLE}` }));
    await vi.waitFor(() => expect(within(row).getByRole("alert").textContent).toContain("didn't provide a sign-in page"));
    // …and the row goes back to offering the sign-in, rather than waiting for a tab that never opened.
    expect(reachableControl(row, `${STR5.authorize} ${TITLE}`)).toBeTruthy();
  });

  it("a failed server can be retried from its row", async () => {
    const row = await rowFor("failed");
    expect(within(row).getByText("The endpoint returned 503.")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: `${STR.retry} ${TITLE}` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["restartMcpServers", { serverId: SERVER_ID }]));
  });

  it("two accounts on one connector each authorize their own server", async () => {
    // PLG-09: the row title carries the label, and so must the control — otherwise "Authorize"
    // is ambiguous on screen and in the accessibility tree the moment a second account exists.
    mockBridge([server("needs-auth", { id: "composio-work", label: "work" }), server("needs-auth", { id: "composio-home", label: "home" })]);
    render(<ManagePlugins />);
    const work = await screen.findByRole("group", { name: `${TITLE} (work)` });
    fireEvent.click(within(work).getByRole("button", { name: `Authorize ${TITLE} (work)` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["startMcpAuth", { serverId: "composio-work" }]));
    expect(calls.filter((c) => c[0] === "startMcpAuth")).toHaveLength(1);
  });
});

/**
 * Bug 54, end to end. Everything above proves the row ASKS; this proves the ask is answered. The
 * renderer is wired to the REAL host MCP module — registry, proxy pool, publish — with only the
 * network connection faked, so the switch's command goes through `setMcpServerEnabled` →
 * `McpRegistry.setEnabled` → `McpProxyPool.restart`, the connection is really dropped and really
 * re-made, and the row changes because the host published it, not because a mock said so.
 */
interface HostMcp {
  handlers: Record<string, ((a: unknown) => unknown) | undefined> & { addMcpServer(a: unknown): Promise<unknown> };
  mcpServers(botId: string): Record<string, unknown>;
}
/**
 * Loaded by specifier at run time, not by a static import: app's tsconfig (DOM lib) would otherwise
 * type-check the host's whole type graph (phase5/types → bots → host/google/api.ts, whose Node fetch
 * body is not a DOM BodyInit) and fail typecheck on code this test never touches. The module that
 * runs is the real one either way; only the compile-time types are narrowed to what is used here.
 */
async function loadHost(): Promise<{
  createMcpServices(c: never, o: { connect(): Promise<unknown> }): { pool: { closeAll(): Promise<void> } };
  createMcpModule(c: never, s: unknown): HostMcp;
  HostSettingsStore: new (file: string) => unknown;
}> {
  const base = "@synapse/host/";
  const [mod, settings] = await Promise.all([import(/* @vite-ignore */ `${base}mcp/module`), import(/* @vite-ignore */ `${base}store/host-settings`)]);
  return { ...mod, HostSettingsStore: settings.HostSettingsStore };
}

describe("bug 54, the instance — a server can be switched off and back on from its row", () => {
  it("Composio: Connected → Turn off → Off (disconnected) → Turn on → Connected (reconnected)", async () => {
    const { createMcpModule, createMcpServices, HostSettingsStore } = await loadHost();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-toggle-"));
    const hostListeners: ((e: SseEvent) => void)[] = [];
    const c = {
      cfg: { hostPrivate: dir, workspace: dir }, settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1,
      flags: () => ({ connectorToolDisable: "disallowedTools" }),
      hub: { publish: (e: SseEvent) => { for (const fn of [...hostListeners]) fn(e); } },
    } as never;
    let connects = 0;
    let closes = 0;
    const services = createMcpServices(c, {
      connect: async () => {
        connects += 1;
        return { listTools: async () => [{ name: "search", description: "", inputSchema: { type: "object" as const } }], callTool: async () => ({ content: [] }) as never, close: async () => { closes += 1; } };
      },
    });
    const host = createMcpModule(c, services);
    await host.handlers.addMcpServer!({ name: TITLE, url: "https://connect.composio.dev/mcp" });
    const issued: string[] = [];
    (window as unknown as { synapse: unknown }).synapse = {
      call: async (cmd: string, args: unknown) => {
        issued.push(cmd);
        const h = host.handlers[cmd];
        if (!h) return { ok: true, result: cmd === "listPluginMarketplaces" ? { marketplaces: [] } : {} };
        try { return { ok: true, result: await h(args) }; } catch (e) { return { ok: false, error: { code: "X", message: (e as Error).message } }; }
      },
      onEvent: (cb: (e: SseEvent) => void) => { hostListeners.push(cb); return () => { hostListeners.splice(hostListeners.indexOf(cb), 1); }; },
      onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
    };

    render(<ManagePlugins />);
    const row = await screen.findByRole("group", { name: TITLE });
    await vi.waitFor(() => expect(within(row).getByText("Connected")).toBeTruthy());

    fireEvent.click(reachableControl(row, `${STR5.turnOff} ${TITLE}`)!);
    await vi.waitFor(() => expect(within(row).getByText(STR5.statusLabel.disabled!)).toBeTruthy());
    expect(issued).toContain("setMcpServerEnabled");
    expect(closes, "Off must drop the live connection, not just relabel the row").toBe(1);
    const onSwitch = reachableControl(row, `${STR5.turnOn} ${TITLE}`);
    expect(onSwitch, "an Off row with no way back on is bug 54").toBeTruthy();
    expect(onSwitch!.getAttribute("aria-checked")).toBe("false");
    expect(Object.keys(host.mcpServers!("bot-1")), "a turned-off server must not reach the next Bot spawn").toEqual([]);

    fireEvent.click(onSwitch!);
    await vi.waitFor(() => expect(within(row).getByText("Connected")).toBeTruthy());
    expect(connects, "Turn on reconnects").toBe(2);
    expect(reachableControl(row, `${STR5.turnOff} ${TITLE}`)!.getAttribute("aria-checked")).toBe("true");
    expect(Object.keys(host.mcpServers!("bot-1"))).toEqual([SERVER_ID]);
    await services.pool.closeAll();
  });
});
