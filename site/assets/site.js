// The header gains its rule once the page scrolls; the docs sidebar marks the section in view.
(() => {
  const h = document.querySelector(".site-header");
  const onScroll = () => h && h.classList.toggle("scrolled", scrollY > 4);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  const links = [...document.querySelectorAll(".toc a[href^='#']")];
  if (!links.length || !("IntersectionObserver" in window)) return;
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new Set();
  const io = new IntersectionObserver((es) => {
    for (const e of es) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
    const first = [...byId.keys()].find((id) => seen.has(id));
    if (first) links.forEach((a) => a.classList.toggle("active", a === byId.get(first)));
  }, { rootMargin: "-80px 0px -65% 0px" });
  byId.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
})();
