// Feedback text checks shared by the app (its preview), the website (its preview) and the
// /api/feedback function (which re-applies them regardless). Plain JavaScript with no imports, so the
// Vercel function (which installs nothing), the browser and the app all load the same file.
//
// The rule: never censor what someone says. Hidden characters are removed, personal details are
// hidden, and everything else only adds labels for review.

/* ---- invisible and control characters ---- */
const HIDDEN = /[​-‍⁠﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu;
const CONTROLS = /[\p{Cc}\p{Cf}]/gu;
// Blank-looking Hangul fillers (U+3164, U+115F, U+1160). The soft hyphen is a format character (\p{Cf}) and goes with CONTROLS.
const FILLERS = /[\u3164\u115F\u1160\uFFA0]/g;
const VS_RUN = /[︀-️\u{E0100}-\u{E01EF}]{3,}/gu;

/** NFKC, with zero-width, bidi, TAG and other control characters (except \n and \t) and long variation-selector runs removed. */
export function stripHidden(input) {
  const raw = String(input ?? "").replace(/\r\n?/g, "\n");
  const pass = (s) => s.replace(HIDDEN, "").replace(FILLERS, "").replace(VS_RUN, "").replace(CONTROLS, (c) => (c === "\n" || c === "\t" ? c : ""))
    // Combining marks stacked on plain ASCII (z̶a̶l̶g̶o̶, strike-through) hide words from pattern checks; after NFKC,
    // a real accented letter is one precomposed character and keeps its mark.
    // U+FE0F and U+20E3 stay: they make keycap emoji (1️⃣, #️⃣).
    .replace(/([\x21-\x7E])(?:(?![\uFE0F\u20E3])\p{M})+/gu, "$1");
  const text = pass(pass(raw).normalize("NFKC"));
  return { text, removed: text !== raw.normalize("NFKC") };
}

/* ---- personal details ---- */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const KEYS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, /\bAQ\.[A-Za-z0-9_.-]{8,}/g, /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g, /\bgithub_pat_[A-Za-z0-9_]{8,}/g, /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
];
// Every pattern here runs on untrusted text of any length, so each is linear: a run can only start where
// the lookbehind says it begins, and every repeat is bounded. (An unbounded `[…]+@` restarted at every
// position of a long run of letters and took minutes on 300 KB.)
const BEARER = /\b(Bearer|Basic)\s{1,20}(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g;
const CARD = /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g;
const SSN = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
// US (415) 555-0132 and 555-123-4567; international +44 20 7946 0958, +49 30 123456; UK and EU trunk
// numbers 07700 900123, 020 7946 0958, 030 123456, 06 12 34 56 78. Never inside a longer token (versions, dates, IPs).
const PHONE = /(?<![\w.+-])(?:\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){1,4}\d{2,4}|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[.-]\d{3}[.-]\d{4}|0\d{2,4}(?:[\s-]?\d{3,4}){1,2}|0\d(?:[\s.]\d{2}){4})(?![\w.-]{0,32}\d)/g;
const ADDRESS = /\b\d{1,6}\s{1,4}(?:[A-Z][a-z]{1,30}\s{1,4}){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Crescent|Close|Parkway|Pkwy|Highway|Hwy)\b\.?/g;

/** Keys, emails, card numbers (Luhn-checked), US SSNs, phone numbers and street addresses → placeholders, with a count of each. */
export function redactPersonal(input) {
  const found = { key: 0, email: 0, card: 0, ssn: 0, phone: 0, address: 0 };
  let text = String(input ?? "");
  const sub = (re, kind, to, ok = () => true) => {
    text = text.replace(re, (...a) => {
      const m = a[0];
      if (!ok(m)) return m;
      found[kind]++;
      return typeof to === "function" ? to(...a) : to;
    });
  };
  for (const re of KEYS) sub(re, "key", "[redacted]");
  sub(BEARER, "key", (_m, scheme) => `${scheme} [redacted]`);
  sub(EMAIL, "email", "[email]");
  sub(CARD, "card", "[card]", (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d); });
  sub(SSN, "ssn", "[ssn]");
  sub(PHONE, "phone", "[phone]", (m) => { const n = m.replace(/\D/g, "").length; return n >= 7 && n <= 15; });
  sub(ADDRESS, "address", "[address]");
  return { text, found };
}

