/**
 * A33, the EBICS bank-channel panel on Bankkonten (spec §6). One panel below the account register that
 * carries the whole local channel lifecycle: connect (the SMPG 6.1 key ceremony, INI letter, the
 * bank-key compare-and-confirm step), Sync now (pull statements into A20), the order log, and the
 * retire/block disconnect. It BUILDS nothing on the money path: every write goes through an A24 `pay`
 * gate in the engine, and the transmit of a payment batch lives on CreditorPayments, not here.
 *
 * States as glyph+text, never colour alone (DESIGN.md): active is the one teal confirmed signal; the
 * waiting states (pending_bank_activation, keys_generated) are neutral. With no EBICS transport wired
 * the connect verb answers `needs_bank_transport` honestly and the file-based import/upload path stays
 * the visible floor, which the empty copy states.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, formatDate } from '../../i18n';
import { Skeleton, ErrorBanner } from '../../components/states';
import { Select } from '../../components/Select';
import { ActionFeedback } from '../../components/ActionFeedback';
import type { BankAccount } from './model';

interface OrderDto {
  id: string;
  orderRef: string;
  /** EBICS orders carry `orderType` (BTU/BTD/...); A37 managed orders carry `kind` instead. */
  orderType?: string;
  kind?: string;
  status: string;
  bankReason: string | null;
  occurredAt: string;
}

/** A36 §5: the keystore health facet on the status card. `kind`/`state` are open strings on the
 * wire (a host-provided keystore could name a fourth kind); the card falls back to plain text for
 * anything outside the three known values rather than rendering nothing. */
interface KeystoreDto {
  kind: string;
  state: string;
  persistent: boolean;
}

/** A36 §5: the scheduled-sync health facet, one per connection (its own linked G01 rule, if any). */
interface ScheduleDto {
  ruleId: string | null;
  enabled: boolean;
  cadence: string | null;
  lastFiredAt: string | null;
  driverSeen: boolean;
  inactive: boolean;
}

interface ChannelDto {
  connectionId: string;
  /** A37: the rail this channel rides. Absent on the wire is read as `'ebics'` (the pre-A37 shape). */
  channelKind?: string;
  /** EBICS only: the bank contract identifiers. Absent on a managed (bLink) channel. */
  host?: { hostId: string; partnerId: string; userId: string };
  /** A37 managed only: the bLink provider, bank reference, and consented scopes. */
  provider?: string;
  bankRef?: string;
  scopes?: string[];
  bankConsentExpiresAt?: string | null;
  state: string;
  accounts: { bankAccountId: string; iban: string | null }[];
  lastSyncAt: string | null;
  pendingIniLetter?: string | null;
  pendingRelease: { batchId: string | null; orderRef: string; since: string }[];
  inDoubt: { batchId: string | null; orderRef: string; since: string }[];
  rejected: { batchId: string | null; orderRef: string; reason: string | null; since: string }[];
  unmatchedFiles: { documentId: string | null; msgName: string | null; iban: string | null }[];
  recentOrders: OrderDto[];
  /** EBICS only. Absent on a managed channel (the managed rail holds no local key material). */
  keystore?: KeystoreDto;
  schedule?: ScheduleDto;
}

/** A36 §4: the static bank-directory entry the connect wizard's bank picker offers (US-A36.4). */
interface BankDirectoryEntry {
  bic: string;
  names: string[];
  hostUrl: string | null;
  hostId: string | null;
  ebicsNote: string;
  segments: string[];
  iniLetterAddress: string;
  quirks: { dateRangeSupported: boolean | null; btfNotes: string | null; protocolVersions: string[] };
  /** Structurally unverified (`verified` is always `false` on the wire): the badge renders unconditionally. */
  feeNote: { text: string; verified: false; asOf: string };
}

// Each glyph is decorative (aria-hidden): the adjacent state WORD carries the meaning, never colour
// or the glyph alone. The set is the geometric text family (○ ◐ ● –), NOT emoji: `⚠` and `⛔` default
// to an emoji presentation that renders as a colour face on macOS/Windows (and a U+FE0E text selector
// does not fix it, because the text fonts carry no glyph), which the design law bans as
// emoji-as-status. `△` (warning) and `⊘` (blocked/prohibited) are always-monochrome math symbols.
const STATE_GLYPH: Record<string, string> = {
  draft: '○',
  keys_generated: '○',
  ini_sent: '◐',
  pending_bank_activation: '◐',
  active: '●',
  bank_keys_changed: '△',
  blocked: '⊘',
  retired: '–',
  // A37 managed states.
  consent_pending: '◐',
  consent_revoked: '△',
  suspended: '⊘',
};

