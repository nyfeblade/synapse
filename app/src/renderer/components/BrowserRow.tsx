import { STRB } from "@synapse/shared";
import { LocalPermissionRow } from "./LocalPermissionRow";

/**
 * mac-browser: "May use the browser on your Mac" for this Bot. Off by default; the Bot's first use asks anyway. The
 * coordinator records it on this Mac (the host is never asked, and can't turn it on). How it reads, saves and says
 * a failed save: LocalPermissionRow (settings-persist).
 */
export function BrowserRow({ botId }: { botId: string }) {
  return <LocalPermissionRow botId={botId} get="getLocalBrowserAllowed" set="setLocalBrowserAllowed" setting="mac-browser" label={STRB.setting} help={STRB.settingHelp} />;
}
