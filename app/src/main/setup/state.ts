// Portable install: the setup state machine lives in @synapse/shared (setup-state.ts), so the setup screen and
// the Mac side run the same code. Re-exported here for the main-process modules and their tests.
export { setupView } from "@synapse/shared";
export type { BoxReport, OrbReport, SetupInput, SetupStepId, SetupStepState, SetupView } from "@synapse/shared";
