import { STR } from "@synapse/shared";
import type { ReactNode } from "react";
import type { AsyncResource } from "../async-resource";

/**
 * Renders the three outcomes of an async read, so a component only writes the ready one.
 *
 * `children` is a render prop taking the loaded value, which is what makes "render nothing by
 * accident" unsayable: there is no code path here that returns null, and the caller never sees a
 * value that might not be there.
 *
 * `variant="pane"` fills a whole empty surface (the main pane behind the window); the default sits
 * inline in a card, a list or a settings block. Both follow the app's existing conventions:
 * role="status" for pending (ConnectionScreen), role="alert" + `.error` + a Retry link for failed
 * (RoutinesSection, UsageSection).
 */
export function Async<T>({ resource, children, variant = "inline", label }: {
  resource: AsyncResource<T> & { reload(): void };
  children: (value: T) => ReactNode;
  variant?: "inline" | "pane";
  label?: string;
}): ReactNode {
  const cls = variant === "pane" ? "async-pane" : "async-state";
  if (resource.status === "loading") return <div className={cls} role="status" aria-label={label}>{STR.loading}</div>;
  if (resource.status === "error") {
    return (
      <div className={cls} aria-label={label}>
        <span className="error" role="alert">{resource.message}</span>
        <button type="button" className="link-btn" onClick={resource.reload}>{STR.retry}</button>
      </div>
    );
  }
  return <>{children(resource.value)}</>;
}
