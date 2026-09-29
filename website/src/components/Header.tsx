import { SITE } from "@/lib/site";
import { NavLink } from "./NavLink";

export function Header() {
  return (
    <header className="site-header">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="wrap header-bar">
        <NavLink href="/" className="brand">
          <img src="/media/icon.svg" alt="" width={28} height={28} />
          <span>Synapse</span>
        </NavLink>
        <nav aria-label="Site">
          <NavLink href="/docs">Docs</NavLink>
          <NavLink href="/privacy">Privacy</NavLink>
          <a href={SITE.repo}>GitHub</a>
          <NavLink href="/download" className="button button-small">
            Download
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
