import { useSavedAuth } from "../../auth/auth-store";
import { loadConfig } from "../../config";
import { createConformanceContext } from "./context";
import { resolveRunAsAndCliVersion, runConformance, saveConformance } from "./runner";
import { ALL_CHECKS } from "./checks/index";

export async function runConformanceCommand(args: string[]): Promise<number> {
  const cfg = loadConfig();
  await useSavedAuth(cfg); // the box's saved API key, through a key proxy of its own
  const { prev, runAs, cliVersion } = await resolveRunAsAndCliVersion(cfg);
  const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
  const ctx = createConformanceContext(cfg, runAs);
  const r = await runConformance(ALL_CHECKS, ctx, { includeSlow: args.includes("--slow"), only, previous: prev, cliVersion, now: Date.now });
  if (!saveConformance(cfg.hostPrivate, r)) console.log("NOT SAVED: the CLI version probe failed; the saved results were kept.");
  console.log(`Claude Code ${cliVersion ?? "unknown"}`);
  for (const [id, v] of Object.entries(r.results)) console.log(`${v.status.toUpperCase().padEnd(4)} ${id}  ${v.detail}`);
  console.log(`flags: ${JSON.stringify(r.flags)}`);
  return 0;
}
