/**
 * Public entry point for the A02 Journal surface. The orchestrator wires this default export at the
 * `/journal` route (one line, no other shared-file edits). Named exports are for tests.
 */
export { Journal, default } from './Journal';
export { EntryDrawer } from './EntryDrawer';
export type { EntryDrawerProps } from './EntryDrawer';
