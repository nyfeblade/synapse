import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "../../../brain/provider/sse";

const STREAM = [
  "﻿: keep-alive comment\n",
  "data: {\"a\":1}\n\n",
  "event: ping\r\ndata: x\r\n\r\n",
  "data: line one\ndata: line two\n\n",
  "data:no-space\r\r",
  "id: 7\ndata: {\"emoji\":\"héllo — 🙂 日本\"}\n\n",
  "data\n\n", // a field with no colon: empty data
  "data: [DONE]\n\n",
  "data: trailing event with no blank line",
].join("");
const EXPECTED: SseEvent[] = [
  { event: "message", data: "{\"a\":1}" },
  { event: "ping", data: "x" },
  { event: "message", data: "line one\nline two" },
  { event: "message", data: "no-space" },
  { event: "message", data: "{\"emoji\":\"héllo — 🙂 日本\"}", id: "7" },
  { event: "message", data: "", id: "7" },
  { event: "message", data: "[DONE]", id: "7" },
];

function runSplit(bytes: Uint8Array, cuts: number[]): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  let prev = 0;
  for (const c of [...cuts, bytes.length]) { out.push(...p.push(bytes.subarray(prev, c))); prev = c; }
  out.push(...p.end());
  return out;
}

describe("SseParser", () => {
  it("parses a whole stream (comments, CRLF, CR, multi-line data, ids, BOM) and drops an unterminated trailing event", () => {
    expect(runSplit(new TextEncoder().encode(STREAM), [])).toEqual(EXPECTED);
  });

  it("gives the same events whatever the chunk boundaries (every single cut, then 500 random splits)", () => {
    const bytes = new TextEncoder().encode(STREAM);
    for (let i = 1; i < bytes.length; i++) expect(runSplit(bytes, [i])).toEqual(EXPECTED);
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 500; t++) {
      const cuts = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 20) }, () => 1 + Math.floor(rand() * (bytes.length - 1))))].sort((a, b) => a - b);
      expect(runSplit(bytes, cuts)).toEqual(EXPECTED);
    }
  });

  it("byte-at-a-time, including inside multi-byte characters and between CR and LF", () => {
    const bytes = new TextEncoder().encode(STREAM);
    expect(runSplit(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1))).toEqual(EXPECTED);
  });

  it("accepts string chunks too", () => {
    const p = new SseParser();
    expect([...p.push("data: a\n"), ...p.push("\ndata: b\r"), ...p.push("\n\r\n")]).toEqual([{ event: "message", data: "a" }, { event: "message", data: "b" }]);
  });
});
