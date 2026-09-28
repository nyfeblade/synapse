import { describe, expect, it } from "vitest";
import { assertLogoUrl, fetchLogoDataUrl } from "../../src/main/native/logo";

describe("marketplace logo fetch (CSP-safe data URLs)", () => {
  it("refuses anything that is not https", () => {
    expect(() => assertLogoUrl("http://evil.test/x.png")).toThrow(/Bad logo URL/);
    expect(() => assertLogoUrl("/local.png")).toThrow(/Bad logo URL/);
    expect(assertLogoUrl("https://github.githubassets.com/favicons/favicon.svg")).toMatch(/^https:/);
  });

  it("returns a data URL the renderer CSP already allows", async () => {
    const src = await fetchLogoDataUrl("https://example.test/icon.png", async () => new Response(Buffer.from("png"), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    expect(src).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
  });
});