/** The FeedbackDialog focus-trap contract, repeated here for the keystore unlock dialog: Escape
 * closes, Tab cycles inside the panel. Two dialogs in `app/src` now share this exact shape; a third
 * would be the point to lift it into a hook, not before. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export interface EbicsChannelPanelProps {
  accounts: BankAccount[];
}

export function EbicsChannelPanel({ accounts }: EbicsChannelPanelProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canPay = useCan(CAP.pay);
  // The cadence toggle writes through TWO gates: `set_bank_sync_schedule` needs `pay` (the same
  // capability as the verb it schedules) and `create_automation_rule` needs `manage_automations`
  // (`src/core/access/actionCapabilities.ts`). Both are required to turn it on; only `pay` to turn
  // it off (unlinking never creates anything).
  const canManageAutomations = useCan(CAP.manageAutomations);

  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  // A failed `bank_channel_status` read is a DISTINCT state from a genuinely empty result. Collapsing
  // the error into `[]` made a read failure render identically to "no channel yet", with no retry: an
  // error must show the error banner (with a retry), and `channel.empty` is reserved for a true empty.
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [form, setForm] = useState({ url: '', hostId: '', partnerId: '', userId: '', bankAccountId: '' });
  // A36-U4: a stable id base so each EBICS host field carries a visible <label for>, matching the
  // managed bankRef field one form over (placeholder-only labelling is a forms defect: it vanishes
  // the moment typing starts).
  const hostFieldsId = useId();
  // A36 §4: the connect wizard's bank picker. `bankResults === null` means no lookup has resolved
  // yet (the wizard opens with an empty query, which lists the whole directory); a resolved empty
  // array is the honest no-hit state, never an error (US-A36.4: the directory is never a gate).
  const [bankQuery, setBankQuery] = useState('');
  const [bankResults, setBankResults] = useState<BankDirectoryEntry[] | null>(null);
  const [bankOpen, setBankOpen] = useState(false);
  const [bankActive, setBankActive] = useState(-1);
  const [selectedBank, setSelectedBank] = useState<BankDirectoryEntry | null>(null);
  // A36 §5: the keystore unlock prompt. `unlockOpener` is the button that opened it, so focus
  // returns there on close (WCAG 2.2, the FeedbackDialog contract).
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockOpener, setUnlockOpener] = useState<HTMLElement | null>(null);
  // A36 §5: the Automatischer Abruf toggle, per connection. Default OFF; the cadence picker only
  // matters while the toggle is being turned ON (an already-linked schedule shows its stored cadence
  // from `schedule.cadence` instead).
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
  const [scheduleCadence, setScheduleCadence] = useState<Record<string, string>>({});
  // A37: the managed (bLink) connect form. Distinct from the EBICS ceremony form: a managed connect
  // needs only a bank reference, a scope choice (PSS optional), and the account to route.
  const [managedOpen, setManagedOpen] = useState(false);
  const [managedForm, setManagedForm] = useState({ bankRef: '', pss: false, bankAccountId: '' });
  // Tearing down a live channel (which may hold the pending/in-doubt transmit orders shown just
  // above) is consequential, so it is a two-step confirm (DESIGN's forgiveness rule): the first
  // click ARMS one connection+mode, the second confirms. Per-connection and inline, never a global
  // modal. Shaped like Migration's abandonConfirm.
  const [disconnectConfirm, setDisconnectConfirm] = useState<{ connectionId: string; mode: 'block' | 'retire' } | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setChannels(null);
    setLoadError(null);
    const { body } = await client.call('bank_channel_status', { workspaceId });
    if (isErr(body)) {
      // Track the failure as an error, never as an empty list: the render shows a retry, not the
      // "connect one" empty copy.
      setLoadError(body);
      setChannels([]);
      return;
    }
    setLoadError(null);
    setChannels(((body as Record<string, unknown>).channels as ChannelDto[]) ?? []);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setNotice(null);
    const { body } = await client.call('bank_channel_connect', {
      workspaceId,
      host: { url: form.url, hostId: form.hostId, partnerId: form.partnerId, userId: form.userId },
      routeBankAccountIds: form.bankAccountId === '' ? [] : [form.bankAccountId],
      confirm: true,
      idempotencyKey: `a33-connect-${form.hostId}-${form.partnerId}-${form.userId}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setNotice(body.error);
      return;
    }
    setConnectOpen(false);
    void load();
  }, [client, workspaceId, form, load]);

  // A37: open a managed (bLink) consent. With the cloud tier off the engine returns cloud_tier, which
  // the panel renders as the honest OP4 explainer (channel.notice.cloudTier); no local lie. On success
  // the consent URL is handed to the customer's own e-banking (the hand-off announces the context
  // switch, spec §6 WCAG); a real hand-off opens the URL, here we surface it and refresh the list.
  const connectManaged = useCallback(async () => {
    if (workspaceId === null) return;
    setBusy(true);
    setNotice(null);
    const scopes = managedForm.pss ? ['ais', 'pss'] : ['ais'];
    const { body } = await client.call('bank_channel_connect', {
      workspaceId,
      channelKind: 'managed_blink',
      bankRef: managedForm.bankRef,
      scopes,
      routeBankAccountIds: managedForm.bankAccountId === '' ? [] : [managedForm.bankAccountId],
      confirm: true,
      idempotencyKey: `a37-connect-${managedForm.bankRef}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setNotice(body.error);
      return;
    }
    const consentUrl = (body as Record<string, unknown>).consentUrl;
    if (typeof consentUrl === 'string' && consentUrl.length > 0 && typeof window !== 'undefined') {
      // The consent lives at the bank: open the customer's own e-banking to grant it.
      window.open(consentUrl, '_blank', 'noopener,noreferrer');
    }
    setManagedOpen(false);
    setManagedForm({ bankRef: '', pss: false, bankAccountId: '' });
    void load();
  }, [client, workspaceId, managedForm, load]);

  // A37: advance a consent_pending managed connection (poll the relay for the grant), or reconnect a
  // consent_revoked one (a fresh consent for the same bank reference). Both go through
  // bank_channel_connect: a connectionId naming a managed row is dispatched to the managed advance.
  const advanceManaged = useCallback(
    async (channel: ChannelDto) => {
      if (workspaceId === null) return;
      setBusy(true);
      setNotice(null);
      const input: Record<string, unknown> =
        channel.state === 'consent_revoked'
          ? { workspaceId, channelKind: 'managed_blink', bankRef: channel.bankRef, scopes: channel.scopes ?? ['ais'], confirm: true, idempotencyKey: `a37-reconnect-${channel.connectionId}-${Date.now()}` }
          : { workspaceId, connectionId: channel.connectionId, confirm: true, idempotencyKey: `a37-advance-${channel.connectionId}-${Date.now()}` };
      const { body } = await client.call('bank_channel_connect', input);
      setBusy(false);
      if (isErr(body)) {
        setNotice(body.error);
        return;
      }
      const consentUrl = (body as Record<string, unknown>).consentUrl;
      if (typeof consentUrl === 'string' && consentUrl.length > 0 && typeof window !== 'undefined') {
        window.open(consentUrl, '_blank', 'noopener,noreferrer');
      }
      void load();
    },
    [client, workspaceId, load],
  );

  const confirmKeys = useCallback(
    async (connectionId: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      const { body } = await client.call('bank_channel_connect', {
        workspaceId,
        connectionId,
        confirmBankKeys: true,
        confirm: true,
        idempotencyKey: `a33-confirm-${connectionId}`,
      });
      setBusy(false);
      if (isErr(body)) setNotice(body.error);
      void load();
    },
    [client, workspaceId, load],
  );

  const sync = useCallback(
    async (connectionId: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      const { body } = await client.call('bank_sync', {
        workspaceId,
        connectionId,
        idempotencyKey: `a33-sync-${connectionId}-${Date.now()}`,
      });
      setBusy(false);
      if (isErr(body)) setNotice(body.error);
      void load();
    },
    [client, workspaceId, load],
  );

  const disconnect = useCallback(
    async (connectionId: string, mode: 'retire' | 'block') => {
      if (workspaceId === null) return;
      setBusy(true);
      const { body } = await client.call('bank_channel_disconnect', {
        workspaceId,
        connectionId,
        mode,
        confirm: true,
        idempotencyKey: `a33-${mode}-${connectionId}`,
      });
      setBusy(false);
      if (isErr(body)) setNotice(body.error);
      void load();
    },
    [client, workspaceId, load],
  );

  // A36 §4: the bank picker's own read, `bank_channel_directory`. Opens no socket (a pure lookup
  // over the in-package directory, spec §4): it runs on every keystroke, never a gate, never an
  // error state, an empty query lists the whole set.
  const queryBankDirectory = useCallback(
    async (query: string) => {
      if (workspaceId === null) return;
      const { body } = await client.call('bank_channel_directory', { workspaceId, query });
      setBankResults(isErr(body) ? [] : ((body as Record<string, unknown>).banks as BankDirectoryEntry[]) ?? []);
    },
    [client, workspaceId],
  );

  useEffect(() => {
    if (connectOpen) void queryBankDirectory('');
  }, [connectOpen, queryBankDirectory]);

  const selectBank = (bank: BankDirectoryEntry) => {
    setSelectedBank(bank);
    setBankQuery(bank.names[0] ?? bank.bic);
    setBankOpen(false);
    setBankActive(-1);
    // hostUrl/hostId are null in the v1 directory (spec §4: a bank issues them on the signed EBICS
    // contract, never guessed here), so this is a no-op today and a real prefill the day a public
    // source confirms one. Fields the bank did not supply stay exactly as the operator typed them.
    setForm((f) => ({ ...f, url: bank.hostUrl ?? f.url, hostId: bank.hostId ?? f.hostId }));
  };

  // A36 §5: there is deliberately NO MCP unlock verb (a passphrase is a human secret and never
  // travels over MCP, spec §5). This is a host-level prompt stub: a real host wires its own secure
  // prompt here (a native dialog, an OS keychain prompt) and calls the keystore's own unlock, which
  // this Studio build has no access to. The dialog below still WORKS as UI (focus trap, labelled,
  // Escape/Tab), it just has nothing real to call yet.
  // TODO(A36 host integration): replace this no-op with the host's real passphrase-unlock callback.
  const unlockKeystore = useCallback((_passphrase: string) => {
    setUnlockOpen(false);
    unlockOpener?.focus();
  }, [unlockOpener]);

  // A36 §6b: the toggle creates a G01 schedule rule whose action is `bank_sync` for this connection
  // (`create_automation_rule`, gated `manage_automations`), then links it via `set_bank_sync_schedule`
  // (gated `pay`, the same capability as the verb it schedules). Turning OFF disables the rule first
  // (so no egress keeps happening invisibly once the card stops showing it) and then unlinks.
  const toggleSchedule = useCallback(
    async (channel: ChannelDto) => {
      if (workspaceId === null) return;
      setScheduleBusy(channel.connectionId);
      setNotice(null);
      if (channel.schedule?.enabled) {
        if (channel.schedule.ruleId !== null) {
          await client.call('disable_automation_rule', { workspaceId, ruleId: channel.schedule.ruleId });
        }
        const { body } = await client.call('set_bank_sync_schedule', {
          workspaceId,
          connectionId: channel.connectionId,
          idempotencyKey: `a36-unschedule-${channel.connectionId}-${Date.now()}`,
        });
        setScheduleBusy(null);
        if (isErr(body)) setNotice(body.error);
        void load();
        return;
      }
      const cadence = scheduleCadence[channel.connectionId] ?? 'daily';
      const created = await client.call('create_automation_rule', {
        workspaceId,
        name: `EBICS Abruf ${channel.host?.hostId ?? ''}`,
        trigger: { event: `schedule.${cadence}` },
        action: { tool: 'bank_sync', inputTemplate: { connectionId: channel.connectionId } },
        enabled: true,
        idempotencyKey: `a36-schedule-rule-${channel.connectionId}-${cadence}`,
      });
      if (isErr(created.body)) {
        setScheduleBusy(null);
        setNotice(created.body.error);
        return;
      }
      const rule = (created.body as Record<string, unknown>).rule as { id?: unknown } | undefined;
      const ruleId = typeof rule?.id === 'string' ? rule.id : null;
      if (ruleId === null) {
        setScheduleBusy(null);
        setNotice('unexpected_error');
        return;
      }
      const { body } = await client.call('set_bank_sync_schedule', {
        workspaceId,
        connectionId: channel.connectionId,
        ruleId,
        idempotencyKey: `a36-schedule-${channel.connectionId}-${ruleId}`,
      });
      setScheduleBusy(null);
      if (isErr(body)) setNotice(body.error);
      void load();
    },
    [client, workspaceId, scheduleCadence, load],
  );

  if (channels === null) {
    return (
      <section className="bank-channel panel" aria-label={t('channel.title')}>
        <h2 className="bank-channel-title">{t('channel.title')}</h2>
        <Skeleton rows={2} height={24} />
      </section>
    );
  }

  return (
    <section className="bank-channel panel" aria-label={t('channel.title')}>
      <h2 className="bank-channel-title">{t('channel.title')}</h2>

      {loadError !== null && (
        <ErrorBanner error={loadError} message={noticeMessage(t, loadError.error)} onRetry={() => void load()} />
      )}
      {loadError === null && channels.length === 0 && (
        <p className="bank-channel-empty">{t('channel.empty')}</p>
      )}
      <p className="bank-channel-file-note">{t('channel.filePathNote')}</p>

      {notice !== null && (
        <ActionFeedback
          tone="info"
          role="alert"
          className="bank-channel-notice"
          message={noticeMessage(t, notice)}
        />
      )}

      <ul className="bank-channel-list">
        {channels.map((c) => {
          // A37: the managed (bLink) rail rides the SAME panel, one card kind over (spec §6). It has
          // no host, no keystore, and no schedule ceremony: its card shows the rail label, consent
          // state, and the one honest action per state.
          if ((c.channelKind ?? 'ebics') === 'managed_blink') {
            return (
              <ManagedChannelCard
                key={c.connectionId}
                channel={c}
                t={t}
                canPay={canPay}
                busy={busy}
                onSync={() => void sync(c.connectionId)}
                onAdvance={() => void advanceManaged(c)}
                onRetire={() => void disconnect(c.connectionId, 'retire')}
              />
            );
          }
          return (
          <li key={c.connectionId} className="bank-channel-item">
            <div className="bank-channel-state">
              <span aria-hidden="true">{STATE_GLYPH[c.state] ?? '○'} </span>
              <span>{t(`channel.state.${camel(c.state)}`)}</span>
              <span className="bank-channel-kind"> · {t('channel.kind.ebics')}</span>
              <span className="bank-channel-host"> {c.host?.hostId} / {c.host?.partnerId} / {c.host?.userId}</span>
            </div>
            <p className="bank-channel-accounts">
              {t('channel.sharedWith')}: {c.accounts.map((a) => a.iban ?? a.bankAccountId).join(', ')}
            </p>
            {c.lastSyncAt !== null && (
              <p className="bank-channel-lastsync" title={c.lastSyncAt}>
                {t('channel.lastSync')}: {formatDate(c.lastSyncAt)}
              </p>
            )}

            {c.keystore !== undefined && (
              <KeystoreCard
                keystore={c.keystore}
                onUnlock={(opener) => {
                  setUnlockOpener(opener);
                  setUnlockOpen(true);
                }}
              />
            )}

            {c.state === 'active' && (
              <ScheduleControl
                channel={c}
                canManage={canPay && canManageAutomations}
                busy={scheduleBusy === c.connectionId}
                cadence={scheduleCadence[c.connectionId] ?? 'daily'}
                onCadenceChange={(cadence) => setScheduleCadence((prev) => ({ ...prev, [c.connectionId]: cadence }))}
                onToggle={() => void toggleSchedule(c)}
              />
            )}

            {c.state === 'pending_bank_activation' && canPay && (
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void confirmKeys(c.connectionId)}>
                {t('channel.wizard.confirmKeys')}
              </button>
            )}
            {c.state === 'bank_keys_changed' && (
              <p className="bank-channel-warn">{t('channel.bankKeysChanged')}</p>
            )}
            {c.state === 'active' && canPay && (
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void sync(c.connectionId)}>
                {t('channel.sync')}
              </button>
            )}

            {c.unmatchedFiles.length > 0 && (
              <p className="bank-channel-unmatched" role="status">
                {t('channel.unmatchedAccount')}: {c.unmatchedFiles.map((u) => u.iban).join(', ')}
              </p>
            )}
            {c.inDoubt.length > 0 && <p className="bank-channel-indoubt">{t('channel.transmitInDoubt')}</p>}
            {c.pendingRelease.length > 0 && <p className="bank-channel-release">{t('channel.pendingRelease')}: {c.pendingRelease.length}</p>}
            {c.rejected.length > 0 && (
              <p className="bank-channel-rejected" role="alert">
                {t('channel.rejectedReason')}: {c.rejected.map((r) => r.reason).join('; ')}
              </p>
            )}

            {c.recentOrders.length > 0 && (
              <details className="bank-channel-orderlog">
                <summary>{t('channel.orderLog')}</summary>
                <ul>
                  {c.recentOrders.map((o) => (
                    <li key={o.id} title={orderRawTitle(o)}>
                      {orderActionLabel(t, o)} · {orderStatusLabel(t, o.status)} · {formatDate(o.occurredAt)}
                      {o.bankReason !== null && <span> · {o.bankReason}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {canPay && c.state !== 'retired' && (
              disconnectConfirm?.connectionId === c.connectionId ? (
                <div className="bank-channel-disconnect-confirm" role="group" aria-label={t(disconnectConfirm.mode === 'block' ? 'channel.disconnectBlock' : 'channel.disconnectRetire')}>
                  <p className="bank-channel-warn">{t(disconnectConfirm.mode === 'block' ? 'channel.disconnectBlockConfirm' : 'channel.disconnectRetireConfirm')}</p>
                  <div className="bank-channel-disconnect">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => {
                        const mode = disconnectConfirm.mode;
                        setDisconnectConfirm(null);
                        void disconnect(c.connectionId, mode);
                      }}
                    >
                      {t('channel.disconnectConfirm')}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDisconnectConfirm(null)}>
                      {t('channel.disconnectCancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bank-channel-disconnect">
                  <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setDisconnectConfirm({ connectionId: c.connectionId, mode: 'block' })}>
                    {t('channel.disconnectBlock')}
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setDisconnectConfirm({ connectionId: c.connectionId, mode: 'retire' })}>
                    {t('channel.disconnectRetire')}
                  </button>
                </div>
              )
            )}
          </li>
          );
        })}
      </ul>

      {/* K-26: one row for the two ways in. The EBICS contract is the lead (secondary, since the
          surface's one primary is "Konto hinzufügen"), the managed bLink path a quiet text link
          beside it, where they used to stack as two equal secondary buttons 16px apart. */}
      {canPay && (!connectOpen || !managedOpen) && (
        <div className="bank-channel-connect-row">
          {!connectOpen && (
            <button type="button" className="btn btn--secondary" onClick={() => setConnectOpen(true)}>
              {t('channel.connect')}
            </button>
          )}
          {!managedOpen && (
            <button type="button" className="bank-channel-link" onClick={() => setManagedOpen(true)}>
              {t('channel.managed.connect')}
            </button>
          )}
        </div>
      )}

      {canPay ? (
        connectOpen ? (
          <form
            className="bank-channel-connect"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <BankPicker
              query={bankQuery}
              results={bankResults}
              open={bankOpen}
              activeIndex={bankActive}
              onQueryChange={(q) => {
                setBankQuery(q);
                setSelectedBank(null);
                setBankOpen(true);
                void queryBankDirectory(q);
              }}
              onOpenChange={setBankOpen}
              onActiveIndexChange={setBankActive}
              onSelect={selectBank}
            />
            {selectedBank !== null && (
              <div className="bank-channel-picked" role="status">
                <p>{selectedBank.ebicsNote}</p>
                {selectedBank.quirks.btfNotes !== null && <p className="bank-channel-picked-note">{selectedBank.quirks.btfNotes}</p>}
                <p className="bank-channel-picked-note">{selectedBank.iniLetterAddress}</p>
                <p className="bank-channel-fee-badge">
                  {t('channel.bankPicker.feeUnverified')}: {selectedBank.feeNote.text}
                </p>
              </div>
            )}

            <p className="bank-channel-fieldset-label">{t('channel.wizard.accessData')}</p>
            <label htmlFor={`${hostFieldsId}-url`}>{t('channel.wizard.hostUrl')}</label>
            <input className="field" id={`${hostFieldsId}-url`} placeholder="https://ebics.bank.example" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            <label htmlFor={`${hostFieldsId}-hostId`}>{t('channel.wizard.hostId')}</label>
            <input className="field" id={`${hostFieldsId}-hostId`} placeholder="Host-ID" value={form.hostId} onChange={(e) => setForm({ ...form, hostId: e.target.value })} />
            <label htmlFor={`${hostFieldsId}-partnerId`}>{t('channel.wizard.partnerId')}</label>
            <input className="field" id={`${hostFieldsId}-partnerId`} placeholder="Partner-ID" value={form.partnerId} onChange={(e) => setForm({ ...form, partnerId: e.target.value })} />
            <label htmlFor={`${hostFieldsId}-userId`}>{t('channel.wizard.userId')}</label>
            <input className="field" id={`${hostFieldsId}-userId`} placeholder="User-ID" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} />
            <label htmlFor={`${hostFieldsId}-routeAccount`}>{t('channel.routeAccountLabel')}</label>
            <Select
              id={`${hostFieldsId}-routeAccount`}
              value={form.bankAccountId}
              onChange={(value) => setForm({ ...form, bankAccountId: value })}
              options={[
                { value: '', label: t('channel.routeAccount') },
                ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.iban})` })),
              ]}
              ariaLabel={t('channel.routeAccountLabel')}
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy || form.hostId === '' || form.partnerId === '' || form.userId === '' || form.url === ''}>
              {t('channel.connect')}
            </button>
          </form>
        ) : null
      ) : (
        <p className="bank-channel-locked">{t('channel.locked')}</p>
      )}

      {/* A37: the managed (bLink) connect path, one more path on the same panel (spec §6). With the
          cloud tier off the connect returns cloud_tier and the notice renders the OP4 explainer. */}
      {canPay &&
        (managedOpen ? (
          <form
            className="bank-channel-connect bank-channel-connect--managed"
            onSubmit={(e) => {
              e.preventDefault();
              void connectManaged();
            }}
          >
            <p className="bank-channel-managed-explainer">{t('channel.managed.formIntro')}</p>
            <label htmlFor="managed-bankref">{t('channel.managed.bankRef')}</label>
            <input
              className="field"
              id="managed-bankref"
              placeholder="blink:UBS-CH"
              value={managedForm.bankRef}
              onChange={(e) => setManagedForm({ ...managedForm, bankRef: e.target.value })}
            />
            <label htmlFor="managed-route-account">{t('channel.routeAccountLabel')}</label>
            <Select
              id="managed-route-account"
              value={managedForm.bankAccountId}
              onChange={(value) => setManagedForm({ ...managedForm, bankAccountId: value })}
              options={[
                { value: '', label: t('channel.routeAccount') },
                ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.iban})` })),
              ]}
              ariaLabel={t('channel.routeAccountLabel')}
            />
            <label className="bank-channel-scope">
              <input
                type="checkbox"
                checked={managedForm.pss}
                onChange={(e) => setManagedForm({ ...managedForm, pss: e.target.checked })}
              />
              {t('channel.managed.scopePss')}
            </label>
            <p className="bank-channel-consent-note" role="note">
              {t('channel.consent.waitingBank')}
            </p>
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy || managedForm.bankRef === ''}>
              {t('channel.managed.connect')}
            </button>
          </form>
        ) : null)}

      {unlockOpen && (
        <KeystoreUnlockDialog
          onClose={() => {
            setUnlockOpen(false);
            unlockOpener?.focus();
          }}
          onUnlock={unlockKeystore}
        />
      )}
    </section>
  );
}

