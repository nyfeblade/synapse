// Download links and the version label follow the newest release on GitHub, so a new release needs no
// site change. Pre-releases count (the beta is one); drafts don't. Without an answer (offline, rate
// limit), every link keeps its fallback: the Releases page.
(() => {
  const links = document.querySelectorAll("[data-dl]"), labels = document.querySelectorAll("[data-version]");
  if (!links.length && !labels.length) return;
  fetch("https://api.github.com/repos/nyfeblade/synapse/releases?per_page=10", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => {
      const rel = (Array.isArray(list) ? list : []).find((x) => !x.draft && (x.assets || []).some((a) => /\.dmg$/.test(a.name)));
      if (!rel) return;
      const dmg = rel.assets.find((a) => /\.dmg$/.test(a.name));
      links.forEach((a) => { a.href = dmg.browser_download_url; });
      const v = rel.tag_name.replace(/^v/, "");
      labels.forEach((el) => { el.textContent = `v${v}${rel.prerelease ? " beta" : ""}`; });
    })
    .catch(() => {});
})();
