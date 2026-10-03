import Link from "next/link";
import { SITE } from "@/lib/site";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <p>Synapse is not affiliated with or endorsed by Anthropic.</p>
        <nav aria-label="Site">
          <Link href="/download">Download</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/privacy">Privacy</Link>
          <a href={SITE.license}>MIT licence</a>
          <a href={SITE.securityFile}>Security</a>
          <a href={SITE.repo}>GitHub</a>
          <a href={SITE.releases}>Releases</a>
        </nav>
      </div>
    </footer>
  );
}
