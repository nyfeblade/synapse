import { expect, it } from "vitest";
import { parseCsv } from "../src/csv";

it("reads a doubled quote inside a quoted field as one quote", () => {
  expect(parseCsv('a,"say ""hi""",c\n')).toEqual([["a", 'say "hi"', "c"]]);
});
