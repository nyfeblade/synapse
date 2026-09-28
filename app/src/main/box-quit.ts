export async function shutdownOnQuit(opts: {
  keepBoxOnQuit: boolean;
  dispose(): void | Promise<void>;
  kill(): void;
  stopBox?(): Promise<void>;
}): Promise<void> {
  await opts.dispose();
  opts.kill();
  if (!opts.keepBoxOnQuit && opts.stopBox) await opts.stopBox();
}
