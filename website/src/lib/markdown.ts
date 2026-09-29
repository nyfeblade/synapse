import type { Element, ElementContent, Root } from "hast";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Parent } from "unist";

export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface RenderedMarkdown {
  title: string;
  html: string;
  toc: TocItem[];
}

const LINK_MAP: Record<string, string> = {
  "docs/api-key-auth.md": "/docs/api-key",
  "docs/google-setup.md": "/docs/google",
  "docs/phone-access.md": "/docs/phone",
  "docs/portable-install.md": "/docs/portable-install",
  "SECURITY.md": "/privacy",
  "LICENSE": "https://github.com/nyfeblade/synapse/blob/main/LICENSE",
  "../../releases": "https://github.com/nyfeblade/synapse/releases",
  "app/build/THIRD-PARTY-NOTICES.txt":
    "https://github.com/nyfeblade/synapse/blob/main/app/build/THIRD-PARTY-NOTICES.txt",
};

export function rewriteHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const hashAt = href.indexOf("#");
  const pathPart = (hashAt === -1 ? href : href.slice(0, hashAt)).replace(/^\.\//, "");
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const mapped = LINK_MAP[pathPart];
  if (!mapped) return href;
  return `${mapped}${hash}`;
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function annotate(result: { title: string; toc: TocItem[] }) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index: number | undefined, parent: Parent | undefined) => {
      if (node.tagName === "a" && typeof node.properties.href === "string") {
        node.properties.href = rewriteHref(node.properties.href);
      }
      if (!parent || typeof index !== "number") return;
      if (node.tagName === "h1" && !result.title) {
        result.title = textOf(node).replace(/\s+/g, " ").trim();
        parent.children.splice(index, 1);
        return index;
      }
      if ((node.tagName === "h2" || node.tagName === "h3") && typeof node.properties.id === "string") {
        const text = textOf(node).replace(/\s+/g, " ").trim();
        if (text) {
          result.toc.push({ id: node.properties.id, text, depth: node.tagName === "h2" ? 2 : 3 });
        }
      }
      if (node.tagName === "table") {
        const wrap: Element = {
          type: "element",
          tagName: "div",
          properties: { className: ["table-wrap"] },
          children: [node],
        };
        parent.children[index] = wrap;
      }
      return undefined;
    });
  };
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const result: { title: string; toc: TocItem[] } = { title: "", toc: [] };
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(annotate, result)
    .use(rehypeStringify)
    .processSync(markdown);
  return {
    title: result.title || "Documentation",
    html: String(file),
    toc: result.toc,
  };
}

