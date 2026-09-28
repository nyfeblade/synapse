/** One tracked element in one frame (recorder.ts). */
export interface Sample {
  /** Identity of the DOM node (a remount gets a new id under the same key). */
  id: number;
  /** What the node shows: its class plus bot/entry id, label or text — stable across a remount. */
  key: string;
  x: number; y: number; w: number; h: number;
  /** Effective opacity (the node's and its ancestors'); 0 when not displayed. */
  op: number;
  /** Computed transform, "" for none. */
  tf: string;
  /** Finite animations running on it. */
  anim: number;
  /** Inline transform and view-transition-name: what a script left on it. */
  inTf: string; vtn: string;
  cls: string;
  /** Length of a text field's value (the composer); -1 for anything else. */
  val: number;
  /** Length of a bubble's text (a streamed reply's progress; 0 = the typing dots); -1 for anything else. Optional: hand-made recordings omit it. */
  txt?: number;
}
/** `ch`: the transcript's clientHeight (a resize changes it; content does not). */
export interface Frame { t: number; vt: boolean; scroll: number; scrollMax: number; ch: number; els: Sample[] }
export interface MotionEvent {
  t: number;
  kind: "css-start" | "css-cancel" | "waapi-start" | "waapi-cancel" | "waapi-finish" | "vt-start" | "vt-end" | "vt-abort" | "vt-overlap"
    | "input" | "layout-shift" | "error" | "mark";
  id?: number; key?: string; name?: string; value?: number;
}
export interface Recording { frames: Frame[]; events: MotionEvent[] }
export interface Glitch { kind: string; detail: string; t?: number }
