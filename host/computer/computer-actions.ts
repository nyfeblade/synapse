import { LIMITSC, STRC, type ComputerActionEvent } from "@synapse/shared";
import { z } from "zod";

export { REVIEWED_COMPUTER_ACTIONS } from "@synapse/shared";

export const ACTIONS = ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"] as const;
export type ActionName = (typeof ACTIONS)[number];

export interface ComputerAction {
  action: ActionName;
  x?: number; y?: number; x2?: number; y2?: number;
  path?: { x: number; y: number }[];
  text?: string; key?: string;
  button?: "left" | "right" | "middle"; count?: number; modifiers?: string[];
  direction?: "up" | "down" | "left" | "right"; amount?: number; durationMs?: number;
  description?: string;
}
export interface ComputerInput extends ComputerAction { then?: ComputerAction[] }

/** BRW-03: settle 2,000 ms after mutating actions. */
export const SETTLE_ACTIONS: ReadonlySet<ActionName> = new Set(["click", "drag", "type", "key", "scroll"]);
const ENFORCE_THEN: ReadonlySet<ActionName> = new Set(["move", "wait", "scroll"]);

const step = {
  action: z.enum(ACTIONS),
  x: z.number().int().optional(), y: z.number().int().optional(), x2: z.number().int().optional(), y2: z.number().int().optional(),
  path: z.array(z.object({ x: z.number().int(), y: z.number().int() })).optional(),
  text: z.string().optional(), key: z.string().optional(),
  button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional(),
  modifiers: z.array(z.enum(["ctrl", "shift", "alt", "super", "cmd", "meta"])).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(LIMITSC.scrollAmountMax).optional(),
  durationMs: z.number().int().min(0).optional(),
  description: z.string().optional(),
};
export const computerSchema = { ...step, then: z.array(z.object(step)).optional() };

const W = LIMITSC.displayWidth;
const H = LIMITSC.displayHeight;
const inside = (x?: number, y?: number) => x === undefined || y === undefined || (x >= 0 && x < W && y >= 0 && y < H);

function check(a: ComputerAction, enforce: boolean): string | null {
  const pts: [number | undefined, number | undefined][] = [[a.x, a.y], [a.x2, a.y2], ...(a.path ?? []).map((p) => [p.x, p.y] as [number, number])];
  if (pts.some(([x, y]) => !inside(x, y))) return "Coordinates must be inside the 1280×800 screen: x from 0 to 1279, y from 0 to 799.";
  if ((a.action === "click" || a.action === "move" || a.action === "drag") && (a.x === undefined || a.y === undefined)) return `${a.action} needs x and y.`;
  if (a.action === "drag" && (a.x2 === undefined || a.y2 === undefined) && !a.path?.length) return "drag needs x2 and y2, or a path.";
  if (a.action === "type" && !a.text) return "type needs text.";
  if (a.action === "key" && !a.key) return "key needs a key name (xdotool names, e.g. ctrl+a, Return, BackSpace).";
  if ((a.text ?? "").length > LIMITSC.textMax) return "text can be at most 2,000 characters.";
  if ((a.key ?? "").length > LIMITSC.keyMax) return "key can be at most 256 characters.";
  if ((a.path ?? []).length > LIMITSC.pathMaxPoints) return "path can have at most 64 points.";
  if ((a.description ?? "").length > LIMITSC.descriptionMax) return "description can be at most 500 characters.";
  if (enforce && (a.action === "click" || a.action === "drag") && !a.description?.trim()) return STRC.needsDescription;
  return null;
}

export function validateComputer(a: ComputerInput, o: { enforce: boolean }): string | null {
  const own = check(a, o.enforce);
  if (own) return own;
  if (a.then !== undefined) {
    if (a.then.length < 1 || a.then.length > LIMITSC.thenMax) return "then must hold 1–9 follow-up steps.";
    if (a.then.some((s) => s.action === "screenshot")) return "then can't contain screenshot; a final screenshot is added automatically.";
    if (o.enforce && a.then.some((s) => !ENFORCE_THEN.has(s.action))) return "With Auto-review on, `then` may only contain move, wait or scroll steps.";
    for (const s of a.then) {
      const e = check(s, o.enforce);
      if (e) return e;
    }
  }
  return null;
}

export type XStep = { xdotool: string[] } | { sleepMs: number };
const BUTTON = { left: "1", middle: "2", right: "3" } as const;
const WHEEL = { up: "4", down: "5", left: "6", right: "7" } as const;
const MOD: Record<string, string> = { ctrl: "ctrl", shift: "shift", alt: "alt", super: "super", cmd: "super", meta: "super" };
const move = (x: number, y: number): XStep => ({ xdotool: ["mousemove", "--sync", String(x), String(y)] });

export function planAction(a: ComputerAction): XStep[] {
  switch (a.action) {
    case "screenshot":
      return [];
    case "move":
      return [move(a.x as number, a.y as number)];
    case "click": {
      const mods = (a.modifiers ?? []).map((m) => MOD[m] as string);
      return [
        ...mods.map((m) => ({ xdotool: ["keydown", m] })),
        move(a.x as number, a.y as number),
        { xdotool: ["click", "--repeat", String(a.count ?? 1), "--delay", "80", BUTTON[a.button ?? "left"]] },
        ...[...mods].reverse().map((m) => ({ xdotool: ["keyup", m] })),
      ];
    }
    case "drag": {
      const pts = a.path?.length ? a.path : [{ x: a.x2 as number, y: a.y2 as number }];
      return [move(a.x as number, a.y as number), { xdotool: ["mousedown", "1"] }, ...pts.map((p) => move(p.x, p.y)), { xdotool: ["mouseup", "1"] }];
    }
    case "type":
      return [{ xdotool: ["type", "--delay", "12", "--", a.text as string] }];
    case "key":
      return [{ xdotool: ["key", "--clearmodifiers", "--", a.key as string] }];
    case "scroll":
      return [
        ...(a.x !== undefined && a.y !== undefined ? [move(a.x, a.y)] : []),
        { xdotool: ["click", "--repeat", String(a.amount ?? 3), "--delay", "40", WHEEL[a.direction ?? "down"]] },
      ];
    case "wait":
      return [{ sleepMs: Math.min(a.durationMs ?? 1000, LIMITSC.waitMaxMs) }];
  }
}

export function eventFor(a: ComputerAction): Omit<ComputerActionEvent, "botId" | "index" | "at" | "source"> | null {
  switch (a.action) {
    case "click": case "move": case "scroll":
      return { kind: a.action, x: a.x ?? null, y: a.y ?? null };
    case "drag":
      return { kind: "drag", x: a.x ?? null, y: a.y ?? null, x2: a.x2 ?? a.path?.at(-1)?.x, y2: a.y2 ?? a.path?.at(-1)?.y };
    case "type": case "key":
      return { kind: a.action, x: null, y: null };
    default:
      return null;
  }
}
