import { call } from "./bridge";
import type { BotSummary } from "@synapse/shared";
import { acceptAgent, acceptSettings, useUi } from "./store";
import { copyWithConfirmation } from "./toast";

const upsert = (agent: BotSummary) => acceptAgent(agent);

// Fix round 1, finding 2: same pattern as store.ts's deleteBot/setPinned — catch and set
// `actionError` (rendered as a role="alert" banner by Sidebar.tsx) instead of letting a
// rejected gateway call become a silent unhandled promise rejection.
const onActionError = (e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });

export async function hideBot(id: string): Promise<void> {
  try {
    upsert((await call("setAgentHiddenFromSidebar", { id, hidden: true })).agent);
    const { view, bots } = useUi.getState();
    if (view.kind === "chat" && view.botId === id) {
      const next = Object.values(bots).find((b) => b.id !== id && !b.settings.hiddenFromSidebar);
      if (next) await useUi.getState().openBot(next.id);
      else useUi.getState().openNewChat();
    }
  } catch (e) {
    onActionError(e);
  }
}
export async function unhideBot(id: string): Promise<void> {
  try {
    upsert((await call("setAgentHiddenFromSidebar", { id, hidden: false })).agent);
  } catch (e) {
    onActionError(e);
  }
}
export async function duplicateBot(id: string): Promise<void> {
  try {
    const { id: copy } = await call("duplicateAgent", { id });
    await useUi.getState().openBot(copy);
  } catch (e) {
    onActionError(e);
  }
}
export async function setUnread(id: string, unread: boolean): Promise<void> {
  try {
    upsert((await call("setAgentUnread", { id, unread })).agent);
  } catch (e) {
    onActionError(e);
  }
}
export async function setNotify(id: string, enabled: boolean): Promise<void> {
  try {
    upsert((await call("setAgentNotificationsEnabled", { id, enabled })).agent);
  } catch (e) {
    onActionError(e);
  }
}
/** Motion-spec §7.5: this used to copy in total silence, like every other copy site in the app. */
export async function copyConversationId(id: string): Promise<void> {
  await copyWithConfirmation(id);
}
/** SET-05: "" = Auto-detect. */
export async function setTimeZone(zone: string): Promise<void> {
  try {
    const settings = await call("setHostSettings", { userTimeZone: zone });
    acceptSettings(settings);
  } catch (e) {
    // A host setting the gateway refused used to be dropped here, so the control snapped back with
    // no explanation at all. Every failed save now reaches the same role="alert" banner.
    onActionError(e);
  }
}
