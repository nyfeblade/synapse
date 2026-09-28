import type { Phase5SettingsView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { HostSettingsStore } from "../store/host-settings";
import type { HostModule, ModuleContext } from "./types";

export function phase5SettingsView(settings: HostSettingsStore): Phase5SettingsView {
  return {
    memoryMode: settings.extra<"standard" | "dreaming">("memoryMode", "standard"),
    useHardwareSecurityKeys: settings.extra("useHardwareSecurityKeys", false),
    hasSeenOnboarding: settings.extra("hasSeenOnboarding", false),
    advancedEnabled: settings.extra<{ enabled?: boolean }>("advanced", {}).enabled ?? false,
  };
}

export function createPhase5SettingsModule(ctx: Pick<ModuleContext, "settings" | "hub">): HostModule {
  const publish = () => { const v = phase5SettingsView(ctx.settings); ctx.hub.publish({ channel: "phase5-settings", payload: v }); return v; };
  return {
    name: "phase5-settings",
    handlers: {
      getPhase5Settings: () => phase5SettingsView(ctx.settings),
      setMemoryMode: (a) => {
        if (a.mode !== "standard" && a.mode !== "dreaming") throw new GatewayError("BAD_ARGS", "Unknown memory mode.");
        ctx.settings.setExtra("memoryMode", a.mode);
        return publish();
      },
      // D15-B: the toggle is stored for the future WebAuthn proxy; nothing uses it in v1 (floor F8: user-only, no Bot tool).
      setHardwareSecurityKeys: (a) => { ctx.settings.setExtra("useHardwareSecurityKeys", !!a.enabled); return publish(); },
    },
  };
}
