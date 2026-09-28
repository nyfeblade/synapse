import { z } from "zod";
import type { BotToolDef } from "../brain/types";
import type { ShellArgs, ShellService } from "./shells";

export function createShellTools(o: { botId: string; shells: ShellService; childId?: string }): BotToolDef[] {
  return [
    {
      name: "Shell",
      description: "Run a shell command on the computer (starts in /workspace; the working directory persists between calls). Commands that take longer than block_until_ms (default 30000; 0 = start in the background) keep running in the background and you're revived when they finish. notify_on_output wakes you when new output matches a pattern.",
      readOnly: false,
      schema: {
        command: z.string(), working_directory: z.string().optional(), block_until_ms: z.number().int().min(0).optional(), description: z.string().optional(),
        notify_on_output: z.object({ pattern: z.string(), reason: z.string(), debounce_ms: z.number().int().min(5000).optional() }).optional(),
        required_permissions: z.array(z.string()).optional(),
      },
      handler: (a) => o.shells.run(o.botId, a as unknown as ShellArgs, { childId: o.childId }),
    },
    {
      name: "AwaitShell",
      description: "Wait for a background command (by task_id) to finish, or until its output matches pattern, for up to block_until_ms.",
      readOnly: true,
      schema: { task_id: z.string(), block_until_ms: z.number().int().min(0).optional(), pattern: z.string().optional() },
      handler: (a) => o.shells.await(o.botId, a as { task_id: string; block_until_ms?: number; pattern?: string }),
    },
  ];
}
