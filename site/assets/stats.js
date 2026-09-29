// /stats: public GitHub download counts per release (an unlisted, noindex page). A file, not inline, for the CSP.
(() => {
  const fmt = (n) => n.toLocaleString("en-US");
  const sum = (assets, re) => assets.filter((a) => re.test(a.name)).reduce((n, a) => n + (a.download_count || 0), 0);
  fetch("https://api.github.com/repos/nyfeblade/synapse/releases?per_page=100", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rels) => {
      let ti = 0, tu = 0;
      const rows = rels.filter((r) => !r.draft).map((r) => {
        const i = sum(r.assets, /\.dmg$/), u = sum(r.assets, /\.zip$/);
        ti += i; tu += u;
        const tr = document.createElement("tr");
        for (const [v, cls] of [[r.tag_name, ""], [(r.published_at || "").slice(0, 10), ""], [fmt(i), "n"], [fmt(u), "n"]]) {
          const td = document.createElement("td"); td.textContent = v; if (cls) td.className = cls; tr.append(td);
        }
        return tr;
      });
      document.getElementById("rows").replaceChildren(...rows);
      document.getElementById("t-installs").textContent = fmt(ti);
      document.getElementById("t-updates").textContent = fmt(tu);
      document.getElementById("t-all").textContent = fmt(ti + tu);
    })
    .catch(() => {
      const tr = document.createElement("tr"), td = document.createElement("td");
      td.colSpan = 4; td.textContent = "GitHub didn't answer. Try again in a minute.";
      tr.append(td); document.getElementById("rows").replaceChildren(tr);
    });
})();
