import type { ReactNode } from "react";

export interface EmptyAction { label: string; onClick(): void }

/**
 * The one empty / error state (UI polish pass, 2026-09-24): an icon, a title, at most ONE line and at
 * most ONE action. Nothing more is allowed by the type, which is the point — a surface that wants a
 * paragraph of explanation or a row of buttons has to change this component to get it.
 *
 * Error copy is plain language plus the one step that helps ("Retry"), never a bare code.
 * `loading` wins over everything: an empty state is never shown while the answer is still coming
 * (the loading/empty mutex), so a list that has not loaded yet cannot flash "Nothing here".
 */
export function EmptyView({ icon, title, line, action, tone = "quiet", loading = false, loadingLabel = "Loading…", size = "stage", announce = true, children }: {
  icon?: ReactNode;
  title: string;
  line?: string | null;
  action?: EmptyAction | null;
  tone?: "quiet" | "error";
  loading?: boolean;
  loadingLabel?: string;
  size?: "stage" | "inline";
  /** A live status (the default) or a still picture — the empty chat is not an announcement. */
  announce?: boolean;
  /** A live figure under the line (the Computer stage's elapsed time). Data, not copy. */
  children?: ReactNode;
}) {
  if (loading) return <div role="status" className={`empty-view ${size}`}><span className="empty-view-line">{loadingLabel}</span></div>;
  return (
    <div role={announce ? "status" : undefined} className={`empty-view ${size}${tone === "error" ? " error" : ""}`}>
      {icon ? <span className="empty-view-icon" aria-hidden="true">{icon}</span> : null}
      <span className="empty-view-title">{title}</span>
      {line ? <span className="empty-view-line">{line}</span> : null}
      {children}
      {action ? <button type="button" className="btn-secondary" onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}
