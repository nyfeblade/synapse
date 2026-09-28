import { expect, it } from "vitest";
import * as csv from "../src/csv";

type Opts = { delimiter?: string };
const parse = csv.parseCsv as unknown as (t: string, o?: Opts) => string[][];
const stringify = csv.stringifyCsv as unknown as (r: string[][], o?: Opts) => string;

it("parses with another delimiter", () => {
  expect(parse("a;b;c\n1;2;3\n", { delimiter: ";" })).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  expect(parse("a\tb\n1,5\t2\n", { delimiter: "\t" })).toEqual([["a", "b"], ["1,5", "2"]]);
  expect(parse('x;"y;z"\n', { delimiter: ";" })).toEqual([["x", "y;z"]]);
});

it("quotes fields holding the delimiter when writing", () => {
  expect(stringify([["a;b", "c"]], { delimiter: ";" })).toBe('"a;b";c\n');
  expect(stringify([["a", "b"], ["1", "2"]], { delimiter: "\t" })).toBe("a\tb\n1\t2\n");
  const rows = [["h1", "h2"], ["v;1", "v\t2"]];
  expect(parse(stringify(rows, { delimiter: ";" }), { delimiter: ";" })).toEqual(rows);
});

it("defaults to a comma, as before", () => {
  expect(parse("a,b\n")).toEqual([["a", "b"]]);
  expect(parse("a,b\n", {})).toEqual([["a", "b"]]);
  expect(stringify([["a", "x,y"]])).toBe('a,"x,y"\n');
  expect(stringify([["a", "x,y"]], {})).toBe('a,"x,y"\n');
});

it("rejects a delimiter that is not one character", () => {
  expect(() => parse("a", { delimiter: ";;" })).toThrow(RangeError);
  expect(() => parse("a", { delimiter: "" })).toThrow(RangeError);
  expect(() => stringify([["a"]], { delimiter: "ab" })).toThrow(RangeError);
});
