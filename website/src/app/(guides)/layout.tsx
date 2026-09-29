import type { ReactNode } from "react";
import { DocsNav } from "@/components/DocsNav";

export default function GuidesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="wrap docs-shell">
      <DocsNav />
      {children}
    </div>
  );
}
