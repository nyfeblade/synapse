import { STRMA } from "@synapse/shared";
import { LocalPermissionRow } from "./LocalPermissionRow";

/**
 * mac-apps: "May use the apps on your Mac" for this Bot. Off by default; the Bot's first use asks anyway, and
 * answering that card with Always is the other way to turn it on. This row is how it is turned back OFF — a
 * permission granted in passing needs somewhere to be taken away. The coordinator records it on this Mac (the
 * host is never asked, and can't turn it on). How it reads, saves and says a failed save: LocalPermissionRow.
 *
 * It does not make sends quiet: send, delete, spend and security ask every time whatever this says.
 */
export function MacAppRow({ botId }: { botId: string }) {
  return <LocalPermissionRow botId={botId} get="getLocalMacAppAllowed" set="setLocalMacAppAllowed" setting="mac-apps" label={STRMA.setting} help={STRMA.settingHelp} />;
}
