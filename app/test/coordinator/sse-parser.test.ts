import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/coordinator/sse-parser";

describe("SseParser", () => {
  it("joins data lines, ignores comments and retry, and handles split chunks and CRLF", () => {
    const out: string[] = [];
    const p = new SseParser((d) => out.push(d));
    p.feed("retry: 2000\n\n: hb\n\ndata: {\"a\"");
    p.feed(":1}\r\n\r\ndata: x\ndata: y\n\n");
    expect(out).toEqual(['{"a":1}', "x\ny"]);
  });
});
