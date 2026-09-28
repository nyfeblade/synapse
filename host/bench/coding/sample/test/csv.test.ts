import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, quoteField, stringifyCsv, toRecords } from "../src/csv";

describe("parseCsv", () => {
  it("splits simple rows and skips blank lines", () => {
    expect(parseCsv("a,b,c\n1,2,3\n\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\n,,\n")).toEqual([["a", "", "c"], ["", "", ""]]);
  });
  it("lets quoted fields hold commas", () => {
    expect(parseCsv('id,name\n1,"Birch, Inc"\n')).toEqual([["id", "name"], ["1", "Birch, Inc"]]);
  });
  it("reports an unterminated quote with its line", () => {
    expect(() => parseCsv('a\n"oops\n')).toThrow(CsvError);
  });
});

describe("stringifyCsv", () => {
  it("quotes only when needed and doubles quotes", () => {
    expect(quoteField("plain")).toBe("plain");
    expect(quoteField("a,b")).toBe('"a,b"');
    expect(quoteField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteField(" pad")).toBe('" pad"');
  });
  it("writes rows with a trailing newline", () => {
    expect(stringifyCsv([["a", "b"], ["1", "x,y"]])).toBe('a,b\n1,"x,y"\n');
    expect(stringifyCsv([])).toBe("");
  });
});

describe("toRecords", () => {
  it("maps rows to objects by header", () => {
    expect(toRecords([["id", "n"], ["1", "a"], ["2", "b"]])).toEqual([{ id: "1", n: "a" }, { id: "2", n: "b" }]);
  });
  it("rejects ragged rows", () => {
    expect(() => toRecords([["id", "n"], ["1"]])).toThrow(/line 2/);
  });
});
