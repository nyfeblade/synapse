/**
 * mac-apps: PERMISSIONS, MADE EASY. macOS needs two separate consents before a Bot can touch an app —
 * Accessibility (for the generic UI fallback) and per-app Automation (for every AppleScript fast path) —
 * plus the Contacts, Calendars and Reminders privacy panes. None of them can be granted from code: the
 * user grants them, and all this file does is say honestly where each one stands and put the prompt or the
 * right System Settings pane one click away.
 *
 * Nothing here ever throws at the renderer: an unreachable helper is reported as "unknown", never a crash.
 */
import { MAC_SETTINGS_PANES, type MacPermission, type MacPermissionState } from "@synapse/shared";
import type { MacHelper } from "./helper";
import type { OsaRunner } from "./osa";

/** The apps whose Automation consent the panel shows a row for, in the order they matter. */
export const MACAPP_APPS: readonly string[] = Object.freeze([
  "Messages", "Mail", "Calendar", "Reminders", "Notes", "Contacts", "Music", "Finder", "Safari", "System Events",
]);

/** What each app lets a Bot do, in the user's words (never a class name, never a bundle id). */
const WHAT: Record<string, string> = {
  Messages: "Send and read messages",
  Mail: "Write, send and search email",
  Calendar: "See and change your calendar",
  Reminders: "Add and complete reminders",
  Notes: "Write and search notes",
  Contacts: "Look someone up",
  Music: "Play music",
  Finder: "Reveal, move and tag files",
  Safari: "See and open tabs",
  "System Events": "Open any app, and press its buttons",
};

const state = (v: unknown): MacPermissionState => (v === "granted" || v === "denied" ? v : "unknown");

/**
 * Every capability's status in one read. `askUserIfNeeded` is off inside the helper, so calling this NEVER
 * pops a macOS dialog — the panel can refresh on focus as often as it likes.
 */
export async function readPermissions(helper: MacHelper, apps: readonly string[] = MACAPP_APPS): Promise<MacPermission[]> {
  const r = await helper.request({ op: "perms", apps: [...apps] }, 8_000);
  const p = (r.ok ? (r.perms as Record<string, unknown> | undefined) : undefined) ?? {};
  const automation = (p.automation as Record<string, unknown> | undefined) ?? {};
  const unreachable = !r.ok ? "Synapse couldn't check this on your Mac just now." : undefined;
  const row = (id: string, label: string, s: MacPermissionState, pane: string, detail?: string): MacPermission =>
    ({ id, label, state: s, pane, ...(detail ? { detail } : {}) });

  return [
    row("accessibility", "Use any app's buttons and menus", state(p.accessibility), "accessibility",
      unreachable ?? (state(p.accessibility) === "granted" ? undefined : "Without this a Bot can still use the apps below, but not any other app.")),
    row("contacts", "Look people up in Contacts", state(p.contacts), "contacts", unreachable),
    row("calendars", "Read and change your calendar", state(p.calendars), "calendars", unreachable),
    row("reminders", "Read and change your reminders", state(p.reminders), "reminders", unreachable),
    ...apps.map((app) => row(`automation:${app}`, `${WHAT[app] ?? `Control ${app}`} (${app})`, state(automation[app]), "automation",
      unreachable ?? (state(automation[app]) === "denied" ? `You said no to this one. System Settings → Privacy & Security → Automation → Synapse turns it back on.` : undefined))),
  ];
}

/** The System Settings URL for a row's pane. An unknown pane never becomes a URL. */
export function paneUrl(pane: unknown): string | null {
  return typeof pane === "string" && pane in MAC_SETTINGS_PANES ? MAC_SETTINGS_PANES[pane]! : null;
}

/**
 * Trigger the real prompt for one capability.
 *   - Accessibility has an API for it (`AXIsProcessTrustedWithOptions` with the prompt option) — that is
 *     the ONE consent macOS will ask for on demand.
 *   - Automation has none: macOS asks the first time an Apple event actually goes to that app. So this
 *     sends the most harmless event there is — "what is your name" — and the answer is the user's choice.
 * Either way the result is a fresh status, never an exception.
 */
export async function requestPermission(d: { helper: MacHelper; osa: OsaRunner; promptAccessibility?(): Promise<boolean> }, id: string): Promise<{ state: MacPermissionState; detail?: string }> {
  if (id === "accessibility") {
    // The helper's `--prompt-accessibility` run: AXIsProcessTrustedWithOptions with the prompt option, which
    // is the one call in the whole feature that macOS will answer with a dialog. It exits straight after.
    const granted = (await d.promptAccessibility?.().catch(() => false)) ?? false;
    return granted ? { state: "granted" } : { state: "unknown", detail: "macOS asked. Turn Synapse on in the list, then come back — this panel re-checks when you do." };
  }
  const app = id.startsWith("automation:") ? id.slice("automation:".length) : null;
  if (app && MACAPP_APPS.includes(app)) {
    // The prompt IS the side effect of asking the app its own name; nothing is read and nothing changes.
    const r = await d.osa.run({ lang: "as", app, timeoutMs: 30_000, source: `tell application "${app.replace(/"/g, "")}" to return name` });
    if (r.ok) return { state: "granted" };
    return { state: r.code === "permission" ? "denied" : "unknown", detail: r.error };
  }
  // Contacts, Calendars and Reminders are asked for by the frameworks the moment an action needs them;
  // there is nothing honest to trigger here, so the panel sends the user to the pane instead.
  return { state: "unknown", detail: "Open System Settings to change this one." };
}
