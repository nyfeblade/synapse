import { describe, expect, it } from "vitest";
import { Emitter } from "../src/events";

type Ev = { ping: number; pong: string };

describe("Emitter", () => {
  it("calls listeners in registration order", () => {
    const e = new Emitter<Ev>();
    const seen: string[] = [];
    e.on("ping", (n) => seen.push(`a${n}`));
    e.on("ping", (n) => seen.push(`b${n}`));
    expect(e.emit("ping", 1)).toBe(2);
    expect(seen).toEqual(["a1", "b1"]);
  });
  it("unsubscribes through the returned function and through off", () => {
    const e = new Emitter<Ev>();
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    const un = e.on("ping", fn);
    e.emit("ping", 1);
    un();
    e.emit("ping", 2);
    e.on("ping", fn);
    e.off("ping", fn);
    e.emit("ping", 3);
    expect(seen).toEqual([1]);
    expect(e.listenerCount("ping")).toBe(0);
  });
  it("runs a once listener one time and still calls the listeners after it", () => {
    const e = new Emitter<Ev>();
    const seen: string[] = [];
    e.once("pong", (s) => seen.push(`once:${s}`));
    e.on("pong", (s) => seen.push(`on:${s}`));
    e.emit("pong", "x");
    e.emit("pong", "y");
    expect(seen).toEqual(["once:x", "on:x", "on:y"]);
  });
  it("emits to nobody without error", () => {
    expect(new Emitter<Ev>().emit("ping", 1)).toBe(0);
  });
});
