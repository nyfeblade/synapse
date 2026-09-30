import { afterAll, beforeAll } from "vitest";
import { realHomeForTest } from "../../../scripts/test-home";

/**
 * Bug 454: OrbStack's `orb` CLI finds its daemon through ~/.orbstack/run. Under the test home (bug 436) that
 * folder is empty, and every orb call waits forever (the app's limits then read it as "OrbStack didn't answer").
 * Call inside an opt-in live describe that drives a throwaway OrbStack machine: for that block only, HOME is the
 * real one, so orb (and the box scripts the test spawns, which inherit HOME) reach the running OrbStack.
 * Nothing in these tests writes under HOME; orb itself only uses its own ~/.orbstack.
 */
export function realHomeForOrb(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.HOME;
    process.env.HOME = realHomeForTest("OrbStack's CLI reaches its daemon through ~/.orbstack (opt-in live OrbStack run)");
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
}
