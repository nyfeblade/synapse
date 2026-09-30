// The one-off screenshot migration (scripts/feedback-migrate-screenshots.mjs): old shared branch → one
// orphan ref per screenshot, issues relinked, old branch deleted only when everything moved. GitHub is stubbed.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script, no types
import { migrate } from "../../scripts/feedback-migrate-screenshots.mjs";

const REPO = "o/r";
const ID = "2026-09-20-0123456789ab";
const oldBody = (id: string, msg = "hi") => `> header\n\n\`\`\`text\n${msg}\n\`\`\`\n\n**Screenshot:** [${id}.png](https://github.com/${REPO}/blob/feedback-attachments/feedback/${id}.png) (private branch \`feedback-attachments\`)\n\n<sub>feedback-hash: fh-x</sub>`;

function fake(o: { mainPngs?: string[] } = {}) {
  const calls: { m: string; p: string; b: any }[] = [];
  const refs = new Set<string>();
  const issues = [{ number: 3, body: oldBody(ID) }, { number: 4, body: "no screenshot" }];
  const gh = async (m: string, p: string, b?: any) => {
    calls.push({ m, p, b });
    const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
    if (p === `/repos/${REPO}`) return ok({ default_branch: "main" });
    if (p.startsWith(`/repos/${REPO}/git/trees/main`)) return ok({ tree: (o.mainPngs ?? []).map((path) => ({ path, type: "blob", sha: "m" })) });
    if (p.startsWith(`/repos/${REPO}/git/trees/feedback-attachments`)) return ok({ tree: [{ path: "feedback", type: "tree", sha: "t" }, { path: `feedback/${ID}.png`, type: "blob", sha: "blobsha" }, { path: "feedback/bad name.png", type: "blob", sha: "z" }] });
    if (m === "GET" && p.startsWith(`/repos/${REPO}/git/ref/heads/`)) return refs.has(p.split("/git/ref/heads/")[1]!) ? ok({}) : ok({}, 404);
    if (p.endsWith("/git/trees")) return ok({ sha: "tree1" }, 201);
    if (p.endsWith("/git/commits")) return ok({ sha: "commit1" }, 201);
    if (m === "POST" && p.endsWith("/git/refs")) { refs.add(b.ref.replace("refs/heads/", "")); return ok({}, 201); }
    if (m === "GET" && p.includes("/issues?")) return ok(issues);
    if (m === "PATCH") { const i = issues.find((x) => p.endsWith(`/issues/${x.number}`))!; i.body = b.body; return ok(i); }
    if (m === "DELETE") return new Response(null, { status: 204 });
    return ok({}, 404);
  };
  return { gh, calls, refs, issues };
}

describe("screenshot migration", () => {
  it("dry run by default: reads only, changes nothing", async () => {
    const f = fake();
    const r = await migrate(f.gh, REPO);
    expect(f.calls.every((c) => c.m === "GET")).toBe(true);
    expect(r).toMatchObject({ files: 2, refsMade: 0, issuesRelinked: 0, skipped: ["feedback/bad name.png"] });
  });
  it("--apply: one orphan ref per file reusing the blob, the exact line relinked, the sender's words untouched", async () => {
    const f = fake();
    const r = await migrate(f.gh, REPO, { apply: true });
    expect(r).toMatchObject({ refsMade: 1, issuesRelinked: 1, oldBranchDeleted: false });
    expect(f.calls.find((c) => c.p.endsWith("/git/trees"))!.b).toEqual({ tree: [{ path: `feedback/${ID}.png`, mode: "100644", type: "blob", sha: "blobsha" }] });
    expect(f.calls.find((c) => c.p.endsWith("/git/commits"))!.b.parents).toEqual([]);
    expect(f.calls.some((c) => c.p.endsWith("/git/blobs"))).toBe(false);
    expect(f.issues[0]!.body).toBe(oldBody(ID).replace(`blob/feedback-attachments/feedback/${ID}.png) (private branch \`feedback-attachments\`)`, `blob/shots/${ID}/feedback/${ID}.png) (private branch \`shots/${ID}\`)`));
    expect(f.calls.some((c) => c.m === "DELETE")).toBe(false);
    // Again: nothing new.
    const again = await migrate(f.gh, REPO, { apply: true });
    expect(again).toMatchObject({ refsMade: 0, refsExisting: 1, issuesRelinked: 0 });
  });
  it("a sender's fake screenshot line inside the message fence is never rewritten on its own", async () => {
    const f = fake();
    f.issues[1]!.body = "```text\n**Screenshot:** [x.png](https://github.com/o/r/blob/feedback-attachments/feedback/other.png) (private branch `feedback-attachments`)\n```";
    await migrate(f.gh, REPO, { apply: true });
    expect(f.calls.filter((c) => c.m === "PATCH").map((c) => c.p)).toEqual([`/repos/${REPO}/issues/3`]);
  });
  it("won't delete the old branch while any file couldn't move", async () => {
    const f = fake();
    await expect(migrate(f.gh, REPO, { apply: true, deleteOldBranch: true })).rejects.toThrow(/couldn't be moved/);
    expect(f.calls.some((c) => c.m === "DELETE")).toBe(false);
  });
  it("lists PNGs on the default branch (they need a history rewrite, which it never does)", async () => {
    const f = fake({ mainPngs: ["feedback/old.png"] });
    const r = await migrate(f.gh, REPO);
    expect(r.defaultBranchPngs).toEqual(["feedback/old.png"]);
  });
});
