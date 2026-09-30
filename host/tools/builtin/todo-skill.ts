import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../../brain/types";
import type { SkillLibrary } from "../../skills/library";
import { expansionText } from "../../skills/skill-hooks";

/**
 * TodoWrite and Skill for a Bot on a model provider (spec 2026-09-29 §3), in the CLI's shapes.
 * - TodoWrite: the list is recorded from the call itself (context/restore.ts reads every TodoWrite tool_start into
 *   the Bot's "todos"), as for the Claude path; the tool only confirms.
 * - Skill: loads a saved skill the Bot may use (the shared library, minus the ones turned off for this Bot) or a
 *   managed plugin's skill (phase 5 cliPlugins dirs: <plugin>/skills/<name>/SKILL.md). The catalog is already in the
 *   system prompt (skills/skill-hooks.ts skillCatalog).
 */
const err = (text: string): BotToolResult => ({ text: `<tool_use_error>${text}</tool_use_error>`, isError: true });

export function createTodoWriteTool(): BotToolDef {
  return {
    name: "TodoWrite",
    description: "Keeps the task list for a job of several steps: pass the whole list each time, one item in_progress, items completed as you finish them.",
    readOnly: true,
    schema: {
      todos: z.array(z.object({ content: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]), activeForm: z.string().optional() })).max(100),
    },
    handler: async () => ({ text: "Todos have been modified successfully. Keep using the todo list to track your progress, and mark items completed as you finish them." }),
  };
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,99}$/;
const PLUGIN_SKILL_MAX = 64 * 1024;

/** A managed plugin skill's SKILL.md, never through a link (every part lstat-checked). */
function pluginSkill(dirs: string[], name: string): { text: string; dir: string } | null {
  const leaf = name.includes(":") ? name.split(":").pop()! : name;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(leaf)) return null;
  for (const d of dirs) {
    const parts = [d, path.join(d, "skills"), path.join(d, "skills", leaf), path.join(d, "skills", leaf, "SKILL.md")];
    try {
      if (parts.some((p, i) => { const s = fs.lstatSync(p); return s.isSymbolicLink() || (i < 3 ? !s.isDirectory() : !s.isFile()); })) continue;
      const f = parts[3]!;
      if (fs.statSync(f).size > PLUGIN_SKILL_MAX) continue;
      return { text: fs.readFileSync(f, "utf8"), dir: parts[2]! };
    } catch { /* not in this plugin */ }
  }
  return null;
}

export function createSkillTool(o: { botId: string; library: SkillLibrary | null; plugins(): string[] }): BotToolDef {
  return {
    name: "Skill",
    description: "Loads a saved skill (a recipe from the Skills list in your instructions) by its name, and returns its steps to follow now.",
    readOnly: true,
    schema: { skill: z.string(), args: z.string().optional() },
    handler: async (a) => {
      const name = String(a.skill ?? "").trim();
      if (!SKILL_NAME.test(name)) return err("Give the skill's name from the Skills list.");
      const lib = o.library;
      if (lib) {
        const id = lib.findByName(name);
        if (id && !lib.disabledFor(o.botId).includes(id)) {
          const t = expansionText(lib, id);
          if (t) return { text: a.args ? `${t}\n\nInput: ${String(a.args).slice(0, 4000)}` : t };
        }
      }
      const p = pluginSkill(o.plugins(), name);
      if (p) return { text: `Skill "${name}" (from ${p.dir}):\n\n${p.text}${a.args ? `\n\nInput: ${String(a.args).slice(0, 4000)}` : ""}` };
      return err(`Unknown skill: ${name}.`);
    },
  };
}
