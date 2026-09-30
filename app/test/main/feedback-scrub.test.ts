// Send feedback → Attach logs: the scrubber every log line passes through before it can leave the Mac.
import { describe, expect, it } from "vitest";
import { scrubLines, scrubText } from "../../src/main/feedback/scrub";

// Placeholder-shaped test values (they carry ABCDEFG / 0123456 runs), never real keys.
const KEYS: Record<string, string> = {
  anthropic: "sk-ant-api03-ABCDEFGhijklmn0123456789_opqrstuvwx-yz",
  openai: "sk-proj-ABCDEFG0123456789abcdefghijklmnop",
  googleOauth: "AQ.ABCDEFG0123456789abcdefghijklmnopqrstuv",
  gemini: "AIzaSyABCDEFG0123456789abcdefghijklmno",
  githubClassic: "ghp_AAAAAAbcdefghij0123456789klmnopqrstu",
  githubOauth: "gho_AAAAAAbcdefghij0123456789klmnopqrstu",
  githubFine: "github_pat_11AAAAAA0123456_ABCDEFGabcdefg0123456789",
};

describe("scrubText", () => {
  for (const [name, key] of Object.entries(KEYS)) {
    it(`removes a ${name} key wherever it sits`, () => {
      for (const line of [`key=${key}`, `{"apiKey":"${key}"}`, `using ${key} now`, `https://x.test/?k=${key}`, `(${key})`]) {
        const out = scrubText(line);
        expect(out).not.toContain(key);
        expect(out).not.toContain(key.slice(0, 14));
      }
    });
  }

  it("removes bearer, basic and token headers, and Authorization / x-api-key values", () => {
    for (const line of [
      "Authorization: Bearer abc.def.ghi-jkl",
      'headers {"authorization":"Bearer abcdefghijk"}',
      "Basic dXNlcjpwYXNzd29yZA==",
      "x-api-key: plainvalue123",
      "Token qwertyuiop",
    ]) {
      const out = scrubText(line);
      for (const secret of ["abc.def.ghi-jkl", "abcdefghijk", "dXNlcjpwYXNzd29yZA==", "plainvalue123", "qwertyuiop"]) expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    }
  });

  it("removes email addresses", () => {
    const out = scrubText("signed in as jane.doe+test@example.co.uk, cc ops@mail.example.org");
    expect(out).not.toMatch(/@/);
    expect(out).toContain("[email]");
  });

  it("turns home-folder paths into ~, from the real home and from any /Users/<name> or /home/<name>", () => {
    expect(scrubText("read /Users/jane/Library/Logs/Synapse/main.log")).toBe("read ~/Library/Logs/Synapse/main.log");
    expect(scrubText("cwd /home/jdoe/project")).toBe("cwd ~/project");
    expect(scrubText("at /Volumes/Home/jane/x", { home: "/Volumes/Home/jane" })).toBe("at ~/x");
    expect(scrubText("open /Users/Shared/thing")).toBe("open /Users/Shared/thing");
    expect(scrubText('"/Users/jane"')).toBe('"~"');
  });

  it("removes a known secret value in any encoding (the crash redactor underneath)", () => {
    const out = scrubText("token is hunter2hunter2 ok", { knownValues: ["hunter2hunter2"] });
    expect(out).not.toContain("hunter2hunter2");
  });

  it("is idempotent, so scrubbing again in main changes nothing the user previewed", () => {
    const once = scrubText(`Authorization: Bearer ${KEYS.anthropic} /Users/jane/x jane@example.com ${KEYS.gemini}`);
    expect(scrubText(once)).toBe(once);
  });

  it("leaves ordinary log lines alone", () => {
    const line = "2026-09-29T10:00:00.000Z info [launch] window shown in 412 ms";
    expect(scrubText(line)).toBe(line);
  });
});

