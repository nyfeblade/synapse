import { useEffect, useLayoutEffect, useState, type DragEvent } from "react";
import { STR } from "@synapse/shared";
import { asResource } from "./async-resource";
import { callQuiet } from "./bridge";
import { AnnounceOutlet } from "./components/Announce";
import { Async } from "./components/Async";
import { loadDisplays, useComputer } from "./computer-state";
import { BoxBanner } from "./components/BoxBanner";
import { MacDiskBanner } from "./components/MacDiskBanner";
import { KeyPrompts } from "./components/KeyPrompts";
import { MacModesBanner } from "./components/MacModesBanner";
import { ComputerView } from "./components/ComputerView";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { ChatView } from "./components/ChatView";
import { NewChat } from "./components/NewChat";
import { Overlays } from "./components/Overlays";
import { ConfirmHost } from "./components/ConfirmDialog";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { openDeepLink } from "./deep-links";
import { ConnectGoogleSheet } from "./google/ConnectGoogleSheet";
import { MarketplaceModal } from "./marketplace/MarketplaceModal";
import { nativeCall, onNative } from "./native";
import { Onboarding } from "./onboarding/Onboarding";
import { SetupScreen } from "./firstrun/SetupScreen";
import { useSetupGate } from "./firstrun/store";
import { DetailsSheet } from "./templates/DetailsSheet";
import { ExportSheet } from "./templates/ExportSheet";
import { ImportSheet } from "./templates/ImportSheet";
import { useTemplates } from "./templates/store";
import { overlaysOpen } from "./overlay-stack";
import { useOverlays } from "./overlays";
import { useUi } from "./store";
import { startUsageSync } from "./usage/store";
import { startUpdatesSync } from "./updates/store";
import { useWakeBridge } from "./voice/wake-bridge";
import { usePhoneBridge } from "./voice/phone-bridge";
import { IncomingCall } from "./voice/IncomingCall";
import { CallHost, useVoice } from "./voice/VoiceOverlay";

