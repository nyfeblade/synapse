import type { CommandHandlers } from "./gateway/server";

/** Each subsystem exports a create*Commands(deps) module; app.ts merges them. Duplicate names are a wiring bug. */
export function mergeCommands(...mods: CommandHandlers[]): CommandHandlers {
  const out: CommandHandlers = {};
  for (const m of mods) {
    for (const [k, v] of Object.entries(m)) {
      if (k in out) throw new Error(`duplicate gateway command ${k}`);
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
