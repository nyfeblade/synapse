import { LIMITS } from "@synapse/shared";
import { createHostApp } from "./app";
import { loadConfig } from "./config";
import { log } from "./util/log";

async function serve(): Promise<void> {
  const cfg = loadConfig();
  const app = await createHostApp(cfg);
  const { port } = await app.listen();
  log.info("host listening", { port, bind: cfg.bind, brain: cfg.brain });
  const stop = async (sig: string) => {
    log.info("host shutting down", { sig });
    const watchdog = setTimeout(() => process.exit(1), LIMITS.shutdownWatchdogMs);
    watchdog.unref();
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

const cmd = process.argv[2] ?? "serve";
if (cmd === "serve") {
  await serve();
} else if (cmd === "brain-conformance") {
  const { runConformanceCommand } = await import("./brain/conformance/cli");
  process.exit(await runConformanceCommand(process.argv.slice(3)));
} else if (cmd === "walls-migration-plan") {
  // Bug #66: box/migrate-per-bot-uid.sh runs this as bothost (host stopped) and applies the plan as root.
  const { runMigrationPlanCommand } = await import("./walls/migration-plan");
  process.exit(runMigrationPlanCommand(loadConfig()));
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
