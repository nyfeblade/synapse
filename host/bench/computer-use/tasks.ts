/**
 * The computer-use suite (12 tasks), modelled on the lab brief's list (docs/lab/computer-use-brief.md).
 * Everything is synthetic and local: web pages are served by SERVER_JS on 127.0.0.1 on the box and
 * record what the page did to submissions.json; desktop tasks work on files under the bench folder
 * and the box user's own Thunar settings. Success is read ONLY from that system state.
 */

export type Category = "web" | "desktop" | "hard";
export type Difficulty = "easy" | "medium" | "hard";

/** What the checker sees: the local server's records, files under the bench desk folder, Thunar's xfconf xml. */
export interface SystemState {
  /** task id -> records the page posted, in order. */
  submissions: Record<string, Record<string, unknown>[]>;
  /** desk-relative path -> content (null = missing). */
  files: Record<string, string | null>;
  /** ~/.config/xfce4/xfconf/xfce-perchannel-xml/thunar.xml before and after the task. */
  xfconf: { before: string | null; after: string | null };
}
export interface Check { pass: boolean; reason: string }

export interface PromptCtx { base: string; desk: string }

export interface CuTask {
  id: string;
  category: Category;
  difficulty: Difficulty;
  title: string;
  /** Page file under the site root (web and hard tasks). */
  page?: string;
  /** Files created under the desk folder before the run, desk-relative path -> content. */
  files?: Record<string, string>;
  /** Desk-relative files read back after the run. */
  watch?: string[];
  /** Reads Thunar's xfconf before/after. */
  xfconf?: boolean;
  prompt(c: PromptCtx): string;
  check(s: SystemState): Check;
}

const RULES =
  "Do this on your computer screen with your computerUse subagent (mcp__bot__Task, subagent_type computerUse), the way a person would: " +
  "do not use Shell, scripts, curl or the browser tools to do it for you. When it is done, reply with one short line.";

const recs = (s: SystemState, id: string) => s.submissions[id] ?? [];
const ok = (reason: string): Check => ({ pass: true, reason });
const no = (reason: string): Check => ({ pass: false, reason });

