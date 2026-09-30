import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { copyHits, excludeMatcher, publicFiles, readExcludes, retiredCopy, RULES, scan, shingleHashes } from "../../scripts/public-scan";

/**
 * Bug 282: the tree must be safe to publish. docs/public-repo-exclude.md lists what never goes in; every
 * other file is public, and none of it may carry the name of the product this app began as a clone of,
 * copy or design values taken from it, the owner's personal data, or notes on still-open weaknesses.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "public-tree-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Planted values are assembled at run time, so this file never matches its own scan.
const j = (...p: string[]) => p.join("");
const PLANTED = {
  "reference product name": j("Built like G", "rok Bot."),
  "reference product maker": j("made by x", "AI"),
  "owner's name": j("signed, Lu", "ke Ho", "rn"),
  "owner's email": j("ho", "rnsons21", "@gmail.com"),
  "owner's home folder": j("/Us", "ers/lu", "kehorn/Project 1"),
  "owner's machine name": j("Lu", "kes-MacBook-Pro"),
  "a real-looking tailnet name": j("mac.tail", "a00f5e.ts.net"),
  "a note on an unfixed weakness": j("KNOWN RESI", "DUAL: a bypass"),
  // Bug 290
  "reference product's other names": j("made by Any", "sphere"),
  "owner's other project": j("voices from ~/Jar", "vis/.venv"),
  "owner's private repo": j("github.com/nyfe", "blade/bots-app/releases"),
  "a hardware (MAC) address": j("headset 84-9D-4B", "-68-2A-32 connected"),
  "a tailnet (100.64/10) address": j("ssh box@100.", "101.7.3"),
  "a private key block": j("-----BEGIN OPENSSH PRI", "VATE KEY-----"),
  "an accepted-gap comment": j(" * Resi", "dual (decisions.md): a race stays open"),
  "a real-format API key or token": j("ANTHROPIC_API_KEY=sk-ant-", "api03-", "Zq7".repeat(10)),
};

describe("the public-tree scan", () => {
  it("finds a planted example of every rule, in a text file and inside a binary, and skips excluded paths", () => {
    const t = path.join(tmp, "planted");
    fs.mkdirSync(path.join(t, "docs"), { recursive: true });
    fs.mkdirSync(path.join(t, "test-reports"), { recursive: true });
    fs.writeFileSync(path.join(t, "docs", "public-repo-exclude.md"), "```paths\ntest-reports/\n```\n");
    fs.writeFileSync(path.join(t, "notes.md"), Object.values(PLANTED).join("\n"));
    fs.writeFileSync(path.join(t, "image.png"), Buffer.concat([Buffer.from([0x89, 0, 1, 2]), Buffer.from(`\0${PLANTED["owner's email"]}\0`)]));
    fs.writeFileSync(path.join(t, "test-reports", "run.md"), PLANTED["owner's email"]);
    // Ordinary words that only look like a rule: a tunnelling service's domain, a first name inside a word.
    fs.writeFileSync(path.join(t, "clean.ts"), "const couriers = ['ngrok-free.app'];\n// lukewarm water; https://mac.example-tailnet.ts.net/\n" +
      "// the cursor lands at (3, 4); a documentation MAC 00-00-5E-00-53-01; 10.0.0.1; sk-ant-api03-synproxy-none\n");
    // A file whose NAME carries the reference, with clean content.
    const named = j("g", "rok-notes.md");
    fs.writeFileSync(path.join(t, named), "nothing to see\n");

    const files = publicFiles(t).sort();
    expect(files).toEqual(["clean.ts", "docs/public-repo-exclude.md", named, "image.png", "notes.md"].sort());
    const hits = scan(t, files);
    expect(hits.filter((h) => h.file === named).map((h) => h.label)).toEqual(["reference product name"]);
    expect(new Set(hits.filter((h) => h.file === "notes.md").map((h) => h.label))).toEqual(new Set(Object.keys(PLANTED)));
    expect(hits.filter((h) => h.file === "image.png").map((h) => h.label)).toEqual(["owner's email"]);
    expect(hits.filter((h) => h.file === "clean.ts")).toEqual([]);
    expect(RULES.map((r) => r.label).sort()).toEqual(Object.keys(PLANTED).sort());
  });

  it("finds copy retired from the reference product, reworded only in case and punctuation", () => {
    const retired = shingleHashes(["The quick brown fox jumps over the lazy dog today", "a short retired line"]);
    const t = path.join(tmp, "copy");
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, "a.ts"), 'const s = "THE QUICK, brown fox — jumps over the lazy dog";\nconst u = `A short retired line!`;\n');
    fs.writeFileSync(path.join(t, "b.ts"), 'const s = "The quick brown fox leaps over a lazy dog";\n');
    expect(copyHits(t, ["a.ts", "b.ts"], retired).map((h) => `${h.file}:${h.line}`)).toEqual(["a.ts:1", "a.ts:2"]);
  });

  // Bugs 291/292 follow-up: a test once stored retired sentences reversed, which put them back in the tree. The scan
  // now reads each file forwards, backwards, with string literals split mid-word joined up, and with base64 runs decoded.
  it("finds retired copy stored reversed, base64-encoded or split across string literals", () => {
    const phrase = "Synthetic retired sentence number nine for the encoded check";
    const retired = shingleHashes([phrase]);
    const t = path.join(tmp, "encoded");
    fs.mkdirSync(t, { recursive: true });
    const rev = [...phrase].reverse().join("");
    const b64 = Buffer.from(phrase).toString("base64");
    const b64rev = Buffer.from(rev).toString("base64");
    const b64url = Buffer.from(`${phrase}??`).toString("base64url");
    fs.writeFileSync(path.join(t, "rev.ts"), `const a = 1;\nconst r = ${JSON.stringify(rev)};\n`);
    fs.writeFileSync(path.join(t, "b64.ts"), `// x\n// y\nconst b = "${b64}";\nconst c = '${b64rev}';\nconst d = "${b64url}";\n`);
    fs.writeFileSync(path.join(t, "split.ts"), `const s = j("Synthetic reti", "red sentence num" + 'ber nine for the enc', \`oded check\`);\n`);
    fs.writeFileSync(path.join(t, "clean.ts"), `const s = "${Buffer.from("nothing retired in here at all, just words").toString("base64")}";\n`);
    const hits = copyHits(t, ["rev.ts", "b64.ts", "split.ts", "clean.ts"], retired).map((h) => `${h.file}:${h.line} ${h.label}`);
    expect(hits).toEqual([
      "b64.ts:3 retired copy (base64)", "b64.ts:4 retired copy (base64, reversed)", "b64.ts:5 retired copy (base64)",
      "rev.ts:2 retired copy (reversed)", "split.ts:1 retired copy (split)",
    ]);
  });
});

// Bug 291: sentences that were shipped nearly word for word from the reference product, and (bug 292) its avatar-shape,
// colour, wallpaper and trivial-message lists. Only their hashes are kept here (retired-copy-sentences.json: the
// SHA-256 of each one's words and its word-run keys), never the text in any form: a list once kept them reversed,
// which published them again. The planted-copy tests above prove a key in the list is found, written out or encoded;
// this proves the real list still holds every key of every one of them.
const SENTENCES = (JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "retired-copy-sentences.json"), "utf8")) as {
  sentences: { id: string; bug: number; keys: string[] }[];
}).sentences;

describe("the retired-copy list knows every sentence taken from the reference product (bugs 291, 292)", () => {
  it("all 19 are listed, by hash only", () => {
    expect(SENTENCES.length).toBe(19);
    expect(SENTENCES.filter((s) => s.bug === 292).length).toBe(4);
    for (const s of SENTENCES) {
      expect(s.id).toMatch(/^[0-9a-f]{64}$/);
      expect(s.keys.length, s.id).toBeGreaterThan(0);
      for (const k of s.keys) expect(k).toMatch(/^[3-7]:[0-9a-f]{8}:[0-9a-f]{16}$/);
    }
  });

  it.each(SENTENCES.map((s) => [s.id.slice(0, 12), s.keys]))("every word run of %s is in the retired list", (_id, keys) => {
    const retired = retiredCopy(root);
    expect((keys as string[]).filter((k) => !retired.has(k))).toEqual([]);
  });
});

describe("the tree is safe to publish (bug 282)", () => {
  const files = publicFiles(root);

  it("carries no reference-product name, no personal data and no notes on unfixed weaknesses", () => {
    expect(files.length).toBeGreaterThan(1000);
    const hits = scan(root, files).map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`);
    expect(hits).toEqual([]);
  });

  it("carries none of the copy retired from the reference product", () => {
    expect(copyHits(root, files).map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  }, 60_000); // hashes every word run of ~2,200 files: a few seconds

  it("the research, the clone spec, its boards and the identity inventory are deleted, not just excluded", () => {
    const tracked = files.concat(readExcludes(root)); // excluded paths too: the delete is the point
    const ref = j("g", "rok-bot");
    for (const gone of [`research/${ref}`, `docs/spec/${ref}-clone-spec.md`, `docs/${ref}-compare.md`, "docs/ui/boards", "design/original-synapse.md"]) {
      expect(fs.existsSync(path.join(root, gone)), gone).toBe(false);
      expect(tracked.filter((f) => f.startsWith(gone)), gone).toEqual([]);
    }
  });

  it("the exclude list names every private path", () => {
    const excluded = excludeMatcher(readExcludes(root));
    for (const p of ["test-reports/voice/a.wav", "tools/private/x.sh", ".scratch/n.md", "design/board.html", "docs/ui/x.html",
      "docs/private/security-notes.md", "docs/superpowers/plans/p.md", "docs/HANDOFF.md", ".claude/skills/s/SKILL.md", "K-9/Dockerfile",
      "research/other/notes.md", "public-release-plan.md", "docs/public-release-plan.md",
      // Bug 290: the working logs (where the design came from, residual notes, quotes) stay private.
      "docs/bug-log.md", "docs/decisions.md"]) {
      expect(excluded(p), p).toBe(true);
    }
    for (const p of ["app/src/main/index.ts", "docs/api-key-auth.md", "LICENSE", "README.md"]) expect(excluded(p), p).toBe(false);
  });

  it("the palette and motion values taken from the reference product are gone from the app", () => {
    const retired = [/#0A0A0A\b/i, /#F7F7F7\b/i, /#C21D2E\b/i, /#FF8A94\b/i, /#EB4145\b/i, /--motion-surface\b/, /--motion-lift\b/, /\bgba-dot\b/];
    // The retired motion curves, as hashes of their spaceless form (so the curves themselves are not published here).
    const retiredCurves = new Set(["65c3471f66f2fa6d", "859a942ac6cfffce"]);
    const curveHash = (c: string) => createHash("sha256").update(c.replace(/\s+/g, "")).digest("hex").slice(0, 16);
    const hits: string[] = [];
    const self = path.relative(root, fileURLToPath(import.meta.url));
    for (const f of files.filter((f) => /^(app|shared|host)\/.*\.(css|tsx?|html|mjs)$/.test(f) && f !== self)) {
      fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((l, i) => {
        for (const re of retired) if (re.test(l)) hits.push(`${f}:${i + 1} ${re.source}`);
        for (const m of l.matchAll(/cubic-bezier\([^)]*\)/g)) if (retiredCurves.has(curveHash(m[0]))) hits.push(`${f}:${i + 1} a retired curve`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("ships the Apache-2.0 licence with a NOTICE and a trademark policy, and every package says so", () => {
    const lic = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
    expect(lic.trimStart().split("\n")[0]).toBe("Apache License");
    expect(lic).toContain("Version 2.0, January 2004");
    expect(lic).toContain("END OF TERMS AND CONDITIONS");
    expect(lic).toContain('on an "AS IS" BASIS');
    const notice = fs.readFileSync(path.join(root, "NOTICE"), "utf8");
    expect(notice).toContain("Copyright 2026 the Synapse authors.");
    expect(notice).toContain("app/build/THIRD-PARTY-NOTICES.txt");
    expect(fs.readFileSync(path.join(root, "TRADEMARKS.md"), "utf8")).toMatch(/based on Synapse/i);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain("(TRADEMARKS.md)");
    for (const p of ["package.json", "app/package.json", "host/package.json", "shared/package.json"]) {
      expect(JSON.parse(fs.readFileSync(path.join(root, p), "utf8")).license, p).toBe("Apache-2.0");
    }
  });
});