describe("scrubLines", () => {
  it("keeps the last 300 lines, cuts long lines and stays under the byte cap", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(i === 499 ? 900 : 10)}`);
    const out = scrubLines(lines).split("\n");
    expect(out.length).toBe(300);
    expect(out[0]).toMatch(/^line 200 /);
    expect(out.at(-1)!.length).toBeLessThanOrEqual(520);
    expect(Buffer.byteLength(scrubLines(lines, { maxBytes: 2000 }))).toBeLessThanOrEqual(2000);
  });

  it("canary: a fake key planted everywhere in a log never comes out", () => {
    const canary = "sk-ant-api03-CANARYABCDEFG0123456789canarycanary";
    const lines = [
      `info start key=${canary}`,
      `warn {"headers":{"x-api-key":"${canary}"}}`,
      `error Authorization: Bearer ${canary}`,
      `info fetch https://api.example.test/v1?api_key=${canary}&x=1`,
      `info path /Users/jane/.config/${canary}/file`,
      `debug ${canary}`,
      `debug "${canary}"`,
      `debug ${canary.toUpperCase()}`,
    ];
    const out = scrubLines(lines, { home: "/Users/jane" });
    expect(out).not.toContain(canary);
    expect(out).not.toContain("CANARYABCDEFG");
    expect(out.toLowerCase()).not.toContain("canaryabcdefg");
    expect(out).not.toContain("jane");
  });
});

describe("probe cases (review round 1)", () => {
  const canary = "CANARYabcdefg0123456789zz";
  it("redacts secret-named query parameters and URL credentials", () => {
    for (const q of ["token", "access_token", "key", "api_key", "sig", "auth", "signature", "session", "X-Amz-Signature"]) {
      const out = scrubText(`GET https://api.example.test/v1/files?name=a&${q}=${canary}&page=2`);
      expect(out, q).not.toContain(canary);
      expect(out).toContain("page=2");
    }
    const out = scrubText(`https://bob:${canary}@example.test/path`);
    expect(out).not.toContain(canary);
    expect(out).not.toContain("bob");
  });

  it("redacts JSON-escaped headers and keys", () => {
    for (const line of [
      `{\"x-api-key\":\"${canary}\"}`,
      `"{\\"authorization\\": \\"Bearer ${canary}\\"}"`,
      `{\"token\":\"${canary}\"}`,
      `{\'apiKey\': \'${canary}\'}`,
      `body=\"${canary}\"`,
    ]) expect(scrubText(line), line).not.toContain(canary);
  });

  it("redacts URL-encoded headers, emails and home paths", () => {
    for (const line of [
      `h=Authorization%3A%20Bearer%20${canary}`,
      `to=jane.doe%40example.com`,
      `file=%2FUsers%2Fjane%2FLibrary%2Fx`,
      `q=x-api-key%3D${canary}`,
    ]) {
      const out = scrubText(line);
      expect(out, line).not.toContain(canary);
      expect(out.toLowerCase(), line).not.toContain("jane");
    }
  });

  it("redacts every known value, and the Mac's user name wherever it appears", () => {
    const out = scrubText(`proxy ${"prx_" + canary} user jdoe logged in as JDoe`, { knownValues: ["prx_" + canary], username: "jdoe" });
    expect(out).not.toContain(canary);
    expect(out.toLowerCase()).not.toContain("jdoe");
  });

  it("canary: one fake key in every form never comes out, and scrubbing stays idempotent", () => {
    const key = "sk-ant-api03-CANARYABCDEFG0123456789canary";
    const forms = [
      key, JSON.stringify(key), JSON.stringify(JSON.stringify({ k: key })), encodeURIComponent(key),
      `https://x.test/?token=${key}`, `Authorization%3A%20Bearer%20${encodeURIComponent(key)}`,
      `{\"x-api-key\":\"${key}\"}`, `key%3D${key}`, key.toUpperCase(),
    ];
    const out = scrubLines(forms.map((f, i) => `line ${i} ${f}`), { home: "/Users/jane", username: "jane" });
    expect(out).not.toMatch(/CANARYABCDEFG/i);
    expect(scrubText(out, { home: "/Users/jane", username: "jane" })).toBe(out);
  });
});
