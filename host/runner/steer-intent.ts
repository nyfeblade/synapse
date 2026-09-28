/**
 * Bug 198 (steering while work is running): what a message the user
 * sends while their Bot is mid-turn is asking for. Deterministic and free — no model call:
 *  - "stop":   halt the running turn: stop words (in a few languages), prohibitions ("don't push",
 *              "hold off", "undo that"), a bare "no" / "wrong", or a clear redirect ("no, do X instead");
 *  - "status": a quick progress question ("how long?"), answered in the same turn without stopping it;
 *  - "steer":  anything else, delivered to the running turn at its next safe point. The default for an
 *              ambiguous message; anything that forbids or reverses work errs toward "stop".
 */
export type SteerIntent = "stop" | "status" | "steer";

// Words that carry no intent of their own ahead of a command: "ok stop", "hey, cancel that", "please wait".
const FILLER = /^(?:(?:ok(?:ay)?|hey|hi|please|pls|plz|oh|um+|uh+|hmm+|sorry|so|just|and|but|bot)\b[\s,.!-]*)+/;
const STOP_LEAD = /^(?:stop|cancel|abort|halt|hold (?:on|up|it)|hang on|pause|never ?mind|nvm|scratch that|forget (?:it|that|this|about it)|kill (?:it|that|this)|enough|quit|freeze)\b/;
// "wait" stops only on its own ("wait", "wait!", "wait, no", "wait a sec"); "wait for the tests…" steers.
const WAIT = /^wait(?:\s*$|\s*[!.,;:—–-]|\s+(?:no|wait|stop|up|a (?:sec|second|minute|moment|min)|one (?:sec|second|minute|moment))\b)/;
// Other languages: the word alone or followed by punctuation / "now" ("para" alone stops; "para que…" doesn't).
const FOREIGN = /^(?:arr[êe]te[sz]?|para|pare|parad|det[ée]n(?:te|ganse)?|basta|halt|stopp|alto|ferma(?:ti)?|aufh[öo]ren|h[öo]r auf|annule[rz]?|cancela(?:r)?|nein|nicht|non|nee|niet|não|nao|chega|smettila|annulla|нет|стоп|хватит)(?:\s*[!.,]|\s+(?:ya|tout|jetzt|sofort|subito|ahora|maintenant|now)(?![\p{L}])|\s*$)/u;
// Prohibitions said in another language, anywhere in the message.
const FOREIGN_PROHIBIT = /(?:^|\s)(?:nicht so schnell|ne (?:le |la |les )?fais pas|ne touche pas|no lo hagas|no hagas|lass (?:das|es)|non farlo|n[ãa]o fa[çc]a)(?![\p{L}])/u;
// Fix round 2: more ways to forbid. A trailing "don't" ("please don't", "no, don't"), shouldn't / must not,
// leave it (alone), skip / avoid, not yet, no need to …, not the X. False stops are the safe side.
const TRAILING_DONT = /(?:^|[\s,.;])(?:don'?t|dont|do not)[\s!.]*$/;
const SHOULDNT = /\b(?:shouldn'?t|mustn'?t|should not|must not|better not|ought not)\b/;
// "leave it running" / "leave it on" keep the work going, so they steer.
const LEAVE = /\bleave (?:it|that|this|them|those|these)\b(?!\s+(?:running|on|going|open|as is)\b)|\bleave\b[\w\s'-]{0,40}\balone\b/;
const SKIP_AVOID = /\b(?:skip|avoid)\b/;
const NOT_YET = /\bnot yet\b/;
const NO_NEED = /\bno need (?:to|for) (?!(?:stop|wait|pause|rush|hurry|worry)\b)\w+/;
const NOT_THE = /\bnot (?:the|this|that|these|those) \w+/;
const STOP_WORD = /\b(?:stop|cancel|abort|halt)\b/;
const NEGATED_STOP = /\b(?:don'?t|dont|do not|never|no need to|not|without)\s+(?:\w+\s+)?(?:stop|cancel|abort|halt|pause|wait)/;
// Prohibitions: don't / do not + a verb, except the ones that don't forbid anything ("don't forget", "I don't know").
const DONT = /\b(?:don'?t|dont|do not)\s+(?!(?:stop|halt|cancel|pause|wait|worry|mind|rush|forget|know|think|care|hesitate|need|have to)\b)\w+/;
const NEVER_LEAD = /^never\s+(?!mind\b)\w+/;
const REVERSE = /\b(?:hold off|undo|revert|roll ?back|back out)\b/;
const CANCEL_VERB = /\b(?:cancel|abort|halt|kill)\s+(?:the|that|this|it|my|your|all|every)\b/;
const BARE_NO = /^(?:actually[\s,]*)?(?:no+|nope|nah|wrong|not that(?: one)?|not like that|that'?s (?:wrong|not (?:it|right|what i (?:asked|meant|wanted)))|this is wrong|you'?re wrong)[\s!.,]*$/;
const WRONG_LEAD = /^(?:wrong|actually no|(?:that'?s|this is|it'?s|you'?re) (?:wrong|not right|incorrect))\b/;
const REDIRECT_LEAD = /^(?:(?:no|nope|nah)\s*[,.!-]+|no no\b|scratch that\b|change of plans?\b|start over\b)\s*\S/;
const REDIRECT_ANY = /\b(?:instead|change of plans?|start over|different approach|wrong (?:one|file|repo|branch|thing))\b/;
const CARRY_ON = /\b(?:keep going|carry on|continue|go ahead|looks? good|sounds? good|thanks|thank you|nice|great|perfect|no rush|take your time|no worries|no problem|all good|(?:that'?s|it'?s) (?:fine|ok|okay))\b/;
const STATUS = new RegExp([
  String.raw`\bhow long\b`, String.raw`\bhow(?:'s| is| are)\s+(?:it|things|that|this|everything|the \w+|progress|work)\s+(?:going|coming)`,
  String.raw`\bhow(?:'s| is) it going\b`, String.raw`\bhow far\b`, String.raw`\beta\b`, String.raw`\bstatus\b`, String.raw`\bprogress\b`,
  String.raw`\bany (?:update|news|luck)\b`, String.raw`\bare you (?:done|finished|close|almost)\b`, String.raw`\balmost (?:done|there|finished)\b`,
  String.raw`\b(?:done|finished) yet\b`, String.raw`\bwhere are you (?:at|with|up to)\b`, String.raw`\bhow much (?:longer|more)\b`,
  String.raw`\bstill (?:working|going|at it|there|running)\b`, String.raw`\bwhat(?:'s| is) (?:taking|happening|going on)\b`, String.raw`\bwhat are you (?:doing|up to|working on)\b`,
].join("|"));

export function classifySteer(raw: string): SteerIntent {
  const text = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return "steer";
  const t = text.replace(FILLER, "").trim() || text;
  const question = /\?\s*$/.test(t);
  const words = t.split(" ").filter(Boolean).length;
  const negated = NEGATED_STOP.test(t);
  if (!negated && (STOP_LEAD.test(t) || WAIT.test(t) || FOREIGN.test(t) || /^hold[\s!.]*$/.test(t))) return "stop";
  // A short, non-question message that still says stop: "please just stop now", "ok cancel it".
  if (!negated && !question && words <= 6 && STOP_WORD.test(t)) return "stop";
  if (DONT.test(t) || NEVER_LEAD.test(t) || REVERSE.test(t) || TRAILING_DONT.test(t) || SHOULDNT.test(t) || FOREIGN_PROHIBIT.test(t)) return "stop";
  if (NO_NEED.test(t)) return "stop";
  // Fix round 3: "skip the lint step and carry on" narrows the work rather than halting it.
  if (!CARRY_ON.test(t) && (LEAVE.test(t) || SKIP_AVOID.test(t) || NOT_YET.test(t) || NOT_THE.test(t))) return "stop";
  if (!question && CANCEL_VERB.test(t)) return "stop";
  if (BARE_NO.test(t) || WRONG_LEAD.test(t)) return "stop";
  if (!CARRY_ON.test(t) && !question && (REDIRECT_LEAD.test(t) || REDIRECT_ANY.test(t))) return "stop";
  if (STATUS.test(t)) return "status";
  return "steer";
}
