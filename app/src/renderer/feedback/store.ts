import { create } from "zustand";
import type { FeedbackType } from "@synapse/shared";
import { nativeCall } from "../native";

export interface FeedbackOpen { type?: FeedbackType; /** A crash report's id, or "latest": its report becomes the logs. */ crash?: string }

interface State { open: boolean; preset: FeedbackOpen; screenshot: string | null }
export const useFeedback = create<State>(() => ({ open: false, preset: {}, screenshot: null }));

/**
 * Opens the Send feedback sheet. The window is captured first, so the screenshot shows the app
 * and not the sheet; capture gives up after a moment rather than delay the sheet.
 */
export async function openFeedback(preset: FeedbackOpen = {}): Promise<void> {
  if (useFeedback.getState().open) return;
  const shot = await Promise.race([
    nativeCall<{ png: string | null }>("feedback.screenshot").then((r) => r.png, () => null),
    new Promise<null>((r) => setTimeout(() => r(null), 600)),
  ]);
  useFeedback.setState({ open: true, preset, screenshot: shot });
}

export function closeFeedback(): void {
  useFeedback.setState({ open: false, preset: {}, screenshot: null });
}
