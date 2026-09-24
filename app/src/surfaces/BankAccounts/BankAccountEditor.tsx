/**
 * B-S2, the BankAccountEditor drawer, and B-S4, the verknüpftes-Konto picker inside it.
 *
 * A RIGHT-SIDE DRAWER, not a centred modal and not a route, matching `PaymentAllocator` and
 * `AccountDrawer`. The register behind it stays on screen, which matters exactly when the thing you
 * are checking is whether this IBAN is already in the list.
 *
 * EDIT IN PLACE, AND THE FROZEN FIELDS ARE SHOWN RATHER THAN HIDDEN (B14). Once `openingEntryId` is
 * set the engine freezes IBAN, Währung and verknüpftes Konto, and the canon's "prevent at the
 * control" rule and DESIGN.md's permission rule agree on the treatment: those three render read-only
 * WITH a visible reason, and Speichern stays enabled because the name is still editable for good.
 * Hiding them would be worse: an operator who came to check an IBAN would find the field gone and
 * conclude the data was lost. `account_in_use` therefore becomes unreachable from the GUI.
 *
 * THE PICKER OFFERS ONLY WHAT THE ENGINE WILL ACCEPT. `resolveLedgerAccount` requires an account
 * that exists in this workspace, is type `asset` and is not archived, so the picker filters to
 * exactly that set and `unusable` and `not_an_asset_account` cannot be produced from the GUI at all.
 *
 * B7 IS A DERIVED EMPTY STATE, NOT AN ENGINE REJECTION. A chart with no asset account produces no
 * error whatsoever: `needs_ledger_account {reason:'missing'}` fires when no id was SUPPLIED, which in
 * a GUI is an ordinary required-field validation. So the unseeded chart is derived client-side from
 * `list_accounts` returning no usable asset row, and the picker renders a banner CTA BEFORE any Save
 * is attempted rather than after a rejection. The rest of the editor stays readable and every typed
 * value survives.
 *
 * `duplicate_iban` NAMES THE ACCOUNT, NOT THE ID (B4). The engine returns `{ iban }`, so the drawer
 * resolves the name from the register it already holds. Resolving a name from a list in hand is not
 * arithmetic on money, which is the line this surface does not cross.
 *
 * THE STALE DEEP LINK (C14). `?account=<id>` is addressable and shareable, so it can outlive its row.
 * `get_bank_account` answers `bank_account_not_found`, and the drawer says what is missing and offers
 * the way back. It does NOT silently open an empty create form, which would invite the operator to
 * re-enter an account they think already exists.
 *
 * ONE LABEL TRAP, PINNED. A14's `bankAccountId` means the LEDGER account money moved on; A19's means
 * a register row. On screen this drawer says Bankkonto for its own object and Verknüpftes Konto for
 * the chart account, and never uses either raw field name.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { Select } from '../../components/Select';
import { HelpHint } from '../../components/HelpHint';
import { BankDrawer } from './BankDrawer';
import { OpeningBalanceStep } from './OpeningBalanceStep';
import {
  assetAccounts,
  groupIban,
  ibanErrorKey,
  looksLikeQrIban,
  normalizeIban,
  openingAccountId,
  openingAccountState,
  parseChart,
  parseOneBankAccount,
  type BankAccount,
  type ChartAccount,
} from './model';

/** The currencies the engine admits, mirrored so the picker offers no code it would then refuse. */
const CURRENCIES = ['CHF', 'EUR', 'USD'] as const;

export interface BankAccountEditorProps {
  /** The row being edited, or null for create mode. */
  accountId: string | null;
  /** Every registered account, so a duplicate IBAN can be named rather than echoed as a number. */
  register: readonly BankAccount[];
  baseCurrency: string;
  onClose: () => void;
  /** Called after any write, so the list re-reads and the row updates with no navigation. */
  onSaved: () => void;
}

