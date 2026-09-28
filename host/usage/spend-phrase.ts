/**
 * "Tell me before you spend more than $X", said in chat. Read host-side from the user's own message, so the
 * alert costs no tool schema in any Bot's prompt (a tool would have added to every call; the bot tool count
 * and bytes are held under measured ceilings in host/test/perf/prompt-budget.test.ts). The Bot is told in a
 * one-message hint on the message that set it.
 */
const AMOUNT = String.raw`\$?\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:dollars?|usd|bucks)?`;
const SET = [
  new RegExp(String.raw`\b(?:tell|ask|warn|check with|ping|notify)\s+me\s+(?:before|if|when)\s+(?:you\s+)?(?:spend(?:ing)?|go(?:ing)?|it\s+costs?|this\s+costs?|(?:it|this)\s+(?:gets?|goes)|costs?)\s+(?:more\s+than|over|above|past|beyond)\s+${AMOUNT}`, "i"),
  new RegExp(String.raw`\b(?:tell|ask|warn|check with|ping|notify)\s+me\s+(?:before|if|when)\s+(?:this|it)\s+costs?\s+(?:more\s+than|over)\s+${AMOUNT}`, "i"),
  new RegExp(String.raw`\bspend(?:ing)?\s+(?:limit|cap|alert)\s+(?:of|at|to)\s+${AMOUNT}`, "i"),
];
const CLEAR = /\b(?:never\s*mind|cancel|clear|remove|stop|drop|forget)\b[^.?!]{0,20}\bspend(?:ing)?\s+(?:alert|limit|cap)\b/i;

export type SpendPhrase = { kind: "set"; usd: number } | { kind: "clear" } | null;

export function parseSpendPhrase(text: string): SpendPhrase {
  if (CLEAR.test(text)) return { kind: "clear" };
  for (const re of SET) {
    const m = re.exec(text);
    if (m) {
      const usd = Number(m[1]);
      if (Number.isFinite(usd) && usd > 0) return { kind: "set", usd };
    }
  }
  return null;
}
