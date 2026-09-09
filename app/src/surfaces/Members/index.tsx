/**
 * Public entry point for the A24 Zugriff surface. The orchestrator wires this default export at the
 * `/members` route (one line in `router.tsx`, no other shared-file edits). Named exports are for tests.
 */
export { Members, default } from './Members';
