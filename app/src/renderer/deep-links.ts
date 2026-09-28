import { APP_SCHEME, APP_SCHEMES } from "@synapse/shared";
import { sectionOf } from "./components/settings/sections";
import { useUi } from "./store";

export { APP_SCHEME };
/** synapse:// or, for one release, the old bots:// (bug 286). */
const SCHEMES = APP_SCHEMES.join("|");
export const slugRow = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const settingLink = (section: string, row: string) => `${APP_SCHEME}://settings/${section}/${row}`;
export const botSettingLink = (botId: string, row: string) => `${APP_SCHEME}://bot/${botId}/settings/${row}`;

export function parseSettingLink(url: string): { kind: "settings"; section: string; row: string } | { kind: "bot"; botId: string; row: string } | null {
  const m = new RegExp(`^(?:${SCHEMES})://(?:settings/([a-z-]+)/([a-z0-9-]+)|bot/([^/]+)/settings/([a-z0-9-]+))$`).exec(url.trim());
  if (!m) return null;
  return m[1] ? { kind: "settings", section: m[1], row: m[2]! } : { kind: "bot", botId: m[3]!, row: m[4]! };
}

/** The row the next render should flash (SET-18: "highlights it for 2 s"). */
export let pendingFocus: { scope: string; row: string } | null = null;

export function openDeepLink(url: string): boolean {
  const p = parseSettingLink(url);
  if (!p) return false;
  const ui = useUi.getState();
  if (p.kind === "settings") {
    // The URL names the sub-focus (e.g. "usage"), which may now be a block folded into a different
    // top-level section (e.g. "account") — the flash has to look for the row under the section that
    // actually renders, not the one the link was written against.
    pendingFocus = { scope: `section:${sectionOf(p.section)}`, row: p.row };
    ui.openSettings(`${p.section}/${p.row}`);
  } else {
    pendingFocus = { scope: `bot:${p.botId}`, row: p.row };
    ui.openBot(p.botId);
    ui.setPanel("settings");
  }
  return true;
}

export function takePendingFocus(scope: string): string | null {
  if (!pendingFocus || pendingFocus.scope !== scope) return null;
  const r = pendingFocus.row;
  pendingFocus = null;
  return r;
}

/**
 * The URLs a Bot's rendered markdown may link to (Transcript.tsx's `urlTransform`, code-cards spec
 * item 5: "links only http/https/mailto"). react-markdown's own default additionally allows `ircs`
 * and bare `xmpp`, neither of which this app opens; narrowed to exactly the schemes `guardNavigation`
 * (app/src/main/native/external.ts) will actually act on, PLUS this app's own `synapse://` scheme (and `bots://`, its
 * alias for one release, bug 286) so a
 * deep link (settingLink/botSettingLink) a Bot writes into a reply still reaches `openDeepLink`
 * instead of being blanked before the `a` component ever sees it. Same shape as react-markdown's
 * `defaultUrlTransform` (a protocol before the first `/`/`?`/`#`, or no colon at all, is safe); only
 * the allowed-protocol list is narrower.
 */
const SAFE_LINK_PROTOCOL = new RegExp(`^(https?|mailto|${SCHEMES})$`, "i");

export function safeUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_LINK_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}
