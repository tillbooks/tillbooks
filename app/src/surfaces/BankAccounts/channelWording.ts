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

/** The EBICS return codes TILL words by name (EBICS 3.0 Annex 1; A36 §4.3); every other code is "Code {code}". */
export const KNOWN_RETURN_CODES: readonly string[] = ['090005', '090003', '091005', '091006', '091008', '091117', '091119'];

/**
 * A36 §4.7 (D150): the bank's own reason in words, from the raw return code an automatic attempt kept
 * (`detail.code`) or, for a bank that did not answer, the wire's reason (`detail.bankReason`). One
 * sentence per known code, "Die Bank meldet Code {code}." for any other; null when there is neither.
 */
export function returnCodeText(
  t: (k: string, p?: Record<string, string | number>) => string,
  detail: { code?: unknown; bankReason?: unknown } | null | undefined,
): string | null {
  const code = typeof detail?.code === 'string' && detail.code.length > 0 ? detail.code : null;
  if (code !== null) return KNOWN_RETURN_CODES.includes(code) ? t(`channel.returnCode.${code}`) : t('channel.returnCode.other', { code });
  const reason = typeof detail?.bankReason === 'string' && detail.bankReason.length > 0 ? detail.bankReason : null;
  return reason === null ? null : t('channel.returnCode.unreachable', { reason });
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
  // D142: one fetch per connection at a time; the press arrived while another ran.
  sync_in_progress: 'channel.notice.syncInProgress',
  // D142 critic F1: the automatic fetch found no seated person holding `pay` to run as.
  auto_sync_no_actor: 'channel.notice.autoSyncNoActor',
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

/** An instant as the Swiss wall-clock time ("07:02"), or '' when the engine sent none. */
function swissTime(instant: unknown): string {
  if (typeof instant !== 'string' || Number.isNaN(Date.parse(instant))) return '';
  return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

/** D143 critic LB-1: the `auto_sync_no_actor` sentence per schedule setter; a person keeps the two-party default. */
const NO_ACTOR_KEYS: ReadonlyMap<string, string> = new Map([
  ['none', 'channel.notice.autoSyncNoActorUnset'],
  ['owner', 'channel.notice.autoSyncNoActorOwner'],
  ['agent', 'channel.notice.autoSyncNoActorAgent'],
]);

/** An engine refusal on the channel, worded through the one path (`refusalText`). */
export function channelRefusal(t: (k: string, p?: Record<string, string | number>) => string, error: Err): string {
  const e = error as Err & { kind?: unknown; code?: unknown; syncStartedAt?: unknown; freesAt?: unknown; setterKnown?: unknown; scheduleSetter?: unknown };
  const kind = typeof e.kind === 'string' ? e.kind : 'other';
  const code = typeof e.code === 'string' ? e.code : '';
  // D142 critic R3-2, D143 critic LB-1: `auto_sync_no_actor` is worded by the actors actually tried.
  // The caller passes the channel's `autoSync.scheduleSetter` (an older engine: only `setterKnown`).
  // Only a person setter makes it two parties; nobody, the owner and an agent (never tried) leave the
  // owner alone. Without either field the sentence names both.
  const setter = typeof e.scheduleSetter === 'string' ? e.scheduleSetter : e.setterKnown === false ? 'none' : undefined;
  const setterKey = setter === undefined ? undefined : NO_ACTOR_KEYS.get(setter);
  const noSetter: Record<string, string> = setterKey !== undefined ? { auto_sync_no_actor: setterKey } : {};
  return refusalText(t, error, {
    keys: { ...CHANNEL_REFUSAL_KEYS, ...noSetter, download_refused: DOWNLOAD_REFUSED_KEYS[kind] ?? 'channel.downloadRefused.other' },
    // D142 critic F2: `sync_in_progress` says when the running mark was set and when it frees itself.
    params: { code, started: swissTime(e.syncStartedAt), frees: swissTime(e.freesAt) },
    fallback: 'channel.error.generic',
  });
}
