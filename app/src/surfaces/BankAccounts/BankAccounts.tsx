/**
 * A19, Bankkonten (`/bank-accounts`): B-S1, the register, plus the QR-IBAN completeness note.
 *
 * WHY IT IS A RAIL ITEM IN THE BANK GROUP. D38/P1 shaped that group before A19 existed and
 * `nav.ts` said so on disk. It sits SECOND, after Zahlungen: Zahlungen is the daily verb and the
 * register is what you touch at onboarding and then rarely. This overrules A19 §6's "reached from
 * Settings to Banking", which predates D38: the spec is superseded, not contradicted by a preference.
 *
 * THE COMPLETENESS NOTE IS THE DESIGN'S REAL JOB (INV-6). Making one row say "nur Eingang" is the
 * easy half. The hard half is that the fact is about the REGISTER AS A WHOLE. SIX, "Swiss QR-bill:
 * Technical information about the QR-IID and QR-IBAN" v1.1, effective 29 February 2020, §3.1:
 *
 *   "A QR-IBAN can only be used for incoming payments. Payments debiting a QR-IBAN are not
 *    anticipated. That is why there must always be an IBAN in addition to a QR-IBAN (for incoming
 *    payments with no reference and for outgoing payments)."
 *
 * Read as a UI requirement, the second sentence is the operative one. A register holding only a
 * QR-IBAN is incomplete, and the operator will not find out until A18 lands and the pain.001 debit
 * picker is empty: the "an affordance is unreachable and nobody knows why" defect class, delivered a
 * wave late. So the surface says it now, derived from `list_bank_accounts` alone with no new verb.
 *
 * IT IS `role="status"`, NOT `role="alert"`. It is an incompleteness, not a failure, and A18 does not
 * exist yet, so shouting would be inventing urgency the product cannot justify. Its action is
 * labelled "Normale IBAN erfassen" rather than "Konto hinzufügen", because two identically-labelled
 * controls forty pixels apart is a duplicated control and a second go-button competing with the
 * surface's primary. It is dismissible per workspace through the same `localStorage` mechanism D38/P9
 * established for a presentational preference: a permanent band above the content, for every future
 * session, about a gap that only bites when A18 lands, is "config never stacks on content" in
 * advisory clothing.
 *
 * THE DISMISSAL IS KEYED TO WHAT IT DISMISSED (F3). It is presentational only, and it is a claim
 * about a register that keeps moving, so it is re-judged on every read against two rules: it covers
 * only the QR-IBANs that were live when it was taken, so a FURTHER QR-IBAN brings the note back;
 * and it is forgotten outright whenever the register is complete, so registering a plain IBAN and
 * later archiving it brings the note back too. The second rule is the one a subset test alone
 * misses, because that sequence never changes the QR-IBAN set at all. Before this, one boolean per
 * workspace silenced the note forever, and the sentence written here and in the design promising
 * otherwise was false: the exact defect the note exists to prevent, delivered anyway, and not found
 * until A18's pain.001 debit picker came up empty.
 *
 * ARCHIVING IS REVERSIBLE AGAIN, AND THAT CHANGES THE TREATMENT. The design shipped a ConfirmDialog
 * here and said why: `archiveBankAccount` set the flag and nothing anywhere cleared it, so retiring
 * an account was one-way from every surface, and DESIGN.md's Forgiveness rule then requires a
 * confirm. §7.5 also named the better end state: "when `unarchive_bank_account` lands, the confirm
 * gives way to the undo". It has landed. So archiving sits last in the row overflow, an undo line
 * offers the restore immediately, and archived rows behind the toggle carry their own restore. A
 * confirm dialog on a reversible act devalues the confirm on an irreversible one.
 *
 * "LÖSCHEN" APPEARS NOWHERE, in any menu, in any state. This differs from `/accounts`, which offers
 * Archive-XOR-Delete from `inUse`, and the difference is correct: a chart account with no journal
 * lines has never meant anything, while a bank account is a durable reference for A20 and A21 by
 * design.
 *
 * THE ENGINE SENDS NO PERMISSION FIELD. `list_bank_accounts` carries none, so nothing here is
 * pre-disabled on an invented one: a Studio that read `canArchive` would repeat the defect that left
 * `canPost`, `canManage` and `canUnlock` permanently enabled, each tested `x !== false`. A denied
 * READ renders the padlock panel; a denied WRITE renders its sentence where it was attempted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { useCan, CAP } from '../../lib/capabilities';
import { CopyButton } from '../../components/CopyButton';
import { BankAccountEditor } from './BankAccountEditor';
import { BankDrawer } from './BankDrawer';
import { OpeningBalanceStep } from './OpeningBalanceStep';
import { EbicsChannelPanel } from './EbicsChannelPanel';
import {
  dismissalCoversRegister,
  liveQrIbanIds,
  maskIban,
  openingAccountId,
  openingAccountState,
  parseBankAccounts,
  parseChart,
  qrIbanRegisterIsIncomplete,
  type BankAccount,
  type ChartAccount,
} from './model';
import './BankAccounts.css';

/** Where the dismissal of the completeness note is remembered, per workspace (D38/P9). */
const DISMISS_KEY = 'till.bank.qrNoteDismissed';

