// First import on purpose: marks when the bundle starts evaluating (renderer/launch/trace.ts).
import "./launch/trace-first";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LaunchOverlay } from "./launch/LaunchOverlay";
import { launchMark } from "./launch/trace";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startThemeSync } from "./theme";
import { installRendererErrorReporting } from "./crash-reporting";
import { installTtftTrace } from "./ttft-trace";
import { useUi } from "./store";
import { useStandup, wireStandup } from "./standup/store";
import "./styles/tokens.css";
import "./styles/app.css";
// Self-registers the Theme picker into Settings → General (SET-02).
import "./components/settings/AppearanceBlock";
// Self-registers the Memory dropdown into Settings → General (MEM-07).
import "./components/settings/MemoryBlock";
// Explicit "/index" (not "./components/cards") avoids macOS's case-insensitive filesystem
// resolving this to the pre-existing Phase 2 "Cards.tsx" instead of the cards/ directory.
import "./components/cards/index";
import "./components/settings/UsageSection";
import "./components/settings/ComputerSection";
import "./components/settings/VoiceSection";
import "./components/settings/SchedulesSection";
import "./components/settings/SecurityKeyBlock";
import "./components/settings/UpdatesSection";
import "./components/settings/BackupsSection";
import "./components/settings/DiagnosticsSection";
import "./components/settings/SystemSection";
import "./components/UpdatesSection"; // Phase 3 box updates, as a block in Settings → Updates
import "./marketplace/ManagePlugins";
import "./google/ConnectedAccountsBlock"; // Settings → General → Connected accounts (ORIG-GOOGLE)
import "./styles/google.css";
import "./styles/usage-dashboard.css";
import "./styles/voice-calls.css";
import "./styles/living-avatars.css";
import { installLivingEvents } from "./avatar/living-events";

// Every render throw in the renderer used to unmount this root and leave a white window whose
// only recovery was quitting; the boundary degrades that to a panel that says what happened and
// offers a way back.
launchMark("script");
createRoot(document.getElementById("root") as HTMLElement).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <LaunchOverlay />
  </>,
);
startThemeSync();
// TTFT war room: opt-in timing of the first streamed token (localStorage ttftTrace=1).
installTtftTrace((cb) => window.synapse.onEvent(cb));
// Living Bots (bug 226): stuck, remembering, hand-offs and long replies, from the same event stream.
installLivingEvents((cb) => window.synapse.onEvent(cb), () => useUi.getState().activeBotId);
// Settings → Diagnostics: window errors go to the local crash store; a recovered problem shows a toast.
installRendererErrorReporting(() => useUi.getState().openSettings("diagnostics"));
// The daily standup card: loaded on every (re)connect, then kept current by its SSE channel.
wireStandup();
useUi.subscribe((s, prev) => { if (s.connection.kind === "connected" && prev.connection.kind !== "connected") void useStandup.getState().load(); });
// Start-up trace: when the connection first changes state, and when the chat first has something to show.
useUi.subscribe((st, prev) => { if (st.connection.kind !== prev.connection.kind) launchMark(`connection ${st.connection.kind}`); });
