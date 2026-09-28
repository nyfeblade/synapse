import { expect, it } from "vitest";
import { Emitter } from "../src/events";

type Ev = { e: number };

it("a once listener does not make the next listener miss the emit", () => {
  const em = new Emitter<Ev>();
  const seen: string[] = [];
  em.once("e", () => seen.push("a"));
  em.once("e", () => seen.push("b"));
  em.on("e", () => seen.push("c"));
  expect(em.emit("e", 1)).toBe(3);
  expect(seen).toEqual(["a", "b", "c"]);
  em.emit("e", 2);
  expect(seen).toEqual(["a", "b", "c", "c"]);
});

it("uses the listener list as it was when the emit started", () => {
  const em = new Emitter<Ev>();
  const seen: string[] = [];
  const late = () => seen.push("late");
  const second = () => seen.push("second");
  em.on("e", () => {
    seen.push("first");
    em.on("e", late); // added during emit: not called this time
    em.off("e", second); // removed during emit: still called this time
  });
  em.on("e", second);
  em.emit("e", 1);
  expect(seen).toEqual(["first", "second"]);
});
