/**
 * Map an `env_*` engine rejection to one of the surface's own localized sentences. Every branch is a
 * key under `env.error.*` in both locale catalogues; the fallback is the generic "nothing changed"
 * line, never a raw error code. Kept out of the components so the list surface and all four dialogs
 * explain the same rejection the same way (one design language, canon check section 8).
 */
import type { Err } from '../../lib/client';

export interface EnvErrorMessage {
  key: string;
  params: Record<string, string>;
}

/** A string field off the open rejection body, or '' when absent (the payloads are host-level, open). */
function str(err: Err, field: string): string {
  const value = (err as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function envErrorMessage(err: Err): EnvErrorMessage {
  switch (err.error) {
    case 'environment_protected':
      return { key: 'env.error.environment_protected', params: { name: str(err, 'name') } };
    case 'standard_tier':
      return { key: 'env.error.standard_tier', params: { name: str(err, 'name') } };
    case 'environment_active':
      return { key: 'env.error.environment_active', params: { name: str(err, 'name') } };
    case 'environment_exists':
      return { key: 'env.error.environment_exists', params: { name: str(err, 'name') } };
    case 'environment_not_found':
      return { key: 'env.error.environment_not_found', params: {} };
    case 'active_environment_missing':
      return { key: 'env.error.environment_not_found', params: {} };
    case 'data_root_is_main':
      return { key: 'env.error.data_root_is_main', params: {} };
    case 'data_root_collision':
      return { key: 'env.error.data_root_collision', params: { collidesWith: str(err, 'collidesWith') } };
    // E1a: the source (typically served main) could not be reached to snapshot it.
    case 'source_unreachable':
      return { key: 'env.error.source_unreachable', params: { source: str(err, 'source') } };
    // E8a: a mandate-scoped copy named a workspace the source does not hold.
    case 'mandate_not_found':
      return { key: 'env.error.mandate_not_found', params: { mandate: str(err, 'mandate') } };
    // E1c / E7: a copy resolved its target to main.
    case 'target_is_main':
      return { key: 'env.error.target_is_main', params: {} };
    case 'unknown_seed':
      return { key: 'env.error.unknown_seed', params: {} };
    case 'seed_failed':
      return { key: 'env.error.seed_failed', params: { phase: str(err, 'phase') } };
    case 'phase_b_not_implemented':
      return { key: 'env.error.phase_b_not_implemented', params: {} };
    // The build-then-swap refused to put a new ledger in place (the prior one is untouched). When the
    // target is open in another process the fix is specific, so it gets its own sentence.
    case 'swap_refused':
    case 'copy_swap_refused':
      return str(err, 'reason') === 'target_in_use'
        ? { key: 'env.error.target_in_use', params: { name: str(err, 'target') || str(err, 'name') } }
        : { key: 'env.error.swap_refused', params: {} };
    // A mandate copy into an environment whose ledger file is gone: rebuild first.
    case 'target_data_missing':
      return { key: 'env.error.target_data_missing', params: { name: str(err, 'target') } };
    // The copy's final invariant or privacy gate refused the build; the target is unchanged.
    case 'copy_gate_failed':
      return { key: 'env.error.copy_gate_failed', params: {} };
    case 'landscape_integrity_failed':
      return { key: 'env.integrityError', params: {} };
    case 'invalid_input':
      return { key: 'env.error.invalid_input', params: {} };
    default:
      return { key: 'env.error.generic', params: {} };
  }
}
