/**
 * Start-up timing marks ("[launch] <what> <ms since the page began>"). The main process copies these
 * lines into main.log (index.ts), so a launch that looks wrong can be read back as an ordered list
 * instead of guessed at. A handful per launch; nothing after the first few seconds.
 */
export function launchMark(what: string): void {
  if (performance.now() > 15_000) return;
  try { console.info(`[launch] ${what} ${Math.round(performance.now())}`); } catch { /* no console */ }
}
