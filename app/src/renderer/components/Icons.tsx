import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
/**
 * Every icon in the app, on one grid, at one weight.
 *
 * WHAT THIS REPLACED: `base(size, sw, p)`, where each icon chose its own stroke width (1.8, 2 or
 * 2.2) and its own default size (12, 13, 14, 15, 16 or 18). Nothing decided those numbers — they
 * were whatever looked right in the one place the icon was first used — and the result was a header
 * where four adjacent glyphs were drawn at three weights, which reads the way three font weights in
 * one sentence read.
 *
 * ONE WEIGHT AS RENDERED (UI polish pass, 2026-09-24, critique 2.2): 1.4 CSS px at every size. A
 * stroke in viewBox units scales with the icon, so the same "1.5" drew 0.56px at 9px and 1.5px at
 * 24px. Every icon carries the `icon` class, and app.css gives its shapes
 * `vector-effect: non-scaling-stroke`, so strokeWidth is read in screen pixels instead.
 *
 * TWO SIZES: 16 (inline, menus, rows) and 18 (the header and toolbar bars, set by CSS on the bar).
 * The only glyphs drawn smaller are status MARKS inside a badge of their own (the check in a 14px
 * activity mark, the × in a text chip), which are part of that badge, not icons beside a label.
 */
const base = (size: number, p: P) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.4,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p,
  className: p.className ? `icon ${p.className}` : "icon",
});

export const PlusIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M12 5v14M5 12h14" /></svg>;
export const SearchIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const GridIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>;
export const AttachIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M12 5v14M5 12h14" /></svg>;
export const ScreenShareIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M12 13V7M9.5 9.5 12 7l2.5 2.5" /></svg>;
export const MicIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
export const MicOffIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" /></svg>;
export const VoiceIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M6 10v4M10 7v10M14 5v14M18 9v6" /></svg>;
export const HeadsetIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></svg>;
export const HangUpIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M3 14.5c5-4.7 13-4.7 18 0l-2.2 2.3-3.3-1.4v-2.2a11 11 0 0 0-7 0v2.2l-3.3 1.4z" /></svg>;
export const GearIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M9.17 5.16L10.39 4.78L10.72 2.49L13.28 2.49L13.61 4.78L14.84 5.17L15.97 5.75L17.82 4.37L19.63 6.18L18.25 8.03L18.84 9.17L19.22 10.39L21.51 10.72L21.51 13.28L19.22 13.61L18.83 14.84L18.25 15.97L19.63 17.82L17.82 19.63L15.97 18.25L14.83 18.84L13.61 19.22L13.28 21.51L10.72 21.51L10.39 19.22L9.16 18.83L8.03 18.25L6.18 19.63L4.37 17.82L5.75 15.97L5.16 14.83L4.78 13.61L2.49 13.28L2.49 10.72L4.78 10.39L5.17 9.16L5.75 8.03L4.37 6.18L6.18 4.37L8.03 5.75Z" /><circle cx="12" cy="12" r="3.2" /></svg>;
export const CollapseIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="m6 6 6 6-6 6M13 6l6 6-6 6" /></svg>;
export const CloseIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const BackIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="m15 6-6 6 6 6" /></svg>;
export const ShareIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" /></svg>;
export const MailIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
export const TerminalIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
export const FileIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>;
export const EditIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
export const GlobeIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
export const CalendarIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
export const ToolIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M14 7a4 4 0 0 0 5 5l-8 8-4-4 8-8z" /></svg>;
export const ThoughtIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><circle cx="12" cy="12" r="8" /><path d="M9 10h.01M12 10h.01M15 10h.01" /></svg>;
export const ServerIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /></svg>;
export const ChevronDownIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="m6 9 6 6 6-6" /></svg>;
export const CheckIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="m5 12 5 5 9-10" /></svg>;
export const TrashIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>;
export const PencilIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
export const ClockIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const PauseIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M9 6v12M15 6v12" /></svg>;
export const CopyIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const LinkIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M10 14a4 4 0 0 0 5.66 0l2.34-2.34a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0L6 12.34a4 4 0 0 0 5.66 5.66l1-1" /></svg>;
export const HomeIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></svg>;
export const SendIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
export const ChevronRightIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="m9 6 6 6-6 6" /></svg>;
export const ChartIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M4 20h16M7 16v-4M12 16V7M17 16v-7" /></svg>;
// Bug 134: a raised hand on a call, and the voicemail player's play.
export const HandIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.4 0-3.8-1.2-5-3l-2.2-3.6a1.4 1.4 0 0 1 2.3-1.6L8 13" /></svg>;
export const PlayIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M8 5v14l11-7z" /></svg>;
// The overflow: three filled dots, 2px across at 16px. The 1.4px non-scaling stroke drew them as
// specks that vanished beside the header's other glyphs (critique 2.2).
export const MoreIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)} stroke="none" fill="currentColor"><circle cx="5.5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18.5" cy="12" r="1.5" /></svg>;
// UI polish pass: the glyphs that used to be hand-drawn inline on their own 16-unit grids at a 1px
// stroke (the header's display, the Computer view's exit, the Teach pill's record mark).
export const DisplayIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
export const ExitFullscreenIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
export const RecordIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /></svg>;
// Stop, in Send's own slot: a filled square.
export const StopIcon = ({ size = 16, ...p }: P) => <svg {...base(size, p)} stroke="none" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
