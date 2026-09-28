/**
 * Electron 44 runs Node 22 in a utilityProcess, where --unhandled-rejections=throw is the default:
 * one stray rejection anywhere in the coordinator takes the process down, and with it the renderer's
 * only link to the host. Rejections are logged instead. A genuine uncaught exception is still fatal —
 * the process state is unknown at that point — and main's CoordinatorHost re-forks it.
 */
export function installProcessGuards(p: NodeJS.EventEmitter, log: (msg: string, e: unknown) => void = (m, e) => console.error(m, e)): void {
  p.on("unhandledRejection", (e: unknown) => log("coordinator unhandled rejection", e));
}