export const TASKS: CuTask[] = [
  {
    id: "W1", category: "web", difficulty: "easy", title: "Log in to a local test site", page: "w1-login.html",
    prompt: (c) => `Open ${c.base}/w1-login.html in Chromium and sign in as user "maria.lopez" with password "Tulip-4411". ${RULES}`,
    check: (s) => recs(s, "W1").some((r) => r.user === "maria.lopez" && r.pass === "Tulip-4411") ? ok("server got the right credentials") : no("no sign-in with the right credentials reached the server"),
  },
  {
    id: "W2", category: "web", difficulty: "medium", title: "Fill a 3-page form", page: "w2-form.html",
    prompt: (c) => `Open ${c.base}/w2-form.html and complete the 3-step sign-up: name "Ada Byron", city "Leeds", plan "Team", then tick the confirmation box and submit. ${RULES}`,
    check: (s) => {
      const r = recs(s, "W2").at(-1);
      if (!r) return no("the form was never submitted");
      return r.name === "Ada Byron" && r.city === "Leeds" && r.plan === "Team" && r.confirm === true ? ok("all three pages' values arrived") : no(`wrong values: ${JSON.stringify(r)}`);
    },
  },
  {
    id: "W3", category: "web", difficulty: "medium", title: "Find a value in a table", page: "w3-table.html",
    prompt: (c) => `Open ${c.base}/w3-table.html, find the unit price of SKU K-7731 in the table, type exactly that number into the Answer box on the same page and press Submit. ${RULES}`,
    check: (s) => recs(s, "W3").some((r) => String(r.answer).trim() === "73.15") ? ok("answered 73.15") : no(`answers: ${JSON.stringify(recs(s, "W3").map((r) => r.answer))}`),
  },
  {
    id: "W4", category: "web", difficulty: "medium", title: "Cookie banner, then the real action", page: "w4-cookies.html",
    prompt: (c) => `Open ${c.base}/w4-cookies.html. Decline all non-essential cookies in the banner, then subscribe to the weekly newsletter on that page. ${RULES}`,
    check: (s) => {
      const r = recs(s, "W4");
      const consent = r.find((x) => x.consent !== undefined)?.consent;
      if (consent !== "reject") return no(`cookie choice was ${JSON.stringify(consent ?? null)}, not reject`);
      return r.some((x) => x.subscribed === "weekly") ? ok("rejected cookies and subscribed weekly") : no("never subscribed weekly");
    },
  },
  {
    id: "W5", category: "web", difficulty: "medium", title: "An unexpected modal mid-task", page: "w5-modal.html",
    prompt: (c) => `Open ${c.base}/w5-modal.html and send the contact form with email "ops@example.test" and message "Restock aisle 4". ${RULES}`,
    check: (s) => recs(s, "W5").some((r) => r.email === "ops@example.test" && r.sent === true) ? ok("form sent past the modal") : no("the contact form never arrived"),
  },
  {
    id: "W6", category: "web", difficulty: "hard", title: "A site with no accessibility labels", page: "w6-unlabeled.html",
    prompt: (c) => `Open ${c.base}/w6-unlabeled.html and delete "Invoice 3" using the trash-can icon on its row (only that one). ${RULES}`,
    check: (s) => {
      const d = recs(s, "W6").map((r) => r.deleted);
      return d.length === 1 && d[0] === "Invoice 3" ? ok("deleted only Invoice 3") : no(`deleted: ${JSON.stringify(d)}`);
    },
  },
  {
    id: "D1", category: "desktop", difficulty: "medium", title: "Editor: save under a new name in a given folder",
    files: { "notes.txt": "draft 42\n", "out/.keep": "" }, watch: ["notes.txt", "out/report-final.txt"],
    prompt: (c) => `In the Mousepad text editor, open ${c.desk}/notes.txt, add a new last line "approved", and use Save As to save it as report-final.txt in the folder ${c.desk}/out. ${RULES}`,
    check: (s) => {
      const f = s.files["out/report-final.txt"];
      if (f == null) return no("out/report-final.txt does not exist");
      return /draft 42/.test(f) && /^approved\s*$/m.test(f) ? ok("saved with the new line") : no(`content: ${JSON.stringify(f.slice(0, 80))}`);
    },
  },
  {
    id: "D2", category: "desktop", difficulty: "easy", title: "File manager: rename a file",
    files: { "photos/IMG_0001.jpg": "jpeg-bytes-1", "photos/IMG_0002.jpg": "jpeg-bytes-2" }, watch: ["photos/IMG_0001.jpg", "photos/beach.jpg"],
    prompt: (c) => `In the Thunar file manager, open the folder ${c.desk}/photos and rename IMG_0001.jpg to beach.jpg. ${RULES}`,
    check: (s) => s.files["photos/beach.jpg"] === "jpeg-bytes-1" && s.files["photos/IMG_0001.jpg"] === null ? ok("renamed") : no("photos/beach.jpg with IMG_0001's content is missing, or IMG_0001.jpg still exists"),
  },
  {
    id: "D3", category: "desktop", difficulty: "medium", title: "Change a setting in a preferences dialog", xfconf: true,
    prompt: () => `In the Thunar file manager, open Edit > Preferences and turn on "Single click to activate items" (Behavior tab), then close the dialog. ${RULES}`,
    check: (s) => {
      const on = (x: string | null) => !!x && /name="misc-single-click"[^>]*value="true"/.test(x);
      if (on(s.xfconf.before)) return no("invalid baseline: single-click was already on before the task");
      return on(s.xfconf.after) ? ok("misc-single-click persisted as true") : no("thunar.xml has no misc-single-click=true");
    },
  },
  {
    id: "H1", category: "hard", difficulty: "medium", title: "Canvas-only app: click by colour", page: "h1-canvas.html",
    prompt: (c) => `Open ${c.base}/h1-canvas.html. It is a drawing with coloured squares; click the red square once. ${RULES}`,
    check: (s) => {
      const hits = recs(s, "H1").map((r) => r.hit);
      return hits.length > 0 && hits[0] === "red" ? ok("first click hit red") : no(`clicks: ${JSON.stringify(hits)}`);
    },
  },
  {
    id: "H2", category: "hard", difficulty: "hard", title: "Right-click and nested menu", page: "h2-context.html",
    prompt: (c) => `Open ${c.base}/h2-context.html. Right-click the file "report.pdf" and choose Move to > Archive. ${RULES}`,
    check: (s) => recs(s, "H2").some((r) => r.file === "report.pdf" && r.action === "move" && r.to === "Archive") ? ok("moved via the nested menu") : no(`actions: ${JSON.stringify(recs(s, "H2"))}`),
  },
  {
    id: "H3", category: "hard", difficulty: "hard", title: "Drag and drop", page: "h3-drag.html",
    prompt: (c) => `Open ${c.base}/h3-drag.html and drag the card "Task B" into the Done column. ${RULES}`,
    check: (s) => {
      const r = recs(s, "H3");
      if (!r.length) return no("no card was dropped");
      return r.every((x) => x.card === "Task B") && r.some((x) => x.card === "Task B" && x.column === "done") ? ok("Task B is in Done") : no(`drops: ${JSON.stringify(r)}`);
    },
  },
];

