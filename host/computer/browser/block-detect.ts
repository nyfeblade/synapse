/** BRW-07 families, checked in order. Each is logged, and the parent Bot is told to ask for help. */
export const BLOCK_FAMILIES: [string, (p: { url: string; title: string; html: string }) => boolean][] = [
  ["google-sorry", (p) => /^https?:\/\/(www\.)?google\.[^/]+\/sorry\//.test(p.url)],
  ["linkedin-checkpoint", (p) => /linkedin\.com\/checkpoint\//.test(p.url)],
  ["cloudflare", (p) => /^just a moment/i.test(p.title) || /cf-chl-|challenges\.cloudflare\.com|cf_chl_opt/.test(p.html)],
  ["recaptcha", (p) => /google\.com\/recaptcha\/|g-recaptcha/.test(p.html)],
  ["hcaptcha", (p) => /hcaptcha\.com/.test(p.html)],
  ["arkose", (p) => /arkoselabs\.com|funcaptcha/i.test(p.html)],
  ["datadome", (p) => /captcha-delivery\.com|datadome/i.test(p.html)],
  ["perimeterx", (p) => /px-captcha|perimeterx|Press &amp; Hold|Press & Hold/i.test(p.html)],
  ["imperva", (p) => /Incapsula incident|_Incapsula_Resource/i.test(p.html)],
  ["distil", (p) => /distil_r_captcha|distilnetworks/i.test(p.html)],
  ["aws-waf", (p) => /awswaf|aws-waf-token/i.test(p.html)],
  ["vercel-checkpoint", (p) => /Vercel Security Checkpoint/i.test(p.title) || /vercel-challenge/i.test(p.html)],
  ["access-denied", (p) => /^(access denied|403 forbidden|forbidden)$/i.test(p.title.trim()) || /You don't have permission to access/i.test(p.html)],
];

export function detectBlock(p: { url: string; title: string; html: string }): string | null {
  for (const [family, test] of BLOCK_FAMILIES) if (test(p)) return family;
  return null;
}

export function blockLine(family: string): string {
  return `BLOCKED_BY_SITE: ${family}`;
}
