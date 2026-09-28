import http from "node:http";

/**
 * mac-browser bench fixtures: a small local site with the chrome a real one has (a 14-link header, a sidebar, a
 * 20-link footer) and three tasks:
 *   1. search and read a result  (/ → /search?q= → /article/3, answer in the article body)
 *   2. fill and submit a multi-field form (/signup, POST → /thanks)
 *   3. a 3-page flow (/flow/1 → /flow/2 → /flow/3 → /flow/done)
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const NAV = ["Home", "News", "Sport", "Weather", "Travel", "Culture", "Science", "Tech", "Money", "Health", "Food", "Video", "Audio", "Help"];
const FOOT = Array.from({ length: 20 }, (_, i) => ["Terms", "Privacy", "Cookies", "Accessibility", "Contact", "Careers", "Advertise", "Press", "About", "Status"][i % 10] + (i >= 10 ? " (EU)" : ""));
const LIPSUM = "The river valley towns grew around the old salt road, and each market day brought traders from the hills with wool, cheese and news of the passes.";

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px/1.5 -apple-system,sans-serif;margin:0} header,footer{background:#f3f3f3;padding:8px 16px} header a,footer a{margin-right:10px}
main{display:flex;gap:24px;padding:16px} article{flex:1;max-width:720px} aside{width:220px;font-size:13px} label{display:block;margin:8px 0 2px}</style></head>
<body><header><nav aria-label="Main">${NAV.map((n) => `<a href="/${n.toLowerCase()}">${n}</a>`).join("")}</nav>
<form role="search" action="/search" style="display:inline"><input type="search" name="q" aria-label="Search the site"><button>Search</button></form></header>
<main><article>${body}</article><aside><h2>Most read</h2><ol>${Array.from({ length: 8 }, (_, i) => `<li><a href="/article/${i + 10}">Most read story number ${i + 1} about the valley</a></li>`).join("")}</ol>
<h2>Newsletter</h2><p>Get the morning briefing in your inbox.</p></aside></main>
<footer><nav aria-label="Footer">${FOOT.map((n) => `<a href="/p/${encodeURIComponent(n)}">${n}</a>`).join("")}</nav><p>© Valley Post. All rights reserved.</p></footer></body></html>`;
}

const RESULTS = [
  "Salt road history: how the passes shaped trade", "Veltria's capital explained", "Ten walks along the old salt road",
  "Market day recipes from the hill towns", "Why the river valley floods every spring", "Wool prices and the winter fairs",
  "A guide to the valley's museums", "The bridge that took forty years", "Cheese caves of the northern hills", "Rail returns to the valley",
];

function page(url: URL, body: Record<string, string>): { status: number; html: string; location?: string } {
  const p = url.pathname;
  if (p === "/") return { status: 200, html: shell("Valley Post", `<h1>Valley Post</h1><p>${LIPSUM}</p><p>Use the search box to find stories.</p>`) };
  if (p === "/search") {
    const q = url.searchParams.get("q") ?? "";
    return { status: 200, html: shell(`Search: ${q}`, `<h1>Results for “${esc(q)}”</h1><ol>${RESULTS.map((r, i) => `<li><h3><a href="/article/${i + 1}">${esc(r)}</a></h3><p>${LIPSUM.slice(0, 90 + i * 3)}…</p></li>`).join("")}</ol>`) };
  }
  if (p.startsWith("/article/")) {
    const n = Number(p.slice(9));
    const answer = n === 2 ? "<p><strong>The capital of Veltria is Orsk</strong>, a city of 212,000 people on the eastern bank.</p>" : "";
    const paras = Array.from({ length: 12 }, (_, i) => `<p>${LIPSUM} (${i + 1})</p>`);
    paras.splice(7, 0, answer);
    return { status: 200, html: shell(RESULTS[n - 1] ?? `Story ${n}`, `<h1>${esc(RESULTS[n - 1] ?? `Story ${n}`)}</h1><p><em>By the Valley Post desk</em></p>${paras.join("")}`) };
  }
  if (p === "/signup") {
    return { status: 200, html: shell("Sign up", `<h1>Create your account</h1><form method="post" action="/signup">
      <label for="name">Full name</label><input id="name" name="name" autocomplete="name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="country">Country</label><select id="country" name="country"><option>Choose…</option><option>United Kingdom</option><option>Ireland</option><option>France</option></select>
      <fieldset><legend>Plan</legend><label><input type="radio" name="plan" value="free" checked> Free</label><label><input type="radio" name="plan" value="pro"> Pro</label></fieldset>
      <label><input type="checkbox" name="news"> Send me the newsletter</label>
      <label for="about">About you</label><textarea id="about" name="about"></textarea>
      <button type="submit">Create account</button></form>`) };
  }
  if (p === "/thanks") return { status: 200, html: shell("Welcome", `<h1>Welcome, ${esc(body.name ?? "")}</h1><p role="status">Account created for ${esc(body.email ?? "")} (${esc(body.country ?? "")}, ${esc(body.plan ?? "")}${body.news ? ", newsletter" : ""}).</p>`) };
  if (p === "/flow/1") return { status: 200, html: shell("Book a table — step 1 of 3", `<h1>Step 1 of 3: party</h1><form method="get" action="/flow/2"><label for="size">Party size</label><select id="size" name="size"><option>1</option><option>2</option><option>4</option><option>6</option></select><button>Next</button></form>`) };
  if (p === "/flow/2") return { status: 200, html: shell("Book a table — step 2 of 3", `<h1>Step 2 of 3: time</h1><p>Party of ${esc(url.searchParams.get("size") ?? "?")}.</p><form method="get" action="/flow/3"><input type="hidden" name="size" value="${esc(url.searchParams.get("size") ?? "")}"><label for="when">Time</label><input id="when" name="when" placeholder="e.g. 19:30"><button>Next</button></form>`) };
  if (p === "/flow/3") return { status: 200, html: shell("Book a table — step 3 of 3", `<h1>Step 3 of 3: review</h1><p>Table for ${esc(url.searchParams.get("size") ?? "?")} at ${esc(url.searchParams.get("when") ?? "?")}.</p><form method="post" action="/flow/done"><button>Confirm booking</button></form>`) };
  if (p === "/flow/done") return { status: 200, html: shell("Booked", `<h1>Booked</h1><p role="status">Your table is booked. Reference VP-2231.</p>`) };
  return { status: 404, html: shell("Not found", "<h1>Not found</h1>") };
}

export async function serveFixtures(): Promise<{ base: string; posts: Record<string, string>[]; close(): Promise<void> }> {
  const posts: Record<string, string>[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = Object.fromEntries(new URLSearchParams(raw));
      if (req.method === "POST") {
        posts.push({ path: url.pathname, ...body });
        const to = url.pathname === "/signup" ? "/thanks" : url.pathname;
        if (to === "/thanks") { const r = page(new URL("http://x/thanks"), body); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(r.html); return; }
      }
      const r = page(url, body);
      res.writeHead(r.status, { "content-type": "text/html; charset=utf-8" });
      res.end(r.html);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, posts, close: () => new Promise((r) => server.close(() => r())) };
}