export function BankAccountEditor({
  accountId,
  register,
  baseCurrency,
  onClose,
  onSaved,
}: BankAccountEditorProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [name, setName] = useState('');
  const [iban, setIban] = useState('');
  const [currency, setCurrency] = useState<string>('CHF');
  const [ledgerAccountId, setLedgerAccountId] = useState('');

  const [chart, setChart] = useState<ChartAccount[] | null>(null);
  const [chartFailed, setChartFailed] = useState(false);
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  /** Set once create succeeds: the drawer advances in place to the opening-balance step. */
  const [created, setCreated] = useState<BankAccount | null>(null);
  /**
   * F4: the required-field flag on the picker, raised on blur or on a Save attempt and cleared the
   * moment an account is chosen. `needs_ledger_account` is a client-side fact, so it is answered
   * here rather than fetched: the engine is never asked a question this drawer already knows.
   */
  const [ledgerFlagged, setLedgerFlagged] = useState(false);

  /** Derived from the typed values rather than minted at mount: see `saveQuestion` below. */
  const idempotency = useRef<{ question: string; key: string }>({
    question: '',
    key: crypto.randomUUID(),
  });

  const loadChart = useCallback(async () => {
    if (workspaceId === null) return;
    setChartFailed(false);
    // WITH archived rows, so an archived 9100 is never reported as missing and the operator is not
    // sent to create a duplicate.
    const response = await client.call('list_accounts', { workspaceId, includeArchived: true });
    if (isErr(response.body)) {
      setChartFailed(true);
      return;
    }
    const parsed = parseChart(response.body);
    if (parsed === null) {
      setChartFailed(true);
      return;
    }
    setChart(parsed);
  }, [client, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (workspaceId === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      await loadChart();
      if (accountId !== null) {
        const response = await client.call('get_bank_account', { workspaceId, bankAccountId: accountId });
        if (cancelled) return;
        if (isErr(response.body)) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const parsed = parseOneBankAccount(response.body);
        if (parsed === null) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setAccount(parsed);
        setName(parsed.name);
        setIban(groupIban(parsed.iban));
        setCurrency(parsed.currency);
        setLedgerAccountId(parsed.ledgerAccountId);
      }
      if (!cancelled) setLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, accountId, loadChart]);

  const options = useMemo(() => (chart === null ? [] : assetAccounts(chart)), [chart]);
  const unseededChart = chart !== null && options.length === 0;
  /** The three key fields freeze once the account carries a posted opening entry. */
  const frozen = account !== null && account.openingEntryId !== null;

  /** True when the picker is a real, editable control the operator has left unset. */
  const ledgerMissing = !frozen && !unseededChart && chart !== null && ledgerAccountId === '';

  /**
   * THE IDEMPOTENCY KEY IS AN ANSWER TO THE QUESTION, so it is derived from it and never from the
   * mount. The same law the Eröffnungssaldo step states in its header, and the same defect: a key
   * minted once at mount named ONE attempt for ever, while this drawer deliberately keeps every typed
   * value across a refusal so the operator can correct and save again.
   *
   * `SqliteStore.rememberIdempotent` keys on `(workspace, verb, key)` and fingerprints no input, and
   * the engine suite asserts what follows on rows: two `updateBankAccount` calls under one key with
   * different names return the FIRST row and discard the second name. So a lost response, a corrected
   * IBAN, and a second Speichern would be answered `ok` with the row the operator had just corrected
   * away, and the drawer would close reporting a success that saved the wrong values.
   *
   * The question is every field that reaches the payload, plus the row being edited: the key changes
   * when, and only when, the request would be a different request. A retry of an UNCHANGED question
   * keeps its key, which is the double-write protection the ref was added for, and both halves are
   * pinned by their own tests.
   */
  const saveQuestion = JSON.stringify([
    account?.id ?? null,
    frozen,
    name,
    frozen ? null : iban,
    frozen ? null : currency,
    frozen ? null : ledgerAccountId,
  ]);
  if (idempotency.current.question !== saveQuestion) {
    idempotency.current = { question: saveQuestion, key: crypto.randomUUID() };
  }

  const save = useCallback(async () => {
    if (workspaceId === null) return;
    // Prevented at the control: `needs_ledger_account` is unreachable from the GUI, the same outcome
    // the drawer already reaches for `account_in_use`, `unusable` and `not_an_asset_account`.
    if (ledgerMissing) {
      setLedgerFlagged(true);
      // The shared <Select> renders a role="combobox" button carrying this id; focus it by id since
      // the component does not forward a ref.
      document.getElementById('bank-ledger-account')?.focus();
      return;
    }
    setSaving(true);
    setError(null);

    const normalized = normalizeIban(iban);
    const response =
      account === null
        ? await client.call('create_bank_account', {
            workspaceId,
            name,
            iban: normalized,
            currency,
            ledgerAccountId,
            idempotencyKey: idempotency.current.key,
          })
        : await client.call('update_bank_account', {
            workspaceId,
            bankAccountId: account.id,
            name,
            ...(frozen ? {} : { iban: normalized, currency, ledgerAccountId }),
            idempotencyKey: idempotency.current.key,
          });

    setSaving(false);
    if (isErr(response.body)) {
      // Every typed value stays exactly where the operator left it.
      setError(response.body);
      return;
    }

    if (account !== null) {
      onSaved();
      onClose();
      return;
    }

    // Create wrote the row and posted NOTHING (INV-7). The drawer advances to the second step, whose
    // own confirm is the only thing on this surface that moves money.
    const newId = response.body.bankAccountId;
    setCreated({
      id: typeof newId === 'string' ? newId : '',
      name,
      iban: normalized,
      isQrIban: response.body.isQrIban === true,
      receiveOnly: response.body.isQrIban === true,
      currency,
      ledgerAccountId,
      ledgerAccountNumber: options.find((a) => a.id === ledgerAccountId)?.number ?? null,
      openingBalanceMinor: null,
      openingBalanceDate: null,
      openingEntryId: null,
      archived: false,
      createdAt: new Date().toISOString(),
    });
    onSaved();
  }, [
    client,
    workspaceId,
    account,
    name,
    iban,
    currency,
    ledgerAccountId,
    ledgerMissing,
    frozen,
    options,
    onSaved,
    onClose,
  ]);

  if (notFound) {
    return (
      <BankDrawer title={t('bank.editor.title.edit')} onClose={onClose}>
        <p className="bank-blocked-text">{t('bank.error.notFound.text')}</p>
        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('bank.error.notFound.action')}
          </button>
        </div>
      </BankDrawer>
    );
  }

  if (created !== null) {
    return (
      <BankDrawer title={t('bank.editor.title.opening')} onClose={onClose}>
        <OpeningBalanceStep
          account={created}
          baseCurrency={baseCurrency}
          openingAccount={chart === null ? 'missing' : openingAccountState(chart)}
          openingAccountId={chart === null ? null : openingAccountId(chart)}
          chartFailed={chartFailed}
          probing={chart === null && !chartFailed}
          onChartChanged={() => void loadChart()}
          onPosted={() => {
            onSaved();
            onClose();
          }}
          onLater={onClose}
        />
      </BankDrawer>
    );
  }

  const qrHint = !frozen && looksLikeQrIban(iban);
  const clash =
    error !== null && error.error === 'duplicate_iban' && typeof error.iban === 'string'
      ? (register.find((row) => row.iban === normalizeIban(String(error.iban))) ?? null)
      : null;

  return (
    <BankDrawer title={account === null ? t('bank.editor.title.create') : t('bank.editor.title.edit')} onClose={onClose}>
      {loading ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <div className="form-stack">
            <div className="form-row">
              <label className="field-label-row" htmlFor="bank-name">
                {t('bank.name')}
              </label>
              <input
                id="bank-name"
                className="field bank-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="form-row">
              <span className="field-label-row">
                <label htmlFor="bank-iban">{t('bank.iban.label')}</label>
                <HelpHint
                  label={t('bank.qrIban.help.label')}
                  title={t('bank.qrIban.help.title')}
                  body={t('bank.qrIban.explainer')}
                />
              </span>
              <input
                id="bank-iban"
                className="field bank-input"
                value={iban}
                readOnly={frozen}
                aria-describedby={frozen ? 'bank-frozen-reason' : undefined}
                onChange={(event) => setIban(event.target.value)}
              />
              {qrHint && <p className="field-hint">{t('bank.qrIban.explainer')}</p>}
              {error !== null && error.error === 'invalid_iban' && (
                <p className="field-error" role="alert">
                  {t(ibanErrorKey(error.reason))}
                </p>
              )}
              {error !== null && error.error === 'duplicate_iban' && (
                <p className="field-error" role="alert">
                  {t('bank.error.duplicateIban.text', { name: clash?.name ?? t('bank.error.duplicateIban.unknown') })}
                </p>
              )}
            </div>

            <div className="form-row">
              <label className="field-label-row" htmlFor="bank-currency">
                {t('bank.currency')}
              </label>
              <Select
                id="bank-currency"
                value={currency}
                onChange={(value) => setCurrency(value)}
                options={CURRENCIES.map((code) => ({ value: code, label: code }))}
                disabled={frozen}
                describedBy={frozen ? 'bank-frozen-reason' : undefined}
                ariaLabel={t('bank.currency')}
              />
            </div>

            <div className="form-row">
              <label className="field-label-row" htmlFor="bank-ledger-account">
                {t('bank.ledgerAccount.label')}
              </label>
              {chartFailed ? (
                <ErrorBanner message={t('bank.error.chart')} onRetry={() => void loadChart()} />
              ) : chart === null ? (
                <Skeleton rows={1} />
              ) : unseededChart ? (
                /* B7: derived, and rendered BEFORE any Save rather than after a rejection. */
                <div className="bank-blocked" role="status">
                  <p className="bank-blocked-text">{t('bank.empty.noAssetAccounts.text')}</p>
                  <Link className="btn btn--secondary btn--sm" to="/accounts">
                    {t('bank.empty.noAssetAccounts.action')}
                  </Link>
                </div>
              ) : (
                <Select
                  id="bank-ledger-account"
                  value={ledgerAccountId}
                  onChange={(value) => {
                    setLedgerAccountId(value);
                    if (value !== '') setLedgerFlagged(false);
                  }}
                  options={[
                    { value: '', label: t('bank.ledgerAccount.choose') },
                    ...options.map((option) => ({
                      value: option.id,
                      label: `${option.number} ${option.name}`,
                    })),
                  ]}
                  disabled={frozen}
                  invalid={ledgerFlagged}
                  describedBy={
                    ledgerFlagged
                      ? 'bank-ledger-account-error'
                      : frozen
                        ? 'bank-frozen-reason'
                        : undefined
                  }
                  onBlur={() => {
                    // Inline, on blur, next to the field. It cannot fire before the operator has
                    // been near the control, so an untouched create form is never nagged.
                    if (ledgerAccountId === '') setLedgerFlagged(true);
                  }}
                  ariaLabel={t('bank.ledgerAccount.label')}
                />
              )}
              {/*
                F4. A19 US-A19.1 says "the field is flagged", and this is the field. The same
                sentence used to render below the whole form-stack, past the frozen-fields hint,
                which on a short viewport put it under the fold and away from the control it names.
                The engine's own `needs_ledger_account` lands here too, for the case where the chart
                changes under an open drawer.
              */}
              {(ledgerFlagged || (error !== null && error.error === 'needs_ledger_account')) && (
                <p id="bank-ledger-account-error" className="field-error" role="alert">
                  {t('bank.error.needsLedgerAccount')}
                </p>
              )}
              {/*
                A19 US-A19.4 uses "e.g. 1021" for a EUR account as though it were seeded, and the KMU
                seed has 1020 and no 1021. The `account` table also carries no per-account currency,
                so no picker can filter by it and this one must not pretend to. A hint, not a block:
                booking two currencies through 1020 is a real if untidy choice and A19 does not
                forbid it.
              */}
              {currency !== baseCurrency && baseCurrency !== '' && !unseededChart && (
                <p className="field-hint">{t('bank.ledgerAccount.foreignHint')}</p>
              )}
            </div>
          </div>

          {frozen && (
            <p id="bank-frozen-reason" className="field-hint">
              {t('bank.error.accountInUse')}
            </p>
          )}

          {/* Drawer-level only for rejections that name no field. The three that DO name one
              (`invalid_iban`, `duplicate_iban`, `needs_ledger_account`) render inside that field's
              own row instead. */}
          {error !== null &&
            !['invalid_iban', 'duplicate_iban', 'needs_ledger_account'].includes(error.error) && (
              <p className="field-error" role="alert">
                {error.error === 'permission_denied'
                  ? t('bank.error.permissionDenied.write')
                  : t('errors.fallback')}
              </p>
            )}

          <div className="form-actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              {t('bank.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || name.trim() === ''}
              onClick={() => void save()}
            >
              {t('bank.save')}
            </button>
          </div>
        </>
      )}
    </BankDrawer>
  );
}
