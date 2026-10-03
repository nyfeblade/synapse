import type { ReactNode } from "react";
import type { TocItem } from "@/lib/markdown";
import { Toc } from "./Toc";

export function Guide({
  title,
  toc,
  note,
  children,
}: {
  title: string;
  toc: readonly TocItem[];
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="doc">
      <div className="doc-body">
        <h1>{title}</h1>
        {note}
        <div className="prose">{children}</div>
      </div>
      <Toc items={toc} />
    </article>
  );
}
