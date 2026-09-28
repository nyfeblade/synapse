/**
 * mac-browser safety, decided on the Mac against the live element (never the Bot's say-so).
 *
 * Consequential: submitting, sending, posting, buying, deleting or changing account settings. Such an action always
 * needs the user's OK (a card) unless the user set an explicit always-allow rule for that site.
 * Sensitive: a password or payment-card field. The Bot types into one only when the user gave that exact value in
 * the same turn; nothing typed is ever stored or logged by the app.
 */
import { CARD_HINT_SOURCE } from "./page-agent";

/** What the page agent reports about one element, at action time. */
export interface ElementFacts {
  tag: string;
  role: string;
  /** Accessible name / visible text. */
  name: string;
  /** input type (lower case), "" otherwise. */
  type: string;
  inForm: boolean;
  formMethod: string;
  formAction: string;
  /** A control that submits its form when clicked (submit button, input[type=submit|image], a default button). */
  isSubmit: boolean;
  /** The form looks like a search (role=search, a search input, or a q/query/search field). */
  searchForm: boolean;
  autocomplete: string;
  /** name/id/label/placeholder/aria-label, joined, for the field guard. */
  fieldHint: string;
}

const STRONG = /\b(pay|pay now|buy|buy now|purchase|place (?:your )?order|order now|complete (?:order|purchase)|check ?out|send|post|publish|tweet|submit|delete|remove|erase|destroy|confirm|transfer|withdraw|donate|subscribe|unsubscribe|book now|reserve|sign up|create account|deactivate|close account|cancel (?:my )?(?:subscription|order|membership|account|plan)|save changes)\b/i;
const PAYMENT_HOST = /(^|\.)(stripe\.com|paypal\.com|braintreegateway\.com|adyen\.com|checkout\.com|squareup\.com|square\.link|klarna\.com|affirm\.com|authorize\.net|payments\.amazon\.com|pay\.google\.com|shopify\.com\/checkouts?)$/i;
const PAYMENT_PATH = /\/(checkout|payment|payments|pay|billing|purchase)(\/|$|\?)/i;
const ACCOUNT_PATH = /\/(settings|account|security|billing|profile|preferences)(\/|$|\?)/i;

const host = (u: string): string => { try { return new URL(u).hostname; } catch { return ""; } };
const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ""; } };
const payment = (u: string) => !!u && (PAYMENT_HOST.test(host(u)) || PAYMENT_PATH.test(pathOf(u)));

/**
 * Null when the action is ordinary; otherwise the card's words for it ("Click “Pay now”").
 * `click` covers check/select too when the control submits; `type` with submit and `press` Enter submit the field's form.
 */
export function consequentialAction(action: string, f: ElementFacts, pageUrl: string, o: { submit?: boolean; key?: string } = {}): string | null {
  const label = f.name.trim().replace(/\s+/g, " ").slice(0, 80);
  const submits = action === "click" ? f.isSubmit : (action === "type" && o.submit) || (action === "press" && /^(enter|return)$/i.test(o.key ?? ""));
  const clicks = action === "click" || action === "download";
  // Words decide only for things you press (a checkbox "Send me the newsletter" sends nothing by itself).
  const pressable = f.isSubmit || ["button", "link", "menuitem", "tab"].includes(f.role);
  if (clicks && pressable && STRONG.test(label)) return `Click “${label}”`;
  if (submits && f.inForm) {
    const what = action === "click" ? `Click “${label || "Submit"}”` : "Submit the form";
    if (f.formMethod.toLowerCase() === "post" && !f.searchForm) return what;
    if (payment(f.formAction) || payment(pageUrl)) return what;
    if (ACCOUNT_PATH.test(pathOf(pageUrl)) && !f.searchForm) return what;
  }
  if (clicks && (payment(f.formAction) && f.isSubmit)) return `Click “${label || "Submit"}”`;
  if (clicks && ACCOUNT_PATH.test(pathOf(pageUrl)) && /\b(save|update|apply changes)\b/i.test(label) && f.role === "button") return `Click “${label}”`;
  return null;
}

const CARD_HINT = new RegExp(CARD_HINT_SOURCE, "i"); // one list, shared with the page agent

/** "password" / "card" for a field the Bot must not type into on its own; null otherwise. */
export function sensitiveField(f: Pick<ElementFacts, "type" | "autocomplete" | "fieldHint">): "password" | "card" | null {
  const ac = f.autocomplete.toLowerCase();
  if (f.type === "password" || /\b(current|new)-password\b/.test(ac)) return "password";
  if (/\bcc-(number|csc|exp|exp-month|exp-year|type)\b/.test(ac)) return "card";
  if (CARD_HINT.test(f.fieldHint)) return "card";
  return null;
}

export const siteOf = (u: string): string => host(u) || u;
