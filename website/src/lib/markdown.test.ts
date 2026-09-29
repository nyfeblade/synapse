import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKDOWN_DOCS, loadMarkdownDoc } from "./docs";
import { renderMarkdown, rewriteHref } from "./markdown";

describe("markdown", () => {
  it("rewrites repository links onto the site", () => {
    expect(rewriteHref("docs/api-key-auth.md")).toBe("/docs/api-key");
    expect(rewriteHref("SECURITY.md")).toBe("/privacy");
    expect(rewriteHref("https://orbstack.dev")).toBe("https://orbstack.dev");
    expect(rewriteHref("#requirements")).toBe("#requirements");
  });

  it("builds a table of contents and drops raw html", () => {
    const rendered = renderMarkdown(`# Title

## Install

See [the key](docs/api-key-auth.md).

### First open

<script>alert(1)</script>

| Code | Shown |
| --- | --- |
| 401 | key rejected |
`);
    expect(rendered.title).toBe("Title");
    expect(rendered.html).not.toContain("<h1");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).toContain('href="/docs/api-key"');
    expect(rendered.html).toContain('class="table-wrap"');
    expect(rendered.toc.map((item) => item.text)).toEqual(["Install", "First open"]);
  });

  it("renders each repository doc the site publishes", () => {
    for (const doc of MARKDOWN_DOCS) {
      expect(fs.existsSync(path.join(process.cwd(), "..", doc.file)), doc.file).toBe(true);
      const loaded = loadMarkdownDoc(doc.slug);
      expect(loaded.title.length).toBeGreaterThan(0);
      expect(loaded.html).toContain("<");
      expect(loaded.html).not.toContain("<script");
    }
    expect(loadMarkdownDoc("api-key").html).toContain("Anthropic API key");
    expect(loadMarkdownDoc("google").html).toContain("gmail.readonly");
    expect(loadMarkdownDoc("phone").html).toContain("Tailscale");
    expect(loadMarkdownDoc("portable-install").html).toMatch(/Open Anyway|Gatekeeper/);
  });
});
