import type { TocItem } from "@/lib/markdown";

function TocList({ items }: { items: readonly TocItem[] }) {
  return (
    <ol>
      {items.map((item) => (
        <li key={item.id} className={item.depth === 3 ? "toc-sub" : undefined}>
          <a href={`#${item.id}`}>{item.text}</a>
        </li>
      ))}
    </ol>
  );
}

export function Toc({ items }: { items: readonly TocItem[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <nav className="toc toc-wide" aria-label="On this page">
        <p>On this page</p>
        <TocList items={items} />
      </nav>
      <details className="toc toc-narrow">
        <summary>On this page</summary>
        <nav aria-label="On this page">
          <TocList items={items} />
        </nav>
      </details>
    </>
  );
}
