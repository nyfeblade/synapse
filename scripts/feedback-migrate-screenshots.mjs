#!/usr/bin/env node
// One-off, for the owner to run by hand: moves feedback screenshots from the old shared
// `feedback-attachments` branch to one orphan branch each (`shots/<id>`), the way new ones are stored
// since 0.1.4, so deleting a feedback item (Synapse Admin → Delete) can make its screenshot unreachable.
//
//   FEEDBACK_REPO=owner/name FEEDBACK_GITHUB_TOKEN=… node scripts/feedback-migrate-screenshots.mjs            # dry run: prints the plan
//   FEEDBACK_REPO=owner/name FEEDBACK_GITHUB_TOKEN=… node scripts/feedback-migrate-screenshots.mjs --apply    # makes the refs, relinks the issues
//   … --apply --delete-old-branch   # also deletes `feedback-attachments` once every file has its own ref and every link is updated
//
// The token needs Contents: read and write and Issues: read and write on that repo. It is never printed.
// Nothing is re-uploaded: each new branch's tree points at the existing blob. Safe to run again (existing
// refs and already-updated issues are skipped).
//
// What it can't do: if screenshots were ever committed to the DEFAULT branch, they stay in its history.
// The script lists them; purging them needs a history rewrite of that private repo (git filter-repo and a
// force-push), which this script never does. Deleting the old `feedback-attachments` branch is enough for
// its own history, because that branch is an orphan that shares no commits with anything else. GitHub may
// still keep unreachable objects until its own garbage collection runs; for an immediate purge, ask GitHub
// Support to run a garbage collection on the repo.

export const OLD_BRANCH = "feedback-attachments";
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function github(token, fetchImpl = globalThis.fetch) {
  return (method, path, body) => fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "synapse-feedback-migrate", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const oldLine = (repo, id) => `**Screenshot:** [${id}.png](https://github.com/${repo}/blob/${OLD_BRANCH}/feedback/${id}.png) (private branch \`${OLD_BRANCH}\`)`;
const newLine = (repo, id) => `**Screenshot:** [${id}.png](https://github.com/${repo}/blob/shots/${id}/feedback/${id}.png) (private branch \`shots/${id}\`)`;

async function json(r, what) {
  if (!r.ok) throw new Error(`${what}: GitHub answered ${r.status}`);
  return r.json();
}

/** PNGs at feedback/<id>.png in a branch's tree: [{ id, sha }]. A missing branch → []. */
async function pngs(gh, repo, branch) {
  const r = await gh("GET", `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (r.status === 404 || r.status === 409) return [];
  const t = await json(r, `tree of ${branch}`);
  if (t.truncated) throw new Error(`the tree of ${branch} is too big to list in one call; migrate in parts`);
  return (t.tree || []).filter((e) => e.type === "blob" && /\.png$/i.test(e.path)).map((e) => ({ path: e.path, sha: e.sha }));
}

async function allFeedbackIssues(gh, repo) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await json(await gh("GET", `/repos/${repo}/issues?labels=feedback&state=all&per_page=100&page=${page}`), "issue list");
    out.push(...rows.filter((i) => !i.pull_request));
    if (rows.length < 100) break;
  }
  return out;
}

/** Plans (and with apply: true, does) the move. Returns a report; throws on any GitHub failure it can't skip. */
export async function migrate(gh, repo, { apply = false, deleteOldBranch = false, log = () => {} } = {}) {
  const report = { files: 0, refsMade: 0, refsExisting: 0, issuesRelinked: 0, skipped: [], defaultBranchPngs: [], oldBranchDeleted: false };
  const info = await json(await gh("GET", `/repos/${repo}`), "repo");
  report.defaultBranchPngs = (await pngs(gh, repo, info.default_branch)).map((f) => f.path);

  const files = (await pngs(gh, repo, OLD_BRANCH)).filter((f) => f.path.startsWith("feedback/"));
  report.files = files.length;
  const ids = [];
  for (const f of files) {
    const id = f.path.slice("feedback/".length, -".png".length);
    if (!ID_RE.test(id)) { report.skipped.push(f.path); continue; }
    ids.push(id);
    const exists = await gh("GET", `/repos/${repo}/git/ref/heads/shots/${id}`);
    if (exists.ok) { report.refsExisting++; continue; }
    if (exists.status !== 404) throw new Error(`ref check: GitHub answered ${exists.status}`);
    log(`${apply ? "making" : "would make"} shots/${id}`);
    if (!apply) continue;
    const tree = await json(await gh("POST", `/repos/${repo}/git/trees`, { tree: [{ path: `feedback/${id}.png`, mode: "100644", type: "blob", sha: f.sha }] }), "tree");
    const commit = await json(await gh("POST", `/repos/${repo}/git/commits`, { message: `feedback screenshot ${id}`, tree: tree.sha, parents: [] }), "commit");
    const ref = await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/shots/${id}`, sha: commit.sha });
    if (ref.status === 422) { report.refsExisting++; continue; }
    await json(ref, "ref");
    report.refsMade++;
  }

  // Relink: only the exact server-written line changes; the sender's words are never touched.
  for (const issue of await allFeedbackIssues(gh, repo)) {
    const body = String(issue.body || "");
    let next = body;
    for (const id of ids) next = next.split(oldLine(repo, id)).join(newLine(repo, id));
    if (next === body) continue;
    log(`${apply ? "relinking" : "would relink"} issue #${issue.number}`);
    if (!apply) continue;
    await json(await gh("PATCH", `/repos/${repo}/issues/${issue.number}`, { body: next }), `issue #${issue.number}`);
    report.issuesRelinked++;
  }

  if (apply && deleteOldBranch) {
    if (report.skipped.length) throw new Error(`not deleting ${OLD_BRANCH}: ${report.skipped.length} file(s) couldn't be moved`);
    const left = (await allFeedbackIssues(gh, repo)).filter((i) => String(i.body || "").includes(`/blob/${OLD_BRANCH}/`));
    if (left.length) throw new Error(`not deleting ${OLD_BRANCH}: issue(s) still link it: ${left.map((i) => `#${i.number}`).join(", ")}`);
    const d = await gh("DELETE", `/repos/${repo}/git/refs/heads/${OLD_BRANCH}`);
    if (!d.ok && d.status !== 404 && d.status !== 422) throw new Error(`delete ${OLD_BRANCH}: GitHub answered ${d.status}`);
    report.oldBranchDeleted = true;
  }
  return report;
}

async function main() {
  const repo = process.env.FEEDBACK_REPO, token = process.env.FEEDBACK_GITHUB_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { console.error("Set FEEDBACK_REPO=owner/name and FEEDBACK_GITHUB_TOKEN."); process.exit(2); }
  const apply = process.argv.includes("--apply"), deleteOldBranch = process.argv.includes("--delete-old-branch");
  if (deleteOldBranch && !apply) { console.error("--delete-old-branch needs --apply."); process.exit(2); }
  const r = await migrate(github(token), repo, { apply, deleteOldBranch, log: (m) => console.log(m) });
  console.log(JSON.stringify(r, null, 2));
  if (!apply) console.log("Dry run. Nothing changed. Add --apply to do it.");
  if (r.defaultBranchPngs.length) console.log(`${r.defaultBranchPngs.length} PNG(s) are on the default branch: removing them from history needs a history rewrite (not done here).`);
  if (r.oldBranchDeleted) console.log("GitHub may keep unreachable objects until its garbage collection runs. For an immediate purge, ask GitHub Support to run one on this repo.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
