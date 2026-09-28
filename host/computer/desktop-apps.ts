import type { DisplayInfo } from "@synapse/shared";

export const DESKTOP_APPS = ["terminal", "files", "browser"] as const;
export type DesktopApp = (typeof DESKTOP_APPS)[number];

/**
 * The app's "Open app" buttons. Bug 78: the app is started by the root helper (`bot-display open-app`) as the
 * display's owner (the Bot's account, else box), never as bothost, so its windows join that display's accessibility
 * bus and Live perception can read them. The helper holds the fixed list of what each dock app runs.
 */
export async function openDesktopApp(o: {
  botId: string;
  app: DesktopApp;
  ensure: (id: string) => Promise<DisplayInfo>;
  launch: (index: number, app: DesktopApp) => Promise<void>;
}): Promise<void> {
  if (!(DESKTOP_APPS as readonly string[]).includes(o.app)) throw new Error(`Unknown desktop app: ${String(o.app)}`);
  const display = await o.ensure(o.botId);
  await o.launch(display.index, o.app);
}
