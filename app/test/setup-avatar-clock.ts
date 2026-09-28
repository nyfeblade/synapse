import { setDefaultAvatarClock } from "../src/renderer/avatar/avatar-loop";

// The flaky-blink seam: with the browser clock as the default, any test that rendered an avatar
// without installing a fake clock got REAL frames (performance.now + a 16 ms timer) mid-test, so the
// entry blink could land between a render and an assertion. Tests now default to an inert clock:
// time stands at 0 and no frame ever fires unless a test installs its own clock and drives it.
setDefaultAvatarClock(() => ({ now: () => 0, raf: () => 0, caf: () => {} }));
