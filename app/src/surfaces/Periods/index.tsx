/**
 * Public entry point for the A03 Periods surface. The orchestrator wires this default export at the
 * `/periods` route (one line in `router.tsx`, no other shared-file edits). Named exports are for tests.
 */
export { Periods, default } from './Periods';
export { AuditPanel } from './AuditPanel';
