import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

// THE DEFECT: main.tsx rendered <App /> bare, with no boundary anywhere in app/src. React unmounts
// the whole tree when a render throw reaches the root, so ONE bad row anywhere — an activity icon
// this build doesn't know, a lookup that came back undefined — emptied <div id="root"> and left the
// user a white window whose only recovery was quitting the app. This is the floor under that.
//
// Local labels: shared/src/strings*.ts belongs to other tracks this cycle (same reasoning as
// TemplateMenu.tsx), so the four strings this panel needs live here.
const CRASH_TITLE = "Something went wrong";
const CRASH_BODY = "This screen stopped drawing. Your Bots and their conversations are safe on the computer — nothing here is lost.";
const TRY_AGAIN = "Try again";
const RELOAD = "Reload";

interface Props {
  children: ReactNode;
  /**
   * How to get a fresh renderer. Defaults to reloading the window, which is the honest recovery
   * here: the renderer owns no durable state (every Bot, transcript and setting is the host's, and
   * the window rebuilds them from listAgents/getHostSettings on the next connect), so a reload
   * costs a redraw and a reconnect and is guaranteed to reach a usable window — the same recovery
   * as quitting and relaunching, minus the process restart. A prop, because jsdom forbids
   * redefining window.location.reload.
   */
  onReload?: () => void;
}

interface State {
  error: Error | null;
  /** Bumped by "Try again" so the children remount from scratch rather than resuming mid-tree. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The stack is the only trace left of a crash the user recovered from, and the renderer's
    // console is reachable in a packaged build (View → Toggle Developer Tools).
    console.error("[renderer] uncaught render error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    // A keyed Fragment, not a wrapper element: .window is a flex row whose direct children are the
    // sidebar and the main pane, and an extra div between them would collapse the whole layout.
    if (!error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    return (
      <div className="crash" role="alert">
        <span className="crash-title">{CRASH_TITLE}</span>
        <p className="crash-body">{CRASH_BODY}</p>
        {/* The message, verbatim: a panel that won't say what broke is only a prettier white screen. */}
        <p className="crash-detail">{error.message}</p>
        <div className="crash-actions">
          {/* Two ways back, deliberately different: "Try again" remounts this subtree only, so a
              transient throw (a row whose data has since been replaced by an SSE event) recovers
              without losing composer drafts or scroll position; "Reload" is the guaranteed one for
              a throw that repeats. */}
          <button type="button" className="btn-primary" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>{TRY_AGAIN}</button>
          <button type="button" className="btn-outline" onClick={() => (this.props.onReload ?? (() => window.location.reload()))()}>{RELOAD}</button>
        </div>
      </div>
    );
  }
}
