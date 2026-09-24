/**
 * M00 first-run flow entry point, wired at `/first-run` in `router.tsx`.
 *
 * This is the resolver for the pre-workspace dead end (spec §6): the three doors (create / restore /
 * adopt) plus the runtime line. `RuntimeLine` is exported by name so the E07 Vertrauen panel can
 * adopt it in the D46 UX pass without importing the whole surface.
 */
export { FirstRun, default } from './FirstRun';
export { RuntimeLine } from './RuntimeLine';
