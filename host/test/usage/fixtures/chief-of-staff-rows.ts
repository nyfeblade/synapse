/** Chief of Staff (4e04d6af…) as the live box's usage.db recorded it before the per-run fix (copied 2026-09-21):
 *  30 turn rows whose costUsd is the SDK's RUNNING total for the session (0.12 → 7.71), so the Usage view
 *  summed them to $97.77. Numbers only, no content.
 *  [startedAt, source, status, model, durationMs, input, output, cacheRead, cacheWrite, costUsd] */
export type LegacyRow = [number, string, string, string, number, number, number, number, number, number];

export const CHIEF_OF_STAFF_ID = "4e04d6af-4606-4e05-b27b-fa32e187c127";
/** The live box's weekly window: kv `weekly.resetsAt`. */
export const LIVE_WEEKLY_RESET = 1790542800000;

export const CHIEF_OF_STAFF_ROWS: LegacyRow[] = [
  [1789859994514, "kickstart", "ok", "claude-sonnet-5", 6016, 4, 110, 28524, 28665, 0.12259679999999999],
  [1789860001720, "user", "ok", "claude-sonnet-5", 3828, 4, 85, 57460, 247, 0.1359348],
  [1789860009878, "user", "ok", "claude-sonnet-5", 4888, 4, 151, 57958, 305, 0.1502644],
  [1789860023525, "user", "ok", "claude-sonnet-5", 13821, 6, 457, 88416, 730, 0.17544959999999998],
  [1789926889073, "user", "ok", "claude-sonnet-5", 9679, 6, 183, 124729, 62624, 0.4527334],
  [1789926930024, "user", "ok", "claude-sonnet-5", 20954, 8, 223, 434230, 145937, 1.1255734],
  [1789932585543, "user", "ok", "claude-sonnet-5", 8601, 4, 100, 145472, 145587, 1.8057998],
  [1789932596864, "user", "ok", "claude-sonnet-5", 4605, 4, 74, 291357, 298, 1.8660112],
  [1789932603509, "user", "ok", "claude-sonnet-5", 6243, 4, 199, 291933, 396, 1.9279798000000001],
  [1789932619440, "user", "ok", "claude-sonnet-5", 5329, 4, 86, 292731, 289, 1.98855],
  [1789932635827, "user", "ok", "claude-sonnet-5", 6842, 4, 187, 293306, 388, 2.0506412000000003],
  [1789932698686, "user", "ok", "claude-sonnet-5", 6149, 4, 156, 285336, 5451, 2.1964864000000004],
  [1789932708787, "user", "ok", "claude-sonnet-5", 13521, 8, 590, 583870, 1191, 2.3239404000000006],
  [1789932732468, "agent", "ok", "claude-sonnet-5", 8441, 4, 277, 293864, 806, 2.3887152000000009],
  [1789932776241, "user", "ok", "claude-sonnet-5", 6878, 4, 142, 295145, 364, 2.450628200000001],
  [1789932934767, "user", "ok", "claude-sonnet-5", 14617, 6, 609, 313150, 157290, 3.1843648000000009],
  [1789933214482, "user", "ok", "claude-sonnet-5", 30436, 8, 1473, 625327, 10453, 3.4244443000000007],
  [1789935027875, "user", "ok", "claude-sonnet-5", 9674, 4, 243, 307242, 7131, 3.6138108000000004],
  [1789936343752, "user", "aborted", "claude-sonnet-5", 3918, 0, 0, 0, 0, 3.6851418000000003],
  [1789936347685, "user", "ok", "claude-sonnet-5", 9678, 6, 239, 465195, 4631, 3.7991068000000006],
  [1789936363477, "user", "aborted", "claude-sonnet-5", 4449, 2, 61, 156778, 163, 3.8317284000000007],
  [1789936367941, "user", "ok", "claude-sonnet-5", 16551, 8, 247, 629249, 873, 3.9635562000000006],
  [1789946620370, "user", "ok", "claude-sonnet-5[1m]", 11968, 6, 257, 314285, 157386, 4.7375352],
  [1789947098333, "user", "ok", "claude-sonnet-5[1m]", 23981, 10, 245, 708851, 177910, 5.5934154000000005],
  [1789994546540, "user", "ok", "claude-sonnet-5[1m]", 11936, 4, 234, 178266, 178530, 6.3455366],
  [1789994562631, "user", "ok", "claude-sonnet-5[1m]", 5505, 4, 87, 357262, 327, 6.419175],
  [1789997825005, "user", "ok", "claude-sonnet-5[1m]", 19669, 6, 727, 538424, 2032, 6.5643578000000007],
  [1789997968481, "user", "ok", "claude-sonnet-5[1m]", 44551, 12, 2107, 1096255, 5552, 6.8269108],
  [1789998021153, "user", "ok", "claude-sonnet-5[1m]", 10991, 4, 531, 373126, 903, 6.910466],
  [1789998056486, "agent", "ok", "claude-sonnet-5[1m]", 11005, 4, 404, 188159, 188578, 7.7064578000000008],
];
