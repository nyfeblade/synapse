// Every page: the header gains its rule once the page scrolls, the theme button switches light and dark
// (remembered), the docs sidebar marks the section in view, and looping vignettes run only on screen.
(() => {
  const h = document.querySelector(".site-header");
  const onScroll = () => h && h.classList.toggle("scrolled", scrollY > 4);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  const root = document.documentElement;
  const dark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  // The button says what it will do: "Switch to dark theme" while light, and back.
  const buttons = document.querySelectorAll(".theme");
  const label = () => buttons.forEach((b) => b.setAttribute("aria-label", `Switch to ${dark() ? "light" : "dark"} theme`));
  buttons.forEach((b) => b.addEventListener("click", () => {
    const next = dark() ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("synapse-theme", next); } catch { /* private window: this visit only */ }
    label();
  }));
  label();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", label);

  if (!("IntersectionObserver" in window)) { document.querySelectorAll("[data-anim]").forEach((el) => el.classList.add("on")); return; }
  const anim = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle("on", e.isIntersecting)));
  document.querySelectorAll("[data-anim]").forEach((el) => anim.observe(el));

  const links = [...document.querySelectorAll(".toc a[href^='#']")];
  if (!links.length) return;
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new Set();
  const io = new IntersectionObserver((es) => {
    for (const e of es) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
    const first = [...byId.keys()].find((id) => seen.has(id));
    if (first) links.forEach((a) => a.classList.toggle("active", a === byId.get(first)));
  }, { rootMargin: "-80px 0px -65% 0px" });
  byId.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
})();
