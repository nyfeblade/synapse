import { expect, it } from "vitest";
import { CsvError, parseCsv, stringifyCsv } from "../src/csv";

it("doubled quotes are one literal quote", () => {
  expect(parseCsv('a,"say ""hi""",c\n')).toEqual([["a", 'say "hi"', "c"]]);
  expect(parseCsv('"""",x\n')).toEqual([['"', "x"]]);
  expect(parseCsv('"",x\n')).toEqual([["", "x"]]);
});

it("quoted fields may hold line breaks", () => {
  expect(parseCsv('a,"line1\nline2"\nb,c\n')).toEqual([["a", "line1\nline2"], ["b", "c"]]);
  expect(parseCsv('"x\r\ny",z\r\n')).toEqual([["x\r\ny", "z"]]);
});

it("round-trips whatever stringifyCsv writes", () => {
  const rows = [
    ["id", "note"],
    ["1", 'he said "no, thanks"'],
    ["2", "multi\nline, with comma"],
    ["3", ""],
    ["4", " padded "],
  ];
  expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
});

it("keeps the old behaviour for plain input", () => {
  expect(parseCsv("a,b,c\n1,2,3\n\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  expect(parseCsv('id,name\n1,"Birch, Inc"\n')).toEqual([["id", "name"], ["1", "Birch, Inc"]]);
  expect(parseCsv("a,,c\r\n")).toEqual([["a", "", "c"]]);
});

it("still rejects an unterminated quote", () => {
  expect(() => parseCsv('a\n"oops\n')).toThrow(CsvError);
  expect(() => parseCsv('a,"b""\n')).toThrow(CsvError);
});