/** `pending_bank_activation` -> `pendingBankActivation` for the i18n state key (spec §6 key list). */
function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * A managed bank reference reaches the wire as a machine token (`blink:UBS-CH`). No raw machine label
 * ever reaches the screen (DESIGN.md), so the card shows the human part (`UBS-CH`) and keeps the full
 * raw reference as the tooltip. The `blink:` provider is already stated by the rail label beside it.
 */
function humaniseBankRef(ref: string): string {
  const colon = ref.indexOf(':');
  const tail = colon >= 0 ? ref.slice(colon + 1) : ref;
  return tail.trim().length > 0 ? tail.trim() : ref;
}

// A36-U2: the order log renders raw BTF order codes and raw status enums; humanise them (DESIGN.md:
// "humanize machine labels, no raw snake_case/enum on screen") while keeping the raw code as the
// tooltip so nothing is lost. A host-provided code outside the known set degrades to a spaced,
// capitalised form rather than a raw enum, and is never rendered as a missing i18n key.
const KNOWN_ORDER_TYPES = new Set(['ini', 'hia', 'hpb', 'btd', 'btu', 'hac', 'spr']);
const KNOWN_ORDER_KINDS = new Set(['consent', 'status_report', 'statements', 'transmit']);
const KNOWN_ORDER_STATUS = new Set(['ok', 'failed', 'bank_rejected', 'pending_release', 'intent']);