export function taskById(id: string): CuTask {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

// ---- the local sites ------------------------------------------------------------------------------

/** Every page reports through rec(task, record) to the local server. */
const REC = `<script>function rec(t,r){return fetch('/rec/'+t,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(r)})}</script>`;
const page = (title: string, body: string, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:40px}${style}</style>${REC}</head><body>${body}</body></html>`;

const rows = Array.from({ length: 30 }, (_, i) => {
  const sku = i === 17 ? "K-7731" : `K-${(7000 + i * 37).toString()}`;
  const price = i === 17 ? "73.15" : (10 + ((i * 7.31) % 90)).toFixed(2);
  const near = i === 16 ? "73.51" : price; // a near-miss neighbour
  return `<tr><td>${sku}</td><td>Part ${i + 1}</td><td>${i === 16 ? near : price}</td></tr>`;
}).join("");

export const PAGES: Record<string, string> = {
  "w1-login.html": page("Sign in", `<h1>Acme portal</h1><form id="f"><label>Username <input name="user" autocomplete="off"></label><br><label>Password <input name="pass" type="password"></label><br><button>Sign in</button></form><p id="m"></p>
<script>f.onsubmit=async e=>{e.preventDefault();await rec('W1',{user:f.user.value,pass:f.pass.value});m.textContent='Signed in.'}</script>`),
  "w2-form.html": page("Sign up", `<h1>Sign up</h1><div id="s1"><h2>Step 1 of 3</h2><label>Full name <input id="name"></label><button onclick="go(2)">Next</button></div>
<div id="s2" hidden><h2>Step 2 of 3</h2><label>City <input id="city"></label><label>Plan <select id="plan"><option>Solo</option><option>Team</option><option>Enterprise</option></select></label><button onclick="go(1)">Back</button><button onclick="go(3)">Next</button></div>
<div id="s3" hidden><h2>Step 3 of 3</h2><label><input type="checkbox" id="confirm"> I confirm these details</label><button onclick="go(2)">Back</button><button id="submit">Submit</button><p id="m"></p></div>
<script>function go(n){for(const i of [1,2,3])document.getElementById('s'+i).hidden=i!==n}
submit.onclick=async()=>{await rec('W2',{name:document.getElementById('name').value,city:city.value,plan:plan.value,confirm:confirm.checked});m.textContent='Thanks!'}</script>`),
  "w3-table.html": page("Parts", `<h1>Parts catalogue</h1><table border="1"><thead><tr><th>SKU</th><th>Name</th><th>Unit price</th></tr></thead><tbody>${rows}</tbody></table>
<p><label>Answer <input id="a"></label><button id="b">Submit</button> <span id="m"></span></p><script>b.onclick=async()=>{await rec('W3',{answer:a.value});m.textContent='Recorded.'}</script>`),
  "w4-cookies.html": page("News", `<h1>The Weekly Digest</h1><p>Get our newsletter.</p><label>Frequency <select id="fq"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><button id="sub">Subscribe</button><p id="m"></p>
<div id="ban" style="position:fixed;inset:auto 0 0 0;height:45%;background:#222;color:#fff;padding:24px"><h2>We value your privacy</h2><p>Choose which cookies we may use.</p><button id="acc">Accept all</button> <button id="rej">Reject all</button></div>
<div id="veil" style="position:fixed;inset:0 0 45% 0;background:rgba(0,0,0,.4)"></div>
<script>const close=c=>async()=>{await rec('W4',{consent:c});ban.remove();veil.remove()};acc.onclick=close('accept');rej.onclick=close('reject');sub.onclick=async()=>{await rec('W4',{subscribed:fq.value});m.textContent='Subscribed.'}</script>`),
  "w5-modal.html": page("Contact", `<h1>Contact us</h1><label>Email <input id="em"></label><br><label>Message <textarea id="msg"></textarea></label><br><button id="send">Send</button><p id="m"></p>
<div id="mod" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div role="dialog" aria-label="Before you continue" style="background:#fff;margin:150px auto;width:360px;padding:24px"><p>Our support hours changed. Please confirm you have read this.</p><button id="cont">Continue</button></div></div>
<script>let shown=false;em.addEventListener('input',()=>{if(shown)return;shown=true;setTimeout(()=>{mod.hidden=false},800)});cont.onclick=async()=>{await rec('W5',{modal:'continue'});mod.hidden=true};
send.onclick=async()=>{if(!mod.hidden)return;await rec('W5',{email:em.value,message:msg.value,sent:true});m.textContent='Sent.'}</script>`),
  "w6-unlabeled.html": page("Invoices", `<h1>Invoices</h1><div id="list"></div>
<script>const svgTrash='<svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11" stroke="#333" fill="none" stroke-width="1.6"/></svg>';
const svgPen='<svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 15l2-5 8-8 3 3-8 8z" stroke="#333" fill="none" stroke-width="1.6"/></svg>';
for(let i=1;i<=5;i++){const r=document.createElement('div');r.style.cssText='display:flex;gap:16px;padding:8px;border-bottom:1px solid #ddd;width:380px';r.innerHTML='<div style="flex:1">Invoice '+i+'</div><div class="e">'+svgPen+'</div><div class="d">'+svgTrash+'</div>';
r.querySelector('.d').onclick=async()=>{await rec('W6',{deleted:'Invoice '+i});r.remove()};list.appendChild(r)}</script>`, ".e,.d{cursor:pointer}"),
  "h1-canvas.html": page("Canvas", `<canvas id="c" width="900" height="500" style="border:1px solid #ccc"></canvas>
<script>const x=c.getContext('2d');const sq=[['blue',80,90],['green',300,300],['red',610,140],['orange',420,60],['purple',740,340],['pink',140,330]];
for(const [col,a,b] of sq){x.fillStyle=col==='pink'?'#f4a6b8':col==='orange'?'#f08a24':col;x.fillRect(a,b,60,60)}
c.onclick=e=>{const r=c.getBoundingClientRect();const px=e.clientX-r.left,py=e.clientY-r.top;const h=sq.find(([_,a,b])=>px>=a&&px<a+60&&py>=b&&py<b+60);rec('H1',{hit:h?h[0]:'none'})}</script>`),
  "h2-context.html": page("Files", `<h1>Shared files</h1><ul id="files"><li>budget.xlsx</li><li>report.pdf</li><li>notes.txt</li></ul>
<div id="menu" role="menu" hidden style="position:fixed;background:#fff;border:1px solid #999;min-width:160px"><div role="menuitem" data-a="open">Open</div><div role="menuitem" data-a="rename">Rename</div><div role="menuitem" id="mv" aria-haspopup="true">Move to &#9656;<div id="sub" role="menu" hidden style="position:absolute;left:100%;top:40px;background:#fff;border:1px solid #999;min-width:120px"><div role="menuitem" data-to="Archive">Archive</div><div role="menuitem" data-to="Trash">Trash</div></div></div></div>
<script>let file=null;files.oncontextmenu=e=>{if(e.target.tagName!=='LI')return;e.preventDefault();file=e.target.textContent;menu.style.left=e.clientX+'px';menu.style.top=e.clientY+'px';menu.hidden=false;sub.hidden=true};
mv.onmouseenter=()=>{sub.hidden=false};document.onclick=async e=>{const t=e.target;if(t.dataset&&t.dataset.to){await rec('H2',{file,action:'move',to:t.dataset.to});menu.hidden=true}else if(t.dataset&&t.dataset.a){await rec('H2',{file,action:t.dataset.a});menu.hidden=true}else if(!menu.contains(t))menu.hidden=true}</script>`, "#menu div{padding:6px 10px;position:relative}#menu div:hover{background:#def}"),
  "h3-drag.html": page("Board", `<h1>Board</h1><div style="display:flex;gap:24px"><div class="col" data-col="todo"><h2>To do</h2><div class="card" draggable="true">Task A</div><div class="card" draggable="true">Task B</div><div class="card" draggable="true">Task C</div></div><div class="col" data-col="doing"><h2>Doing</h2></div><div class="col" data-col="done"><h2>Done</h2></div></div>
<script>let drag=null;for(const k of document.querySelectorAll('.card'))k.ondragstart=()=>{drag=k};for(const c of document.querySelectorAll('.col')){c.ondragover=e=>e.preventDefault();c.ondrop=async e=>{e.preventDefault();if(!drag)return;c.appendChild(drag);await rec('H3',{card:drag.textContent,column:c.dataset.col});drag=null}}</script>`,
  ".col{width:220px;min-height:320px;background:#f3f3f3;padding:8px}.card{background:#fff;border:1px solid #bbb;padding:10px;margin:8px 0;cursor:grab}"),
};

/**
 * The local site server (node, no dependencies): serves PAGES from its folder on 127.0.0.1 and
 * appends every POST /rec/<task> body to submissions.json. Started as the box user by the runner.
 */
export const SERVER_JS = `import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const [port, dir] = [Number(process.argv[2]), process.argv[3]];
const out = path.join(dir, "submissions.json");
if (!fs.existsSync(out)) fs.writeFileSync(out, "{}");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname.startsWith("/rec/")) {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 65536) req.destroy(); });
    req.on("end", () => { try { const all = JSON.parse(fs.readFileSync(out, "utf8")); const t = u.pathname.slice(5).replace(/[^A-Z0-9]/g, ""); (all[t] ??= []).push(JSON.parse(b)); fs.writeFileSync(out, JSON.stringify(all)); res.end("ok"); } catch { res.statusCode = 400; res.end("bad"); } });
    return;
  }
  const f = path.join(dir, "site", path.basename(u.pathname));
  if (req.method === "GET" && f.endsWith(".html") && fs.existsSync(f)) { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(fs.readFileSync(f)); return; }
  res.statusCode = 404; res.end("not found");
}).listen(port, "127.0.0.1");
`;
