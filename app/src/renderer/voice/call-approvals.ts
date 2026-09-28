/**
 * Bug 142: spoken approvals on a call. A pending approval card is read aloud as a short question; the user's
 * answer is matched here, in code, only when it is an UNAMBIGUOUS yes or no ("yes", "send it", "do it"; "no",
 * "cancel", "stop", "don't"). Anything else ("yes but make it ten minutes", "who's it going to?") is not an answer
 * here: it goes to the Bot's voice, which can change the pending action and read it back for a final yes.
 */
const YES = new Set([
  "yes", "yeah", "yep", "yup", "yes please", "sure", "ok", "okay", "go ahead", "go for it", "send it", "do it", "please do",
  "yes send it", "yes do it", "yeah send it", "yeah do it", "yes go ahead", "ok send it", "okay send it", "ok do it", "okay do it",
  "sounds good", "that's fine", "that is fine", "looks good", "approved", "approve", "confirm", "confirmed", "yes it's fine",
]);
const NO = new Set([
  "no", "nope", "nah", "no thanks", "no thank you", "cancel", "cancel it", "cancel that", "stop", "don't", "do not", "don't send it",
  "don't do it", "do not send it", "never mind", "nevermind", "hold off", "not now", "no don't", "no cancel", "no stop",
]);

const norm = (t: string) => t.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

export function approvalAnswer(text: string): "yes" | "no" | null {
  const t = norm(text);
  if (!t) return null;
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return null;
}

/** The card as a spoken question: what it does (who gets what), then "Should I go ahead?". */
export function approvalQuestion(summary: string): string {
  return `${summary.replace(/[.\s]+$/, "")}. Should I go ahead?`;
}