/** snake_case or a bare enum into words, for a code no lookup covers. Never a raw enum on screen. */
function humaniseCode(code: string): string {
  const spaced = code.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? code : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The order's action label: managed orders carry `kind` (consent/statements), EBICS ones `orderType`
 * (BTD/BTU/HAC). Humanised via the lookup, or a spaced fallback for an unmapped host code. */
function orderActionLabel(t: (k: string) => string, o: OrderDto): string {
  if (o.kind !== undefined && o.kind !== null && o.kind !== '') {
    return KNOWN_ORDER_KINDS.has(o.kind) ? t(`channel.orderKind.${camel(o.kind)}`) : humaniseCode(o.kind);
  }
  const type = o.orderType ?? '';
  const lower = type.toLowerCase();
  return KNOWN_ORDER_TYPES.has(lower) ? t(`channel.orderType.${lower}`) : humaniseCode(type);
}

/** The order's status label: the known bank/transport states humanised, an unmapped one spaced out. */
function orderStatusLabel(t: (k: string) => string, status: string): string {
  return KNOWN_ORDER_STATUS.has(status) ? t(`channel.orderStatus.${camel(status)}`) : humaniseCode(status);
}

/** The raw code trail, kept as the tooltip so the exact wire values survive the humanisation. */
function orderRawTitle(o: OrderDto): string {
  return [o.kind ?? o.orderType, o.status, o.occurredAt].filter((x) => x !== undefined && x !== null).join(' · ');
}

/** A P9 code from the engine to a human message: the named ones get copy, the rest a generic line. */
function noticeMessage(t: (k: string) => string, code: string): string {
  const known = new Set([
    'no_ebics_offer',
    'needs_bank_transport',
    'channel_unreachable',
    'bank_keys_mismatch',
    'needs_confirmation',
    'permission_denied',
    // A37 managed-rail codes (spec §6).
    'cloud_tier',
    'consent_revoked',
    'consent_scope_missing',
    'format_unsupported',
    'cloud_tier_suspended',
    'already_transmitted',
  ]);
  return known.has(code) ? t(`channel.notice.${camel(code)}`) : t('channel.error.generic');
}

/**
 * A37 §6: the managed (bLink) channel card. The SAME state card as EBICS, kind-labelled, with consent
 * fields instead of the keystore/host cards. One honest action per state: advance a `consent_pending`
 * consent (or resume it), reconnect a `consent_revoked` one, sync an `active` one; retire is always
 * available. The rail label is text plus a glyph, never a colour code (spec §6, no colour-only signal).
 */
function ManagedChannelCard({
  channel: c,
  t,
  canPay,
  busy,
  onSync,
  onAdvance,
  onRetire,
}: {
  channel: ChannelDto;
  t: (k: string) => string;
  canPay: boolean;
  busy: boolean;
  onSync: () => void;
  onAdvance: () => void;
  onRetire: () => void;
}) {
  return (
    <li className="bank-channel-item bank-channel-item--managed">
      <div className="bank-channel-state">
        <span aria-hidden="true">{STATE_GLYPH[c.state] ?? '○'} </span>
        <span>{t(`channel.state.${camel(c.state)}`)}</span>
        <span className="bank-channel-kind"> · {t('channel.kind.blink')}</span>
        {c.bankRef !== undefined && c.bankRef.length > 0 && (
          <span className="bank-channel-host" title={c.bankRef}>
            {' '}
            {humaniseBankRef(c.bankRef)}
          </span>
        )}
      </div>
      <p className="bank-channel-accounts">
        {t('channel.sharedWith')}: {c.accounts.map((a) => a.iban ?? a.bankAccountId).join(', ')}
      </p>
      {c.lastSyncAt !== null && (
        <p className="bank-channel-lastsync" title={c.lastSyncAt}>
          {t('channel.lastSync')}: {formatDate(c.lastSyncAt)}
        </p>
      )}
      {c.bankConsentExpiresAt !== undefined && c.bankConsentExpiresAt !== null && (
        <p className="bank-channel-consent-expires" title={c.bankConsentExpiresAt}>
          {t('channel.consent.expires')}: {formatDate(c.bankConsentExpiresAt)}
        </p>
      )}

      {c.state === 'consent_pending' && (
        <p className="bank-channel-consent-pending" role="status">
          {t('channel.consent.pending')}. {t('channel.consent.waitingBank')}
        </p>
      )}
      {c.state === 'consent_revoked' && (
        <p className="bank-channel-consent-revoked" role="alert">
          {t('channel.consent.revoked')}
        </p>
      )}
      {c.state === 'suspended' && (
        <p className="bank-channel-suspended" role="alert">
          {t('channel.cloudTier.suspended')}
        </p>
      )}

      {c.unmatchedFiles.length > 0 && (
        <p className="bank-channel-unmatched" role="status">
          {t('channel.unmatchedAccount')}: {c.unmatchedFiles.map((u) => u.iban).join(', ')}
        </p>
      )}
      {c.inDoubt.length > 0 && <p className="bank-channel-indoubt">{t('channel.transmitInDoubt')}</p>}
      {c.pendingRelease.length > 0 && (
        <p className="bank-channel-release">
          {t('channel.pendingRelease')}: {c.pendingRelease.length} · {t('channel.releaseNoteBlink')}
        </p>
      )}
      {c.rejected.length > 0 && (
        <p className="bank-channel-rejected" role="alert">
          {t('channel.rejectedReason')}: {c.rejected.map((r) => r.reason).join('; ')}
        </p>
      )}

      {c.recentOrders.length > 0 && (
        <details className="bank-channel-orderlog">
          <summary>{t('channel.orderLog')}</summary>
          <ul>
            {c.recentOrders.map((o) => (
              <li key={o.id} title={orderRawTitle(o)}>
                {orderActionLabel(t, o)} · {orderStatusLabel(t, o.status)} · {formatDate(o.occurredAt)}
                {o.bankReason !== null && <span> · {o.bankReason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canPay && (
        <div className="bank-channel-managed-actions">
          {c.state === 'active' && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onSync}>
              {t('channel.sync')}
            </button>
          )}
          {c.state === 'consent_pending' && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onAdvance}>
              {t('channel.consent.resume')}
            </button>
          )}
          {c.state === 'consent_revoked' && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onAdvance}>
              {t('channel.managed.reconnect')}
            </button>
          )}
          {c.state !== 'retired' && (
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onRetire}>
              {t('channel.disconnectRetire')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

const KNOWN_KEYSTORE_KINDS = new Set(['memory', 'file', 'keychain']);

/**
 * A36 §5, the keystore health card: kind + state, glyph plus text (never colour alone). `locked`
 * offers the unlock prompt; `unavailable` names the two recoveries (re-initialise or restore from
 * backup, neither destroys the bank contract); a `memory` keystore carries the not-persistent notice
 * as a wizard-level heads-up, never a refusal (spec §5).
 */
function KeystoreCard({ keystore, onUnlock }: { keystore: KeystoreDto; onUnlock: (opener: HTMLElement) => void }) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const kindLabel = KNOWN_KEYSTORE_KINDS.has(keystore.kind) ? t(`channel.keystore.kind.${keystore.kind}`) : keystore.kind;
  return (
    <div className="bank-channel-keystore">
      <span className="bank-channel-keystore-title">{t('channel.keystore.title')}:</span> {kindLabel}
      {keystore.state === 'locked' && (
        <span className="bank-channel-keystore-locked">
          {' · '}
          {t('channel.keystore.locked')}{' '}
          <button
            type="button"
            ref={buttonRef}
            className="btn btn--secondary btn--sm"
            onClick={() => buttonRef.current !== null && onUnlock(buttonRef.current)}
          >
            {t('channel.keystore.unlock')}
          </button>
        </span>
      )}
      {keystore.state === 'unavailable' && (
        <p className="bank-channel-keystore-unavailable" role="alert">
          {t('channel.keystore.unavailable')}
        </p>
      )}
      {keystore.kind === 'memory' && (
        <p className="bank-channel-keystore-notice">{t('channel.keystore.notPersistent')}</p>
      )}
    </div>
  );
}

/**
 * A36 §5, the keystore unlock prompt. The passphrase is a HUMAN secret entered here and NEVER
 * travels over MCP: there is deliberately no unlock verb, so this is a host-level prompt stub the
 * real host replaces (see the TODO on `unlockKeystore` in the panel above). The dialog contract
 * itself (labelled, modal, focus-trapped, Escape closes, Tab cycles, focus returns to the opener) is
 * real and copied from `FeedbackDialog`, the one other modal in this Studio.
 */
function KeystoreUnlockDialog({ onClose, onUnlock }: { onClose: () => void; onUnlock: (passphrase: string) => void }) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusablesIn(node);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="bank-channel-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        className="bank-channel-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{t('channel.keystore.unlock')}</h2>
        <label>
          {t('channel.keystore.unlock')}
          <input
            className="field"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>
        <div className="bank-channel-dialog-actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('bank.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={passphrase === ''} onClick={() => onUnlock(passphrase)}>
            {t('channel.keystore.unlock')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A36 §5, the Automatischer Abruf toggle: OFF by default. Turning it on states, in words, that it is
 * SCHEDULED NETWORK EGRESS from a stored rule (the egress-honesty copy the spec requires verbatim in
 * spirit); `schedule.inactive` (enabled but no tick driver seen in the last 25h) names the M00 local
 * scheduler daemon and Sync now as the two ways a schedule actually fires.
 */
function ScheduleControl({
  channel,
  canManage,
  busy,
  cadence,
  onCadenceChange,
  onToggle,
}: {
  channel: ChannelDto;
  canManage: boolean;
  busy: boolean;
  cadence: string;
  onCadenceChange: (cadence: string) => void;
  onToggle: () => void;
}) {
  const t = useT();
  const { schedule } = channel;
  // ScheduleControl is rendered only for an active EBICS channel, which always carries a schedule
  // facet; the guard narrows the optional type (a managed channel never reaches here).
  if (schedule === undefined) return null;
  return (
    <div className="bank-channel-schedule">
      <label className="bank-channel-schedule-toggle">
        <input
          type="checkbox"
          checked={schedule.enabled}
          disabled={!canManage || busy}
          title={canManage ? undefined : t('channel.locked')}
          aria-describedby={canManage ? undefined : `schedule-denied-${channel.connectionId}`}
          onChange={onToggle}
        />
        {t('channel.schedule.title')}
      </label>
      {!canManage && (
        <p id={`schedule-denied-${channel.connectionId}`} className="bank-channel-locked">
          {t('channel.locked')}
        </p>
      )}
      {!schedule.enabled && (
        <Select
          ariaLabel={t('channel.schedule.cadence')}
          value={cadence}
          disabled={!canManage || busy}
          onChange={onCadenceChange}
          options={[
            { value: 'daily', label: t('channel.schedule.cadenceOption.daily') },
            { value: 'weekly', label: t('channel.schedule.cadenceOption.weekly') },
            { value: 'monthly', label: t('channel.schedule.cadenceOption.monthly') },
          ]}
        />
      )}
      <p className="bank-channel-schedule-note">{t('channel.schedule.egressNote')}</p>
      {schedule.enabled && schedule.cadence !== null && (
        <p className="bank-channel-schedule-cadence">
          {t('channel.schedule.cadence')}: {t(`channel.schedule.cadenceOption.${cadenceKey(schedule.cadence)}`)}
        </p>
      )}
      {schedule.lastFiredAt !== null && (
        <p className="bank-channel-schedule-lastfired" title={schedule.lastFiredAt}>
          {t('channel.schedule.lastFired')}: {formatDate(schedule.lastFiredAt)}
        </p>
      )}
      {schedule.inactive && (
        <p className="bank-channel-schedule-inactive" role="alert">
          {t('channel.schedule.inactive')}
        </p>
      )}
    </div>
  );
}

/** `schedule.daily` (the G01 trigger event) -> `daily` (the cadence option key). */
function cadenceKey(triggerEvent: string): string {
  return triggerEvent.startsWith('schedule.') ? triggerEvent.slice('schedule.'.length) : triggerEvent;
}

/**
 * A36 §4, the connect wizard's bank picker: a full ARIA 1.2 combobox (role="combobox" on the input,
 * a separate `role="listbox"`, `aria-activedescendant` tracking the highlighted option), so the
 * whole thing works from the keyboard alone (WCAG 2.2 AA). An empty query lists the whole directory;
 * a no-hit query renders the honest empty state and the manual host fields below stay visible either
 * way (US-A36.4: the directory is never a dead end).
 */
function BankPicker({
  query,
  results,
  open,
  activeIndex,
  onQueryChange,
  onOpenChange,
  onActiveIndexChange,
  onSelect,
}: {
  query: string;
  results: BankDirectoryEntry[] | null;
  open: boolean;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onOpenChange: (open: boolean) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (bank: BankDirectoryEntry) => void;
}) {
  const t = useT();
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (results === null || results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      onOpenChange(true);
      onActiveIndexChange(activeIndex < results.length - 1 ? activeIndex + 1 : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      onOpenChange(true);
      onActiveIndexChange(activeIndex > 0 ? activeIndex - 1 : results.length - 1);
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && activeIndex < results.length) {
        event.preventDefault();
        onSelect(results[activeIndex] as BankDirectoryEntry);
      }
    } else if (event.key === 'Escape') {
      onOpenChange(false);
    }
  };

  return (
    <div className="bank-channel-picker">
      <label htmlFor="bank-picker-input">{t('channel.bankPicker.label')}</label>
      <input
        className="field"
        id="bank-picker-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={() => onOpenChange(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listboxId} role="listbox" aria-label={t('channel.bankPicker.label')} className="bank-channel-picker-list">
          {results === null && <li className="bank-channel-picker-loading">{t('states.loading.label')}</li>}
          {results !== null && results.length === 0 && (
            <li className="bank-channel-picker-empty">{t('channel.bankPicker.empty')}</li>
          )}
          {results !== null &&
            results.map((bank, index) => (
              <li
                key={bank.bic}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'bank-channel-picker-option bank-channel-picker-option--active' : 'bank-channel-picker-option'}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => onSelect(bank)}
              >
                {bank.names[0] ?? bank.bic} <span className="bank-channel-picker-bic">{bank.bic}</span>
                <span className="bank-channel-fee-badge">{t('channel.bankPicker.feeUnverified')}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
