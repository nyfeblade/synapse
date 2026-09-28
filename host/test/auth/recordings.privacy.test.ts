import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDINGS_DIR, loadRecordings } from "./replay-anthropic";

/**
 * Bug 280: the API recordings were made with the owner's own Claude login. They ship in the public repo, so this
 * re-scans them for anything of that login or account: no credential of any kind, no account / organization /
 * workspace / session id, no plan usage (the unified rate-limit headers keep their names, values are redacted).
 */
const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json"));
const raw = files.map((f) => [f, fs.readFileSync(path.join(RECORDINGS_DIR, f), "utf8")] as const);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

describe("the API recordings carry nothing of the login they were made with", () => {
  it("23 files, all loaded", () => {
    expect(files).toHaveLength(23);
    expect(loadRecordings()).toHaveLength(23);
  });

  it.each(raw)("%s: no key, token, email or account id anywhere", (_f, text) => {
    expect(text).not.toMatch(/sk-ant-/i);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/org-[0-9a-f]{8}|"(account|organization)_?(uuid|id)"\s*:\s*"[^<"]/i);
  });

  it.each(loadRecordings().map((r) => [r.file, r] as const))("%s: headers are sanitized", (_f, r) => {
    const req = Object.keys(r.request.headers).map((k) => k.toLowerCase());
    for (const k of ["authorization", "x-api-key", "cookie", "proxy-authorization"]) expect(req).not.toContain(k);
    expect(r.request.auth).not.toMatch(/[A-Za-z0-9_-]{24,}/); // the credential's style only, never its value
    expect(r.request.headers["x-claude-code-session-id"] ?? "<redacted>").toBe("<redacted>");
    const res = r.response.headers;
    for (const k of ["request-id", "anthropic-organization-id", "cf-ray", "set-cookie"]) expect(res).not.toHaveProperty(k);
    for (const [k, v] of Object.entries(res)) {
      if (/^anthropic-ratelimit-unified-|^anthropic-workspace-id$|^traceresponse$/.test(k)) expect(v, k).toBe("<redacted>");
    }
    const meta = (r.request.body as { metadata?: { user_id?: string } }).metadata;
    if (meta?.user_id) expect(meta.user_id).not.toMatch(/device|account|session|[0-9a-f]{16}/i);
  });
});
