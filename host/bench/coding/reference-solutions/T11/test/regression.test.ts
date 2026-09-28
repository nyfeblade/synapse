import { expect, it } from "vitest";
import { Emitter } from "../src/events";

// Regression: emit iterated the live listener list, so a once() listener removing itself made the
// next listener miss that emit.
it("a self-removing once listener does not make the next listener miss the emit", () => {
  const e = new Emitter<{ x: number }>();
  const seen: string[] = [];
  e.once("x", () => seen.push("once"));
  e.on("x", () => seen.push("next"));
  e.emit("x", 1);
  expect(seen).toEqual(["once", "next"]);
});
