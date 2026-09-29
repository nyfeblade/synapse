// Download links and the version label follow the newest release on GitHub, so a new release needs no
// site change. Pre-releases count (the beta is one); drafts don't. Without an answer (offline, rate
// limit), every link keeps its fallback: the Releases page, and the star and download counts stay hidden.
// Social proof only once it means something: small numbers read as weak, so they stay hidden until then.
const MIN_DOWNLOADS = 250, MIN_STARS = 50;
(() => {
  const API = "https://api.github.com/repos/nyfeblade/synapse";
  const get = (u) => fetch(u, { headers: { Accept: "application/vnd.github+json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : n.toLocaleString("en-US"));
  const show = (key, n) => document.querySelectorAll(`[data-stat="${key}"]`).forEach((el) => { el.querySelector("b").textContent = fmt(n); el.hidden = false; });

  get(`${API}/releases?per_page=100`).then((list) => {
    const rels = (Array.isArray(list) ? list : []).filter((x) => !x.draft);
    const dmgs = (x) => (x.assets || []).filter((a) => /\.dmg$/.test(a.name));
    const total = rels.reduce((n, x) => n + dmgs(x).reduce((m, a) => m + (a.download_count || 0), 0), 0);
    if (total >= MIN_DOWNLOADS) show("downloads", total);
    const rel = rels.find((x) => dmgs(x).length);
    if (!rel) return;
    document.querySelectorAll("[data-dl]").forEach((a) => { a.href = dmgs(rel)[0].browser_download_url; });
    const v = rel.tag_name.replace(/^v/, "");
    document.querySelectorAll("[data-version]").forEach((el) => { el.textContent = `v${v}${rel.prerelease ? " beta" : ""}`; });
  });

  if (!document.querySelector("[data-stat='stars'],[data-stars]")) return;
  get(API).then((repo) => {
    const n = repo && repo.stargazers_count;
    if (typeof n !== "number" || n < MIN_STARS) return;
    show("stars", n);
    document.querySelectorAll("[data-stars]").forEach((el) => { el.textContent = fmt(n); el.hidden = false; });
  });
})();
