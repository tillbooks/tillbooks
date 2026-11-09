/**
 * Public entry point for the G03 onboarding surface, wired at `/onboarding` in `router.tsx`.
 * `DemoBanner` is exported for the Shell, which renders it above every surface while the current
 * workspace is a demo (spec §6; the D89 WorkspaceModeBanner treatment).
 */
export { Onboarding, default } from './Onboarding';
export { DemoBanner } from './DemoBanner';
