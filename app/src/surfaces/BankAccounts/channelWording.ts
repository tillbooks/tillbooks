/**
 * A36 §5: the ONE wording of an EBICS channel refusal, shared by the channel panel on /bank-accounts and
 * the "Kontoauszüge abrufen" button on /bank, so both say the same sentence for the same code. It goes
 * through `refusalText` (the one path from an engine refusal to a sentence, critic R5-1): the channel's
 * own sentences where it has them, else the shared catalogue, else the channel's generic line.
 */
import { refusalText } from '../../components/states';
import type { Err } from '../../lib/client';

/**
 * A number jump (§4.4 rule 2, critic A36C-1): the statement before it, the one that jumped, and the
 * skipped numbers. `bank_sync` answers one per jumping import (`notice: 'statement_number_jump'`),
 * `bank_channel_status` the last one per routed account (`lastNumberJump`).
 */
export interface NumberJump {
  after: { number: number; year: number };
  statement: { number: number; year: number };
  skipped: { year: number; from: number; to: number }[];
}

/** "Nach Auszug 1 kam Auszug 3. Fehlende Nummern: 2/2026. ...": the ONE sentence for a jump. */
export function numberJumpText(t: (k: string, p?: Record<string, string | number>) => string, jump: NumberJump): string {
  const skipped = jump.skipped.map((r) => (r.from === r.to ? `${r.from}/${r.year}` : `${r.from}–${r.to}/${r.year}`)).join(', ');
  return t('channel.feed.numberJump', { m: jump.after.number, n: jump.statement.number, skipped });
}

/** The jumps a `bank_sync` answer names, in its statement order. */
export function jumpsOfSync(statements: readonly { notice?: unknown; jump?: unknown }[]): NumberJump[] {
  return statements.filter((x) => x.notice === 'statement_number_jump' && x.jump !== undefined && x.jump !== null).map((x) => x.jump as NumberJump);
}

/** The channel's own wording per engine code; every other code falls through to the shared catalogue. */
export const CHANNEL_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  needs_bank_transport: 'channel.notice.needsBankTransport',
  channel_unreachable: 'channel.notice.channelUnreachable',
  bank_keys_mismatch: 'channel.notice.bankKeysMismatch',
  bank_keys_changed: 'channel.notice.bankKeysChanged',
  needs_confirmation: 'channel.notice.needsConfirmation',
  permission_denied: 'channel.notice.permissionDenied',
  unsupported_ebics_version: 'channel.notice.unsupportedEbicsVersion',
  live_connection_exists: 'channel.notice.liveConnectionExists',
  camt054_lines_refused: 'channel.notice.camt054LinesRefused',
  trial_workspace_refused: 'channel.notice.trialWorkspaceRefused',
  untrusted_response: 'channel.notice.untrustedResponse',
  commit_failed: 'channel.notice.commitFailed',
  keystore_changed_elsewhere: 'channel.notice.keystoreChangedElsewhere',
  keystore_locked: 'channel.notice.keystoreLocked',
  keystore_unavailable: 'channel.notice.keystoreUnavailable',
  pending_bank_activation: 'channel.notice.pendingBankActivation',
  channel_blocked: 'channel.notice.channelBlocked',
  channel_retired: 'channel.notice.channelRetired',
  no_routed_account: 'channel.notice.noRoutedAccount',
  unsupported_date_range: 'channel.notice.unsupportedDateRange',
  init_refused: 'channel.notice.initRefused',
  certificate_refused: 'channel.notice.certificateRefused',
  key_exchange_refused: 'channel.notice.keyExchangeRefused',
  // A37 managed-rail codes (spec §6).
  cloud_tier: 'channel.notice.cloudTier',
  consent_revoked: 'channel.notice.consentRevoked',
  consent_scope_missing: 'channel.notice.consentScopeMissing',
  format_unsupported: 'channel.notice.formatUnsupported',
  cloud_tier_suspended: 'channel.notice.cloudTierSuspended',
  already_transmitted: 'channel.notice.alreadyTransmitted',
};

/** The §4.3 table: a `download_refused` names its class, each with its own sentence and the raw code. */
export const DOWNLOAD_REFUSED_KEYS: Readonly<Record<string, string>> = {
  not_granted: 'channel.downloadRefused.notGranted',
  busy: 'channel.downloadRefused.busy',
  too_large: 'channel.downloadRefused.tooLarge',
  other: 'channel.downloadRefused.other',
};

/** An engine refusal on the channel, worded through the one path (`refusalText`). */
export function channelRefusal(t: (k: string, p?: Record<string, string | number>) => string, error: Err): string {
  const e = error as Err & { kind?: unknown; code?: unknown };
  const kind = typeof e.kind === 'string' ? e.kind : 'other';
  const code = typeof e.code === 'string' ? e.code : '';
  return refusalText(t, error, {
    keys: { ...CHANNEL_REFUSAL_KEYS, download_refused: DOWNLOAD_REFUSED_KEYS[kind] ?? 'channel.downloadRefused.other' },
    params: { code },
    fallback: 'channel.error.generic',
  });
}
