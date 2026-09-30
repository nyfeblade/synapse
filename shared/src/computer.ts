export const SUBAGENT_TYPES = ["generalPurpose", "computerUse", "browserUse"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

/** APR-02 `computer` surface: Computer actions that are reviewed (not screenshot, move, wait, scroll). Shared so Track C needn't wait for Track B. */
export const REVIEWED_COMPUTER_ACTIONS: ReadonlySet<string> = new Set(["click", "double_click", "drag", "type", "key"]);
/** APR-02: browser tools that are not reviewed (browser_tabs is reviewed only for new/close). */
export const BROWSER_UNREVIEWED: ReadonlySet<string> = new Set(["browser_snapshot", "browser_take_screenshot", "browser_get_bounding_box", "browser_highlight", "browser_scroll"]);

/** "Computer perception" (decisions.md 2026-09-21): how a computerUse subagent sees the screen. `screenshots` = the
 *  Computer tool with a screenshot after every call (the default); `live` = Look/Act/Screenshot over the host's live
 *  accessibility model (beta: stays opt-in until the real-model computer-use benchmark passes). */
export const COMPUTER_PERCEPTION_MODES = ["screenshots", "live"] as const;
export type ComputerPerception = (typeof COMPUTER_PERCEPTION_MODES)[number];

/** The screen as a computer subagent's model sees it: the size of the screenshots it gets, which is also the coordinate
 *  space of its clicks. The display itself is always 1280×800; a model whose provider would shrink a 1280×800 image
 *  gets screenshots already at the shrunk size, and its coordinates are scaled back (host/computer/screen-view.ts). */
export interface ScreenView { w: number; h: number }

export interface DisplayInfo { botId: string; index: number; display: string; cdpPort: number; running: boolean; generation: number }

export type ComputerActionKind = "click" | "drag" | "move" | "scroll" | "type" | "key" | "navigate";
/** CMP-07: drives the preview's synthetic cursor and the header glyph (CMP-06). */
export interface ComputerActionEvent { botId: string; index: number; kind: ComputerActionKind; x: number | null; y: number | null; x2?: number; y2?: number; at: number; source: "computer" | "browser" }

export type BoxHelpReason = "auth" | "captcha" | "payment" | "other";
export type BoxHelpStatus = "pending" | "handed_back" | "dismissed" | "viewer_closed";
/** §4.3 Box-help request, plus `inControl` for the "You're in control" pill (CMP-08, CMP-18). */
export interface BoxHelpView {
  id: string; botId: string; instruction: string; reason: BoxHelpReason; domain: string | null; idpDomain: string | null;
  screenshotDataUrl: string | null; status: BoxHelpStatus; inControl: boolean; createdAt: number; settledAt: number | null;
}

export type ForeverBoxPhase = "ready" | "starting" | "updating" | "recovering" | "resetting" | "unreachable";
export type ForeverBoxStep = "getting_ready" | "backing_up" | "recreating" | "starting" | "cleaning_up" | "reconnecting" | "wiping" | "creating";
export interface ForeverBoxStatus {
  phase: ForeverBoxPhase; step: ForeverBoxStep | null; imageVersion: string; latestVersion: boolean; backupReady: boolean;
  lastSnapshotAt: number | null; busyBotIds: string[]; doctor: { ranAt: number | null; failed: string[] }; error: string | null;
  /** Portable install: new turns are held while the Mac re-provisions the box (messages queue, answered after). */
  maintenance?: boolean;
}

export type DiskLevel = "ok" | "soft" | "hard";
export interface DiskPressureView { level: DiskLevel; freeBytes: number; totalBytes: number; freePct: number; checkedAt: number; diskSaverBotId: string | null }

/** `unusable` (bug 56): the stored name is one the Bot's env refuses (validateSecretName), with the reason. Such a
 *  secret is never delivered, so no surface may show it as saved; it is listed with Rename and Remove instead. */
export interface SecretStatusEntry { name: string; description: string; updatedAt: number; valueHash: string; needsSync: boolean; unusable?: string }
export type SecretDestination = "env" | "connector" | "page";
export interface SecretRequestView {
  label: string; description: string; destination: SecretDestination; field: string | null; connector: string | null;
  url: string | null; target: { ref?: string; selector?: string } | null;
  status: "pending" | "saved" | "filled" | "fill_failed" | "failed";
}

/** SEC-04 page-fill form field (named apart from the Phase 2 chat-card FormField). */
export interface PageFormField { name: string; label: string; type: "text" | "email" | "tel" | "password" | "address" | "number"; secret: boolean; required: boolean; fillTarget: { ref?: string; selector?: string } | null }
export interface FormCardView { kind: "form"; title: string; url: string | null; fields: PageFormField[]; status: "pending" | "submitted" | "fill_failed"; answeredFields: string[] }
/** Tells the SEC-04 page-fill form apart from a Phase 2 CHAT-16 card; both use kind "form". */
export function isPageFormCard(card: { kind: string }): card is FormCardView {
  return card.kind === "form" && "answeredFields" in card;
}
/**
 * SendMessage routing: a "form" card that targets a page (url, fillTarget or a secret field) is the SEC-04 page-fill form.
 * Security fix M8: a password field (type or kind "password") also goes to Phase 3, so it is never a visible chat input.
 */
export function isPageFormCardArgs(card: unknown): boolean {
  if (!card || typeof card !== "object") return false;
  const c = card as { kind?: unknown; url?: unknown; fields?: unknown };
  if (c.kind !== "form") return false;
  if (typeof c.url === "string" && c.url) return true;
  return Array.isArray(c.fields) && c.fields.some((f) => {
    if (!f || typeof f !== "object") return false;
    const x = f as { secret?: unknown; fillTarget?: unknown; type?: unknown; kind?: unknown };
    return !!x.secret || !!x.fillTarget || x.type === "password" || x.kind === "password";
  });
}

export type AsyncTaskStatus = "queued" | "running" | "done" | "error" | "aborted" | "timed_out";
export interface AsyncTaskView { id: string; kind: "subagent" | "shell"; botId: string; type: string; title: string; status: AsyncTaskStatus; startedAt: number; endedAt: number | null }

export type SnapshotReason = "scheduled" | "before_update" | "before_reset" | "manual";
export interface SnapshotInfo {
  id: string; createdAt: number; bytes: number; reason: SnapshotReason; parts: ("workspace" | "home" | "agent-data")[]; sha256: string;
  /** Bug #66: the trees inside, as the box archived them (e.g. "workspace", "home/box", "home/bots" = every Bot's own
   *  home); absent when the box's helper predates the manifest. */
  trees?: string[];
}