const NAMES = { key: ["key", "keys"], email: ["email address", "email addresses"], card: ["card number", "card numbers"], ssn: ["social security number", "social security numbers"], phone: ["phone number", "phone numbers"], address: ["street address", "street addresses"] };
/** "1 phone number, 2 email addresses", or "" when nothing is hidden. */
export function describeHidden(found) {
  return Object.entries(found || {}).filter(([k, n]) => n > 0 && NAMES[k]).map(([k, n]) => `${n} ${NAMES[k][n === 1 ? 0 : 1]}`).join(", ");
}

/** What the app and the website send as the message: hidden characters gone, personal details hidden. Idempotent. */
export function cleanMessage(input) {
  const hidden = stripHidden(input);
  const personal = redactPersonal(hidden.text.trim());
  return { text: personal.text, hiddenRemoved: hidden.removed, found: personal.found };
}

/* ---- profanity, slurs and threats: a label and a masked title; the body is never changed ---- */
// A moderation list: matched as whole words (plus common endings), so "Scunthorpe" or "assess" never match.
const WORDS = new Set([
  "fuck", "shit", "cunt", "bitch", "bastard", "asshole", "dick", "cock", "pussy", "motherfucker", "wanker", "twat", "prick", "slut", "whore",
  "nigger", "nigga", "faggot", "fag", "retard", "spic", "chink", "kike", "tranny", "dyke", "wetback", "gook",
]);
// Two roots that stay abusive inside any compound (…ing, bull…, …head).
const ROOTS = ["fuck", "shit"];
const THREATS = [/\bkill (?:you|u|ya|yourself)\b/, /\b(?:i ?will|i'll|ill|gonna|going to) (?:kill|hurt|shoot|find) (?:you|u)\b/, /\bshoot (?:you|u)\b/, /\bmurder (?:you|u)\b/, /\bkys\b/, /\bwhere you live\b/];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", "@": "a", $: "s" };
const leet = (s) => s.toLowerCase().replace(/[01345@$]/g, (c) => LEET[c]);
const SUFFIX = /(?:s|es|ing|in|ed|er|ers|y|ies)$/;
// Ordinary words that contain a listed root or stem.
const ALLOW = new Set(["shitake", "shiitake", "shiitakes", "shitakes", "cocker", "cockers", "cockerel", "cockerels", "dickens", "dickensian", "dickey", "prickly", "pricking"]);
function badWord(token) {
  const t = leet(token);
  if (!/[a-z]/.test(t) || ALLOW.has(t)) return false;
  if (WORDS.has(t) || ROOTS.some((r) => t.includes(r))) return true;
  const stem = t.replace(SUFFIX, "");
  return stem !== t && (WORDS.has(stem) || WORDS.has(stem.replace(/(.)\1$/, "$1")));
}
const TOKEN = /[\p{L}\p{N}@$]+/gu;
const maskWord = (w) => w[0] + "*".repeat(Math.max(2, w.length - 1));

/** True when the text holds profanity, a slur or a threat. */
export function isAbusive(text) {
  const t = String(text ?? "");
  for (const m of t.matchAll(TOKEN)) if (badWord(m[0])) return true;
  // Spelled out with dots, dashes, stars or spaces between single letters: f.u.c.k, s h i t.
  for (const m of t.matchAll(/(?<![\p{L}\p{N}])(?:[\p{L}@$0-9][.\-_* ]){2,40}[\p{L}@$0-9](?![\p{L}\p{N}])/gu)) if (badWord(m[0].replace(/[.\-_* ]/g, ""))) return true;
  const flat = leet(t).replace(/\s+/g, " ");
  return THREATS.some((re) => re.test(flat));
}

/** A title with each bad word masked (f***) and threat phrases masked word by word. */
export function maskAbuse(title) {
  let out = String(title ?? "").replace(TOKEN, (w) => (badWord(w) ? maskWord(w) : w));
  // Threat phrases: masked in place, keeping lengths, so later matches still line up.
  const keep = (w) => w[0] + "*".repeat(w.length - 1);
  // One pass per pattern over one lowered copy (re-lowering after each match was quadratic on long text).
  for (const re of THREATS) {
    const low = leet(out);
    if (low.length !== out.length) continue; // a character whose lower case is longer: indexes would not line up
    let masked = "", at = 0;
    for (const m of low.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      masked += out.slice(at, m.index) + out.slice(m.index, m.index + m[0].length).replace(/[\p{L}\p{N}@$']+/gu, keep);
      at = m.index + m[0].length;
    }
    out = masked + out.slice(at);
  }
  return out;
}

/* ---- spam: refused only when strong signals combine; one signal is a label ---- */
// Phrases that only spam uses. Normal Mac and product words (AirDrop, Bitcoin, backlinks, working from
// home) are not here: people write feedback about them.
const SPAM_PHRASES = /\b(?:seo services?|buy (?:cheap )?(?:followers|likes|backlinks|traffic)|rank your (?:site|website)|first page of google|guest post(?:ing)? (?:service|offer)s?|online casino|casino bonus|sports betting tips|binary options|forex signals|crypto (?:investment|signals) (?:group|platform|opportunity)|guaranteed (?:profit|returns)|double your (?:bitcoin|crypto|money)|viagra|cialis|payday loans?|make money fast|earn \$\d+ (?:a|per) day|nft drop|whatsapp me)\b/i;
/**
 * The spam signals in a text: more than 3 links, a known spam phrase, or gibberish (mostly symbols, or
 * a very long run of one character). Letters, digits and emoji all count as content.
 */
export function spamSignals(text) {
  const t = String(text ?? "");
  const out = [];
  if ((t.match(/\bhttps?:\/\/|\bwww\./gi) || []).length > 3) out.push("links");
  if (SPAM_PHRASES.test(t)) out.push("spam-phrase");
  const chars = [...t.replace(/\s+/g, "")];
  const content = chars.filter((c) => /[\p{L}\p{N}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200D\uFE0F]/u.test(c)).length;
  if (/(.)\1{59,}/su.test(t) || (chars.length >= 12 && (chars.length - content) / chars.length > 0.6)) out.push("gibberish");
  return out;
}
/** Refused when two or more signals combine (the server adds "duplicate" for the same message twice in a day). */
export function isSpam(text, extra = []) {
  return spamSignals(text).length + extra.length >= 2;
}
/** The preview's line when a message would be refused, or "". */
export function spamReason(text) {
  return isSpam(text) ? "This looks like spam, so it won't be sent." : "";
}

/* ---- prompt injection: labelled, never blocked (a report about injection is legitimate) ---- */
const INJECTION = [
  // Whitespace runs are bounded ({1,20}), a line start never spans newlines, and a long base64 run is
  // matched once, from its start: every pattern stays linear on long logs.
  /\b(?:ignore|disregard|forget|override)\s{1,20}(?:(?:all|any|the|your)\s{1,20})?(?:(?:previous|prior|above|earlier|preceding|system)\s{0,20})?(?:instructions?|prompts?|rules|directions)\b/i,
  /\bsystem\s{1,20}prompt\b/i, /\byou\s{1,20}are\s{1,20}now\b/i, /\bas\s{1,20}an\s{1,20}ai\b/i, /\bnew\s{1,20}instructions\b/i, /\b(?:developer|god|dan)\s{1,20}mode\b/i, /\bjailbreak/i,
  /<\|[^|>\n]{1,40}\|>/, /^[ \t]{0,20}(?:assistant|system|user|human|developer)[ \t]{0,20}:/im, /\[\/?(?:INST|SYS)\]/,
  /\b(?:run|execute)\s{1,20}(?:this|the\s{1,20}following|these)\s{1,20}(?:command|commands|script|code)\b/i,
  /\b(?:curl|wget)\b[^\n|]{0,500}\|[ \t]{0,20}(?:sudo\s{1,20})?(?:ba|z|da)?sh\b/i,
  /"(?:tool_use|function_call|tool_calls|tool_name)"\s{0,20}:/i, /"name"\s{0,20}:\s{0,20}"[^"]{1,60}"\s{0,20},\s{0,20}"(?:input|arguments|parameters)"\s{0,20}:/i,
  /<\/?(?:function_calls|invoke|tool_use|system)\b/i,
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200}/,
];
/** True when the text looks like an attempt to instruct an AI that reads it. */
export function looksLikeInjection(text) {
  const t = stripHidden(text).text;
  return INJECTION.some((re) => re.test(t));
}

/* ---- links, emails and mentions out of anything shown in a title or a reply ---- */
/** URLs out of a title: they become "[link]". */
export const dropLinks = (s) => String(s ?? "").replace(/(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/|\bwww\.)[^\s]*/gi, "[link]");
/** An owner's reply as the sender sees it: no email address, no @mention, no github.com profile link. */
export function cleanReply(s) {
  return stripHidden(s).text
    .replace(EMAIL, "[email]")
    .replace(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+(?:\/[^\s)]*)?/gi, "[link]")
    .replace(/(^|[^\w`])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\b/g, "$1[someone]");
}
