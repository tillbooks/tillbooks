/**
 * M00: the per-process DELIVERY runtime state, and the single source of the `delivery_status.mode`
 * enum.
 *
 * WHY A SINGLETON AND NOT A ROW. `delivery_status` reports facts about the PROCESS a caller is
 * talking to, not about any tenant: which entry point started it (`till up` / `till serve` /
 * `till mcp` / an agent session), which loopback address it bound, whether it is serving the built
 * Studio, and whether an in-process scheduler tick is alive. None of that is ledger data, so putting
 * it in the tenant database would be a category error (it would ride into a G04 backup and travel to
 * a different machine, where it would be a lie). It lives in module memory, set by whichever host
 * booted the process, and is reset only by that process ending.
 *
 * WHY THE NAME IS `delivery_status` AND NOT `runtime_status`. E05 (voice / OP6 local inference)
 * already owns `runtime_status`, which reports and selects which local LLM runs the drafting engine.
 * That is a workspace-scoped MODEL runtime; this is the pre-workspace DELIVERY process. Two different
 * things, and the registry's unique-name rule forbids one name for both, so M00's verb is
 * `delivery_status`. See the reconciliation banner in `docs/specs/specs/M00-packaged-local-delivery.md`.
 */

/** How this process was started. The §H-ENUM enum M00 owns, single-sourced here. */
export type DeliveryMode = 'up' | 'mcp' | 'serve' | 'agent_session';

/** Every legal mode, for validation and for the Studio's exhaustive rendering. */
export const DELIVERY_MODES: readonly DeliveryMode[] = ['up', 'mcp', 'serve', 'agent_session'];

/** The env flag that declares an agent-session runtime. NEVER guessed: only this exact value opts in. */
export const RUNTIME_MODE_ENV = 'TILL_RUNTIME_MODE';

/** The version string every face reports. Kept beside the mode so the two travel together. */
export const TILL_VERSION = '0.0.0';

/** The scheduler's observable state (US-M00.4). All three fields are honest when no tick runs. */
export interface SchedulerStatus {
  /** True only while an in-process tick is armed (i.e. under `till up`). */
  enabled: boolean;
  /** ISO instant of the last tick, or null before the first one. */
  lastTickAt: string | null;
  /** ISO instant the next tick is expected, or null when the scheduler is off. */
  nextTickAt: string | null;
}

/** The whole process snapshot `delivery_status` serialises (minus the store-derived generation). */
export interface DeliveryRuntime {
  mode: DeliveryMode;
  /** The bound loopback host, or null when nothing is listening (a bare `till mcp` over stdio). */
  host: string | null;
  /** The bound port, or null when nothing is listening. */
  port: number | null;
  /** Whether the built Studio is served from this process (`till up` only). */
  studioServed: boolean;
  scheduler: SchedulerStatus;
}

/**
 * The default mode when no host has set one. A bare `till mcp` over stdio is `mcp`, UNLESS the
 * operator declared an agent session with `TILL_RUNTIME_MODE=agent_session` (the run-inside-agent
 * mode, US-M00.6). Only that exact value opts in; anything else, including a typo, stays `mcp`, so
 * the residency caveat is never claimed by accident.
 */
function defaultMode(env: NodeJS.ProcessEnv = process.env): DeliveryMode {
  return env[RUNTIME_MODE_ENV]?.trim() === 'agent_session' ? 'agent_session' : 'mcp';
}

function initialState(): DeliveryRuntime {
  return {
    mode: defaultMode(),
    host: null,
    port: null,
    studioServed: false,
    scheduler: { enabled: false, lastTickAt: null, nextTickAt: null },
  };
}

let state: DeliveryRuntime = initialState();

/** Declare the process mode and its bound listener (called by `till up` and `till serve`). */
export function setDeliveryRuntime(patch: {
  mode: DeliveryMode;
  host?: string | null;
  port?: number | null;
  studioServed?: boolean;
}): void {
  state = {
    ...state,
    mode: patch.mode,
    ...(patch.host !== undefined ? { host: patch.host } : {}),
    ...(patch.port !== undefined ? { port: patch.port } : {}),
    ...(patch.studioServed !== undefined ? { studioServed: patch.studioServed } : {}),
  };
}

/** Report the scheduler's observable state. The tick calls this after every fire. */
export function setSchedulerStatus(scheduler: SchedulerStatus): void {
  state = { ...state, scheduler };
}

/** A read-only snapshot of the current process state. */
export function getDeliveryRuntime(): DeliveryRuntime {
  return { ...state, scheduler: { ...state.scheduler } };
}

/** Reset to the boot default. For tests, so one suite's mode never leaks into the next. */
export function resetDeliveryRuntime(): void {
  state = initialState();
}
