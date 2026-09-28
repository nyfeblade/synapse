import type { Rng } from "./rng";

// Filler vocabulary. Planted subjects come from `coinName` instead, so a planted key can never
// collide with chatter, and a negative question's subject can be proven absent.
export const PEOPLE = ["Dana Ruiz", "Priya Shah", "Marcus Lee", "Elena Novak", "Tom Becker", "Aisha Karim", "Leo Martins", "Grace Okafor", "Sam Whitfield", "Nora Lindqvist", "Omar Haddad", "Julia Brandt", "Ken Sato", "Maya Chen", "Rafael Ortiz", "Ingrid Holm"];
export const FILLER_ORGS = ["Northwind", "Bluefin", "Cedarline", "Harborview", "Ironbark", "Lakeshore", "Maplewood", "Oakridge", "Pinecrest", "Redstone", "Silverleaf", "Stonebridge", "Westbrook", "Brightpath", "Clearwater", "Foxglove", "Greenfield", "Highgate", "Kingsley", "Riverside"];
export const TOPICS = ["the Q3 roadmap", "the hiring plan", "the pricing page", "the board deck", "the vendor review", "the launch email", "the offsite agenda", "the budget sheet", "the onboarding doc", "the churn analysis", "the partner contract", "the support backlog", "the design review", "the tax filing", "the newsletter", "the renewal list", "the podcast pitch", "the office move"];
export const DAYS = ["tomorrow", "on Monday", "on Tuesday", "on Wednesday", "on Thursday", "on Friday", "next week", "this afternoon"];
export const CITIES = ["Lisbon", "Osaka", "Denver", "Tallinn", "Montreal", "Cape Town", "Porto", "Kyoto", "Austin", "Reykjavik", "Seville", "Vilnius", "Hobart", "Ghent", "Bergen", "Oaxaca"];
export const PREFS = ["short answers before 10am", "bullet points over prose", "drafts in plain text", "calls after lunch", "no meetings on Fridays", "metric units", "British spelling in client email", "a weekly summary on Sundays", "the 24-hour clock", "PDFs over slide decks", "one reminder, not three", "window seats", "decaf after 3pm", "Slack over email for quick things"];
export const REPOS = ["web-app", "billing-svc", "infra", "data-pipeline", "mobile", "docs-site"];
export const TOOLS = ["CSV export", "calendar sync", "invoice PDF render", "Drive upload", "email search", "spreadsheet import"];

export type ValueKind = "money" | "bigmoney" | "date" | "person" | "count" | "code" | "city" | "org" | "aside";
export const ATTRS: Record<string, ValueKind> = {
  retainer: "money", budget: "money", deposit: "money", "late fee": "money", "invoice total": "money",
  "kickoff date": "date", "renewal date": "date", deadline: "date",
  "account owner": "person", "point of contact": "person",
  headcount: "count", "seat count": "count",
  "ticket number": "code", "room booking": "code",
};
export const SUPERSEDE_ATTRS = ["budget", "retainer", "headcount", "kickoff date", "account owner", "seat count"];
export const BURIED_ATTRS = ["retainer", "deposit", "late fee", "renewal date", "point of contact", "ticket number", "room booking", "account owner"];
export const MULTI_ATTRS: Record<string, ValueKind> = { "offsite city": "city", supplier: "org", "new hire": "person" };
export const ASIDE_ATTRS: Record<string, readonly string[]> = {
  "wifi network": ["ORCHARD-5G", "LANTERN-2G", "HARBOR-GUEST", "KESTREL-5G"],
  "parking spot": ["P2-117", "B1-042", "P3-309", "L1-015"],
  "coffee order": ["an oat flat white", "a cortado", "a double espresso", "an iced americano"],
  "favourite bakery": ["Crumb and Co", "Rise Bakehouse", "the Flour Room", "Petit Four"],
  "delivery window": ["8 to 10am", "noon to 2pm", "after 6pm", "before 9am"],
};
export const DOC_KINDS = ["master services agreement", "lease", "board minutes", "research notes", "codebase README", "partnership contract", "meeting minutes", "policy handbook"];
export const DOC_ATTRS: Record<string, string> = { "indemnity cap": "bigmoney", "termination notice period": "days", "liability ceiling": "bigmoney", "renewal term": "months" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SYL_A = ["ka", "ve", "to", "mi", "ra", "lu", "sa", "de", "no", "zi", "fe", "qu", "ba", "yo", "ge", "ha"];
const SYL_B = ["lor", "var", "zen", "tis", "mund", "rik", "dal", "vex", "ton", "pel", "gar", "nix", "sor", "bry", "lek", "worth"];

/** A made-up proper name (e.g. "Kavorzen"), unique within `used`. */
export function coinName(r: Rng, used: Set<string>): string {
  for (;;) {
    const n = r.pick(SYL_A) + r.pick(SYL_A) + r.pick(SYL_B);
    const name = n[0]!.toUpperCase() + n.slice(1);
    if (!used.has(name)) { used.add(name); return name; }
  }
}

/** 1234567 -> "1,234,567", without ICU (locale data must not change the corpus). */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function valueOf(r: Rng, kind: ValueKind | string): string {
  switch (kind) {
    case "money": return `$${grouped(r.int(3, 95) * 500)}${r.chance(0.5) ? " a month" : ""}`;
    case "bigmoney": return `$${grouped(r.int(1, 40) * 250_000)}`;
    case "date": return `${r.int(1, 28)} ${r.pick(MONTHS)}`;
    case "person": return r.pick(PEOPLE);
    case "count": return `${r.int(3, 60)} people`;
    case "code": return `${r.pick(["PRJ", "OPS", "FIN", "RM"])}-${r.int(100, 9999)}`;
    case "city": return r.pick(CITIES);
    case "org": return r.pick(FILLER_ORGS);
    case "days": return `${r.pick([30, 45, 60, 90, 120])} days`;
    case "months": return `${r.pick([12, 24, 36])} months`;
    default: return r.pick(ASIDE_ATTRS[kind] ?? ["unknown"]);
  }
}
