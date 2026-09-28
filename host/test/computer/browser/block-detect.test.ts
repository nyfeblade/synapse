import { describe, expect, it } from "vitest";
import { blockLine, detectBlock } from "../../../computer/browser/block-detect";

describe("detectBlock (BRW-07)", () => {
  it.each([
    [{ url: "https://www.google.com/sorry/index?continue=x", title: "", html: "" }, "google-sorry"],
    [{ url: "https://x.com", title: "Just a moment...", html: "<div id='cf-chl-widget'>" }, "cloudflare"],
    [{ url: "https://x.com", title: "", html: "<iframe src='https://www.google.com/recaptcha/api2/anchor'>" }, "recaptcha"],
    [{ url: "https://x.com", title: "", html: "<iframe src='https://newassets.hcaptcha.com/captcha'>" }, "hcaptcha"],
    [{ url: "https://x.com", title: "", html: "client-api.arkoselabs.com" }, "arkose"],
    [{ url: "https://www.linkedin.com/checkpoint/challenge/x", title: "", html: "" }, "linkedin-checkpoint"],
    [{ url: "https://x.com", title: "", html: "geo.captcha-delivery.com" }, "datadome"],
    [{ url: "https://x.com", title: "", html: "<div id='px-captcha'>" }, "perimeterx"],
    [{ url: "https://x.com", title: "", html: "Incapsula incident ID" }, "imperva"],
    [{ url: "https://x.com", title: "", html: "distil_r_captcha" }, "distil"],
    [{ url: "https://x.com", title: "", html: "awswaf-captcha" }, "aws-waf"],
    [{ url: "https://x.com", title: "Vercel Security Checkpoint", html: "" }, "vercel-checkpoint"],
    [{ url: "https://x.com", title: "Access Denied", html: "You don't have permission to access" }, "access-denied"],
  ])("%o → %s", (p, fam) => {
    expect(detectBlock(p)).toBe(fam);
  });
  it("returns null for an ordinary page and formats the result line", () => {
    expect(detectBlock({ url: "https://example.com", title: "Example Domain", html: "<h1>Example</h1>" })).toBeNull();
    expect(blockLine("cloudflare")).toBe("BLOCKED_BY_SITE: cloudflare");
  });
});
