import { DOC_NAV } from "@/lib/nav";
import { NavLink } from "./NavLink";

export function DocsNav() {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      <ul>
        {DOC_NAV.map((item) => (
          <li key={item.href}>
            <NavLink href={item.href}>{item.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