export function App() {
  const { connection, view, settingsOpen, bootstrap, loadAll, setConnection, apply, openNewChat, openSettings } = useUi();
  useWakeBridge();
  usePhoneBridge();
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  /** Portable install: a profile whose host has no Claude sign-in goes to sign-in, whatever else it has seen. */
  const [onboardingStep, setOnboardingStep] = useState<"splash" | "setup">("splash");
  const computerOpen = useComputer((s) => s.open); // before the onboarding early return (hook order)
  // Portable install: the first-run setup screen (before anything else) and its Settings → Setup reopen.
  const setupGate = useSetupGate((s) => s.gate);
  const setupReopened = useSetupGate((s) => s.reopened);
  useEffect(() => { void useSetupGate.getState().check(); }, []);
  useEffect(() => window.synapse.onConnection(setConnection), [setConnection]);
  useEffect(() => window.synapse.onEvent(apply), [apply]);
  useEffect(() => window.synapse.onEvent((e) => useComputer.getState().apply(e)), []);
  useEffect(() => { void window.synapse.appInfo().then((i) => useUi.setState({ userName: i.userName })); }, []);
  useEffect(() => window.synapse.box.onLifecycle((s) => useComputer.getState().setLifecycle(s)), []);
  useEffect(() => onNative<{ url: string }>("deep-link", (p) => void openDeepLink(p.url)), []);
  // Native IPC (unlike the gateway/box "usage" SSE channel) is available as soon as the window
  // loads, independent of box connection state, so this starts unconditionally (Fix round 1,
  // finding 2 / UI-03): the account-menu badge must track a background update check regardless
  // of whether Settings → Updates was ever opened.
  useEffect(() => startUpdatesSync(), []);
  useEffect(() => {
    if (connection.kind !== "connected") return;
    // callQuiet, all of these: background probes fired on every reconnect, where call()'s default —
    // a banner — would put one on screen every time the box blips.
    //
    // The two below ALSO swallow the rejection, which is a different and narrower claim, and one
    // each of them owes: both feed a banner that is absent in the healthy case, and both have a
    // live host channel (`forever-box`, `box-disk-pressure`) whose next publish replaces whatever
    // this probe failed to fetch. silenced-gateway-calls.test.ts holds that claim in writing.
    void callQuiet("getForeverBoxStatus", {}).then((b) => useComputer.getState().setBox(b)).catch(() => {});
    void callQuiet("getDiskPressure", {}).then((d) => useComputer.getState().setDisk(d)).catch(() => {});
    // Which Bots hold a screen on the shared computer: previews dial only those (a Bot past MAX_SCREENS has none).
    // Bug 36: the three getDisplays outcomes used to be one blank rectangle. loadDisplays() keeps the
    // call quiet (no banner for a box blip) and RECORDS the failure, which the screen surfaces show
    // in the place the screen would have been, with a Retry.
    void loadDisplays();
    startUsageSync();
    // host killed mid-connect: the next connect asks again. A host with no Claude sign-in (a new or recreated
    // box) goes straight to sign-in even when this profile saw the onboarding before.
    void callQuiet("getOnboarding", {}).then((o) => {
      setOnboardingStep(o.hasSeenOnboarding && !o.tokenConfigured ? "setup" : "splash");
      setNeedsOnboarding(!o.hasSeenOnboarding || !o.tokenConfigured);
    }).catch(() => {});
  }, [connection.kind]);
  // The global chords, and the one rule that guards them. ⌘N and ⌘, act on the app *underneath*
  // whatever is covering it: ⌘N while Settings was open navigated behind the modal and put focus in
  // a text field under the scrim, so everything typed went somewhere invisible (WCAG 2.4.11), and ⌘,
  // while the palette was open opened Settings beneath it and focused it there. A chord that acts
  // underneath an overlay is suppressed while the overlay stack is non-empty — one predicate for the
  // whole app, in place of the pairwise ones each surface used to carry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") { e.preventDefault(); if (!overlaysOpen()) openNewChat(); }
      if (e.metaKey && e.key === ",") { e.preventDefault(); if (!overlaysOpen()) openSettings(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNewChat, openSettings]);
  // ⌘K is deliberately not guarded: the palette opens as a new layer ON TOP of the stack, which is a
  // legitimate thing to do over any surface. Escape is not handled here at all any more — the
  // overlay stack owns it, and only the topmost layer hears it.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); useOverlays.getState().openOverlay("palette"); }
    };
    window.addEventListener("keydown", onKey);
    const off = window.synapse.onOpenBot((id) => void useUi.getState().openBot(id));
    return () => { window.removeEventListener("keydown", onKey); off(); };
  }, []);
  useEffect(() => onNative("import-bot", () => useTemplates.getState().importFromFile()), []);
  // Bug 134 (item 9): call from anywhere — the menu bar's Call menu and the global shortcut (main relays).
  useEffect(() => {
    const offBot = onNative<{ botId?: string }>("call-bot", (p) => {
      const id = p?.botId;
      if (!id || !useUi.getState().bots[id]) return;
      void useUi.getState().openBot(id).then(() => useVoice.getState().open(id));
    });
    const offCurrent = onNative("call-current", () => {
      const v = useUi.getState().view;
      if (v.kind === "chat" && useUi.getState().bots[v.botId]) useVoice.getState().open(v.botId);
    });
    return () => { offBot(); offCurrent(); };
  }, []);
  // The Call menus list the Bots, in the sidebar's order (names only; main builds the menus).
  const menuKey = useUi((s) => Object.values(s.bots).filter((b) => !b.archived && !b.settings.hiddenFromSidebar).map((b) => `${b.id}\u0000${b.profile.name}`).join("\u0001"));
  useEffect(() => {
    const bots = menuKey ? menuKey.split("\u0001").map((x) => { const [id, name] = x.split("\u0000"); return { id: id!, name: name ?? "" }; }) : [];
    void nativeCall("calls.menu.set", { bots }).catch(() => {});
  }, [menuKey]);
  useEffect(() => onNative<{ path: string }>("import-bot-file", (p) => void useTemplates.getState().importFromOpenedPath(p.path)), []);

  const onDrop = (e: DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => f.name.endsWith(".botpack"));
    if (!file) return;
    e.preventDefault();
    const r = new FileReader();
    r.onload = () => void useTemplates.getState().importBytes(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(file);
  };

  if (setupGate === "setup") {
    return (
      <div className="window">
        <SetupScreen />
        <AnnounceOutlet />
      </div>
    );
  }

  if (connection.kind === "connected" && needsOnboarding) {
    return (
      <div className="window" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <Onboarding initialStep={onboardingStep} onDone={(id) => { setNeedsOnboarding(false); void useUi.getState().openBot(id); }} />
      </div>
    );
  }

  return (
    <div className="window" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <BoxBanner />
      <MacDiskBanner />
      <KeyPrompts />
      <MacModesBanner />
      <Sidebar />
      {connection.kind !== "connected" ? (
        <main className="main"><ConnectionScreen state={connection} onRetry={() => window.synapse.retry()} /></main>
      ) : view.kind === "new-chat" ? (
        <NewChat />
      ) : view.kind === "chat" ? (
        <ChatView botId={view.botId} />
      ) : (
        <main className="main">
          {/* This blank rectangle was the other half of the worst state in the app: with `view` still
              {kind:"empty"} and loadAll() failed, the user got an empty sidebar over an empty pane
              with nothing to read and nothing to click. The bootstrap's three outcomes render here
              now; once it is ready and the view is genuinely empty, the pane is blank as before. */}
          <Async resource={asResource(bootstrap, () => void loadAll())} variant="pane" label={STR.loading}>{() => null}</Async>
        </main>
      )}
      {settingsOpen && <SettingsModal />}
      {computerOpen && <ComputerView />}
      <MarketplaceModal />
      <ConnectGoogleSheet />
      <ExportSheet />
      <ImportSheet />
      <DetailsSheet />
      <Overlays />
      <ConfirmHost />
      {connection.kind === "connected" && <IncomingCall />}
      {connection.kind === "connected" && <CallHost />}
      {setupReopened && <div className="setup-overlay"><SetupScreen onClose={() => useSetupGate.getState().close()} /></div>}
      {/* Bug 46: the announcement strip on whichever surface is on top. Last, so it is mounted after
          every surface that could become that top surface in the same commit. */}
      <AnnounceOutlet />
    </div>
  );
}
