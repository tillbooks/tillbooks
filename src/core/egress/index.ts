/**
 * E07, the offline proof & the honest threat model: the barrel `src/api/` imports from.
 *
 * The two verbs (`egressSelfTest`, `egressStatus`) are the MCP surface; the probe is exported for
 * the non-vacuity test (which plants a deliberate offender on each vector); the monitor's read model
 * and its test seams feed `egress_status` and its component test; the `EGRESS_STATE` enum is the one
 * §H-ENUM point. Importing this barrel installs the standing egress monitor as a side effect (see
 * `monitor.ts`), which is why the registry that loads it observes egress from process start.
 */

export { egressSelfTest, egressStatus } from './egress.js';
export { installEgressProbe } from './probe.js';
export type { EgressKind, EgressViolation, InstalledProbe, ProbeOptions } from './probe.js';
export {
  ensureEgressMonitor,
  observedEgress,
  observedOffenders,
  resetEgressMonitorForTests,
  forceEgressMonitorForTests,
} from './monitor.js';
export { EGRESS_STATES, isEgressState } from './enums.js';
export type { EgressState } from './enums.js';