/**
 * The QR-IBAN ids a dismissal covered, or null when there is none (F3).
 *
 * It used to store the string `'1'`, which a comma split reads back as the single id `"1"`. No
 * account carries that id, so a value written by an older build fails the subset test and the note
 * REAPPEARS once. That is the right direction to degrade in: this note exists to be seen.
 */
function dismissedFor(workspaceId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(`${DISMISS_KEY}.${workspaceId}`);
    return raw === null ? null : raw.split(',').filter((id) => id !== '');
  } catch {
    return null;
  }
}

function rememberDismissal(workspaceId: string, qrIds: readonly string[]): void {
  try {
    window.localStorage.setItem(`${DISMISS_KEY}.${workspaceId}`, qrIds.join(','));
  } catch {
    // A blocked storage is not a reason to leave the note on screen this session.
  }
}

function forgetDismissal(workspaceId: string): void {
  try {
    window.localStorage.removeItem(`${DISMISS_KEY}.${workspaceId}`);
  } catch {
    // Nothing to do: the read side treats an unreadable storage as "not dismissed" anyway.
  }
}

export function BankAccounts() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  /**
   * THE PADLOCK (A24, F5 retrofit). The register's writes are `manage_master_data`; the opening
   * balance POSTS a real journal entry, so its affordance takes `post`, matching the engine's gate
   * on `set_bank_opening_balance`. Affordances are ABSENT without the capability (the Contacts
   * idiom); `useCan` fails open while `whoami` is unresolved, because the engine decides.
   */
  const canManage = useCan(CAP.manageMasterData);
  const canPost = useCan(CAP.post);

  const showArchived = params.get('archived') === '1';
  const editingId = params.get('account');
  const creating = params.get('new') === '1';
  const openingFor = params.get('opening');

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [chart, setChart] = useState<ChartAccount[] | null>(null);
  /** The chart READ failed, which the step renders as itself rather than as "9100 is missing". */
  const [chartFailed, setChartFailed] = useState(false);
  const [baseCurrency, setBaseCurrency] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [rowError, setRowError] = useState<Err | null>(null);
  /** The account just archived, so the undo can be offered without re-reading anything. */
  const [undo, setUndo] = useState<BankAccount | null>(null);
  const [noteDismissed, setNoteDismissed] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);

    const response = await client.call('list_bank_accounts', {
      workspaceId,
      ...(showArchived ? { includeArchived: true } : {}),
    });

    if (isErr(response.body)) {
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }

    const parsed = parseBankAccounts(response.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setAccounts(parsed);
    // F3: the dismissal is re-judged against the register on EVERY read, because it is a claim about
    // the register and the register moves. A complete register has nothing left to suppress, so the
    // dismissal is forgotten rather than banked against the next time the register breaks.
    if (!qrIbanRegisterIsIncomplete(parsed)) {
      forgetDismissal(workspaceId);
      setNoteDismissed(false);
    } else {
      setNoteDismissed(dismissalCoversRegister(dismissedFor(workspaceId), parsed));
    }
    setLoading(false);
  }, [client, workspaceId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The base currency, and the chart the opening-balance step needs when it is opened from a ROW
   * rather than from the editor. Read once beside the list rather than inside the step, so the step
   * has one source of truth whichever entry point opened it.
   */
  /**
   * The chart, WITH archived rows, as its own callback rather than only an effect body: the
   * opening-balance step's 9100 recovery has to be able to ask for it again after it creates or
   * reactivates the account, and the block must clear from the same read that judged it rather than
   * from the step deciding for itself that the write worked.
   */
  const loadChart = useCallback(async () => {
    if (workspaceId === null) return;
    setChartFailed(false);
    const response = await client.call('list_accounts', { workspaceId, includeArchived: true });
    // A failed read used to set NOTHING, which left `chart` null and the step probing for ever with
    // Buchen disabled and no sentence saying why. A failure is a state, so it is recorded as one and
    // the step renders it with a retry. A parse that comes back null is the same state: a shape this
    // surface cannot read is not a chart it may reason about.
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
    if (workspaceId === null) return;
    let cancelled = false;
    const run = async () => {
      const [profile] = await Promise.all([
        client.call('get_company_profile', { workspaceId }),
        loadChart(),
      ]);
      if (cancelled) return;
      // `get_company_profile` nests everything under `profile`, and the base currency is the one
      // field this surface needs from it: it decides whether the FX rate field is relevant at all.
      if (!isErr(profile.body)) {
        const nested = profile.body.profile;
        if (typeof nested === 'object' && nested !== null) {
          const currency = (nested as Record<string, unknown>).baseCurrency;
          if (typeof currency === 'string') setBaseCurrency(currency);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, loadChart]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  const archive = useCallback(
    async (account: BankAccount) => {
      if (workspaceId === null) return;
      setRowError(null);
      const response = await client.call('archive_bank_account', {
        workspaceId,
        bankAccountId: account.id,
        idempotencyKey: crypto.randomUUID(),
      });
      if (isErr(response.body)) {
        setRowError(response.body);
        return;
      }
      setUndo(account);
      void load();
    },
    [client, workspaceId, load],
  );

  const unarchive = useCallback(
    async (account: BankAccount) => {
      if (workspaceId === null) return;
      setRowError(null);
      const response = await client.call('unarchive_bank_account', {
        workspaceId,
        bankAccountId: account.id,
        idempotencyKey: crypto.randomUUID(),
      });
      if (isErr(response.body)) {
        setRowError(response.body);
        return;
      }
      setUndo(null);
      void load();
    },
    [client, workspaceId, load],
  );

  const incomplete = useMemo(() => qrIbanRegisterIsIncomplete(accounts), [accounts]);
  const openingAccount = openingFor === null ? null : (accounts.find((a) => a.id === openingFor) ?? null);

  /**
   * One row's overflow items, each travelling with ITS OWN capability (F5): edit and archive are
   * register writes (`manage_master_data`), the opening balance is a posting (`post`). Destructive
   * items go LAST: `OverflowMenu` renders what it is passed and does not reorder, so this ordering is
   * the caller's contract. An empty list hides the trigger rather than showing an empty menu.
   */
  const rowItems = (account: BankAccount): OverflowMenuItem[] => [
    ...(canManage ? [{ key: 'edit', label: t('bank.edit'), onSelect: () => setParam('account', account.id) }] : []),
    // B13: absent once the opening entry exists, so `opening_balance_already_set` is unreachable.
    ...(canPost && account.openingEntryId === null && !account.archived
      ? [{ key: 'opening', label: t('bank.openingBalance.record'), onSelect: () => setParam('opening', account.id) }]
      : []),
    ...(canManage
      ? account.archived
        ? [{ key: 'unarchive', label: t('bank.unarchive'), onSelect: () => void unarchive(account) }]
        : [{ key: 'archive', label: t('bank.archive'), onSelect: () => void archive(account), danger: true }]
      : []),
  ];

  /**
   * The opening-balance cell. The FIGURE is always formatted through `formatMoney`, never hardcoded
   * into a sentence: a bare "0.00" beside a EUR account carries no unit. A zero opening balance (B12)
   * records the intent and posts NOTHING, so it reads as a sentence and is not a link; a posted
   * balance links to the journal entry it created.
   */
  const renderOpening = (account: BankAccount) => {
    if (account.openingBalanceMinor === null) return t('bank.openingBalance.none');
    if (account.openingEntryId === null) {
      return (
        <span className="bank-money">
          {t('bank.openingBalance.zeroNoEntry', {
            amount: formatMoney(account.openingBalanceMinor, account.currency),
          })}
        </span>
      );
    }
    return (
      <Link to="/journal" className="bank-money t-money">
        {formatMoney(account.openingBalanceMinor, account.currency)}
        {account.openingBalanceDate !== null && (
          <span className="bank-opening-date"> {formatDate(account.openingBalanceDate)}</span>
        )}
      </Link>
    );
  };

  /**
   * The register columns. The IBAN is MASKED here (full value rides the `CopyButton`, never a
   * hover-only `title`). The QR chip is ONE chip, "nur Eingang", the consequence stated once. The
   * archived state is a WORD (the chip) as well as a dimmed row (`rowClassName`), never colour alone.
   */
  const columns: DataTableColumn<BankAccount>[] = [
    {
      key: 'name',
      header: t('bank.name'),
      rowHeader: true,
      // K-21: the row itself opens the account (onRowClick below), so the name is plain text rather
      // than a 44px bespoke button; the archived state is the shared Status word (K-22).
      render: (account) => (
        <>
          <span className="bank-row-name">{account.name}</span>
          {account.archived && <Status kind="inactive" label={t('bank.status.archived')} />}
        </>
      ),
    },
    {
      key: 'iban',
      header: t('bank.iban.label'),
      render: (account) => (
        <>
          <span className="bank-iban">{maskIban(account.iban)}</span>
          <CopyButton value={account.iban} label={t('bank.iban.copy', { name: account.name })} />
          {account.isQrIban && <span className="bank-chip">{t('bank.qrIbanChip')}</span>}
        </>
      ),
    },
    {
      key: 'currency',
      header: t('bank.currency'),
      render: (account) => account.currency,
    },
    {
      key: 'ledger',
      header: t('bank.ledgerAccount.label'),
      render: (account) => account.ledgerAccountNumber ?? t('bank.ledgerAccount.unknown'),
    },
    {
      key: 'opening',
      header: t('bank.openingBalance.label'),
      render: renderOpening,
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('bank.error.permissionDenied.read')} />;

  return (
    <section className="bank" aria-labelledby="bank-title">
      <SurfaceHeader
        title={t('bank.title')}
        titleId="bank-title"
        help={<SurfaceHelp surface="BankAccounts" />}
        actions={
          <>
            <label className="bank-toggle" htmlFor="bank-show-archived">
              <input
                id="bank-show-archived"
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setParam('archived', event.target.checked ? '1' : null)}
              />
              <span>{t('bank.showArchived')}</span>
            </label>
            {canManage && (
              <button type="button" className="btn btn--primary" onClick={() => setParam('new', '1')}>
                {t('bank.add')}
              </button>
            )}
          </>
        }
      />

      {/* Not during loading: the note is a claim about a set that is not loaded yet. */}
      {!loading && !failed && incomplete && !noteDismissed && (
        <div className="bank-note" role="status">
          <p className="bank-note-text">{t('bank.qrIban.incomplete.text')}</p>
          <div className="bank-note-actions">
            {canManage && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setParam('new', '1')}>
                {t('bank.qrIban.incomplete.action')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                // What is remembered is WHICH register was dismissed, so a later one is not.
                rememberDismissal(workspaceId, liveQrIbanIds(accounts));
                setNoteDismissed(true);
              }}
            >
              {t('bank.qrIban.incomplete.dismiss')}
            </button>
          </div>
        </div>
      )}

      {undo !== null && (
        <div className="bank-undo" role="status">
          <span>{t('bank.archivedDone', { name: undo.name })}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void unarchive(undo)}>
            {t('bank.unarchive')}
          </button>
        </div>
      )}

      {rowError !== null && (
        <ErrorBanner
          message={
            rowError.error === 'bank_account_not_found'
              ? t('bank.error.notFound.text')
              : rowError.error === 'permission_denied'
                ? t('bank.error.permissionDenied.write')
                : t('errors.fallback')
          }
        />
      )}

      {failed ? (
        <ErrorBanner message={t('bank.error.transport')} onRetry={() => void load()} />
      ) : (
        <DataTable
          columns={columns}
          rows={accounts}
          rowKey={(account) => account.id}
          caption={t('bank.title')}
          loading={loading}
          skeletonRows={4}
          rowClassName={(account) => (account.archived ? 'bank-row--archived' : undefined)}
          {...(canManage
            ? {
                onRowClick: (account: BankAccount) => setParam('account', account.id),
                rowLabel: (account: BankAccount) => t('bank.rowOpen', { name: account.name }),
              }
            : {})}
          rowActions={rowItems}
          rowActionsLabel={(account) => t('bank.rowActionsFor', { name: account.name })}
          emptyState={
            <EmptyState
              title={t('bank.empty.list.title')}
              hint={t('bank.empty.list.hint')}
              {...(canManage
                ? { action: { label: t('bank.empty.list.action'), onClick: () => setParam('new', '1') } }
                : {})}
            />
          }
        />
      )}

      {/* A33: the EBICS bank-channel panel (spec §6). Rendered once the register has loaded, below the
          table: a channel belongs to the bank contract, and the register is the accounts it routes. */}
      {!loading && !failed && <EbicsChannelPanel accounts={accounts} />}

      {(creating || editingId !== null) && (
        <BankAccountEditor
          accountId={editingId}
          register={accounts}
          baseCurrency={baseCurrency}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('new');
            next.delete('account');
            setParams(next, { replace: false });
          }}
          onSaved={() => void load()}
        />
      )}

      {/* F6: the SAME shell the editor uses, not a copy of it. The copy was identical to look at and
          differed only in what it did not carry: the Escape handler. */}
      {openingAccount !== null && (
        <BankDrawer
          title={t('bank.editor.title.opening')}
          onClose={() => setParam('opening', null)}
        >
          {/*
            KEYED ON THE ACCOUNT, so the step's state cannot outlive the account it was typed for.
            The step's whole state model is "every answer belongs to a question", and the account is
            the outermost part of the question: `?opening=` moving straight from one id to another
            keeps the component mounted, and account A's amount, date and refusal would then open
            account B's step already filled in, relabelled to B's currency. Every route in this
            surface goes through `opening=null` first, so nothing reaches it by clicking; that makes
            it safe by the order of the caller, which is not a property to rely on in front of an
            irreversible posting. One attribute makes it structural instead.
          */}
          <OpeningBalanceStep
            key={openingAccount.id}
            account={openingAccount}
            baseCurrency={baseCurrency}
            openingAccount={chart === null ? 'missing' : openingAccountState(chart)}
            openingAccountId={chart === null ? null : openingAccountId(chart)}
            chartFailed={chartFailed}
            probing={chart === null && !chartFailed}
            onChartChanged={() => void loadChart()}
            onPosted={() => {
              setParam('opening', null);
              void load();
            }}
            onLater={() => setParam('opening', null)}
          />
        </BankDrawer>
      )}
    </section>
  );
}

