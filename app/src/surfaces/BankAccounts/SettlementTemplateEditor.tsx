/**
 * A43 §3, the booking template of ONE settlement source in the Studio: the clearing account, and per event
 * kind what the import does (book on an account with a tax code, skip, ask a person). It calls
 * `set_settlement_template`, which no other Studio surface does, so a person using only the Studio can
 * connect a source.
 *
 * THE ENGINE DECIDES. The editor sends the whole template; the engine checks every account and code against
 * the books as they are now and refuses naming the field (`invalid_account`, `account_archived`,
 * `unknown_tax_code`, `archived_tax_code`, `tax_code_unsupported`). A kind left unmapped stays unmapped, and
 * the import refuses a file that carries it: the editor never invents a booking.
 *
 * Low cognitive load (DESIGN.md rule 7): one row per kind, three shared Selects, no helper sentences; the
 * five states: the skeleton while it loads, the error, the padlock without `post`, the form, and saved.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT } from '../../i18n';
import { Select, type SelectOption } from '../../components/Select';
import { ErrorBanner, PermissionDenied, Skeleton, refusalText } from '../../components/states';
import './SettlementTemplateEditor.css';

/** Every event kind of till-settlement/v1, in the format's own order. */
export const SETTLEMENT_KINDS = [
  'sale',
  'refund',
  'processing_fee',
  'service_fee',
  'third_party_payout',
  'third_party_payout_reversal',
  'reserve',
  'bank_payout',
  'bank_payout_summary',
  'other',
] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

type Action = 'book' | 'skip' | 'attention' | 'unmapped';

interface KindDraft {
  action: Action;
  accountId: string;
  taxCode: string;
}

interface Draft {
  clearingAccountId: string;
  kinds: Record<SettlementKind, KindDraft>;
}

interface AccountDto {
  id: string;
  number: string;
  name: string;
  type?: string;
  archived?: boolean;
}

interface TaxCodeDto {
  code: string;
  kind: string;
  label: string;
  active: boolean;
}

/** The template as `get_settlement_template` describes it. */
interface TemplateDto {
  clearingAccountId: string;
  kinds: Record<string, { action: Action; accountId?: string; taxCode?: string | null }>;
}

/** The kinds a fresh template starts with, as the engine defaults them. */
const DEFAULTS: Partial<Record<SettlementKind, Action>> = { bank_payout: 'skip', bank_payout_summary: 'skip', reserve: 'skip', other: 'attention' };

/** The tax-code kinds the engine books a settlement event under. */
const BOOKABLE_TAX_KINDS = new Set(['output', 'input', 'zero', 'exempt']);

/** The refusals the editor words itself (`settlementTemplate.refusal.<code>`). */
// D203 (critic r1 L3): `payout_not_turnover`, a payout booked to a revenue account.
const KNOWN = ['invalid_account', 'account_archived', 'unknown_tax_code', 'archived_tax_code', 'tax_code_unsupported', 'payout_not_turnover', 'invalid_input'] as const;

const NO_CODE = '-';

function draftOf(template: TemplateDto | null): Draft {
  const kinds = {} as Record<SettlementKind, KindDraft>;
  for (const k of SETTLEMENT_KINDS) {
    const rule = template?.kinds[k];
    kinds[k] = rule === undefined || template === null
      ? { action: DEFAULTS[k] ?? 'unmapped', accountId: '', taxCode: NO_CODE }
      : { action: rule.action, accountId: rule.accountId ?? '', taxCode: rule.taxCode ?? NO_CODE };
  }
  return { clearingAccountId: template?.clearingAccountId ?? '', kinds };
}

export function SettlementTemplateEditor({
  workspaceId,
  system,
  processor,
  canPost,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  system: string;
  processor: string;
  canPost: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const client = useClient();
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [codes, setCodes] = useState<TaxCodeDto[]>([]);
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const [tpl, acc, vat] = await Promise.all([
      client.call('get_settlement_template', { workspaceId, system, processor }),
      client.call('list_accounts', { workspaceId }),
      client.call('vat_codes', { workspaceId }),
    ]);
    const failed = [tpl.body, acc.body, vat.body].find((b) => isErr(b));
    if (failed !== undefined) {
      setLoadError(failed as Err);
      return;
    }
    const templates = ((tpl.body as unknown as { templates?: { template: TemplateDto }[] }).templates ?? []);
    setAccounts(((acc.body as unknown as { accounts?: AccountDto[] }).accounts ?? []).filter((a) => a.archived !== true));
    setCodes(((vat.body as unknown as { taxCodes?: TaxCodeDto[] }).taxCodes ?? []).filter((c) => c.active && BOOKABLE_TAX_KINDS.has(c.kind)));
    setDraft(draftOf(templates[0]?.template ?? null));
  }, [client, workspaceId, system, processor]);

  useEffect(() => {
    if (canPost) void load();
  }, [load, canPost]);

  if (!canPost) return <PermissionDenied title={t('settlementTemplate.title')} body={t('settlementTemplate.denied')} />;
  if (loadError !== null) return <ErrorBanner message={refusalText(t, loadError, { own: 'settlementTemplate.refusal', known: KNOWN })} onRetry={() => void load()} context="read" />;
  if (draft === null) return <Skeleton rows={4} />;

  const accountOptions = (types: readonly string[] | null): SelectOption[] =>
    accounts.filter((a) => types === null || types.includes(a.type ?? '')).map((a) => ({ value: a.id, label: `${a.number} ${a.name}` }));
  const balanceAccounts = accountOptions(['asset', 'liability']);
  const contraAccounts = accountOptions(null).filter((o) => o.value !== draft.clearingAccountId);
  const codeOptions: SelectOption[] = [{ value: NO_CODE, label: t('settlementTemplate.noVat') }, ...codes.map((c) => ({ value: c.code, label: `${c.code} ${c.label}` }))];
  const actionOptions: SelectOption[] = (['book', 'skip', 'attention', 'unmapped'] as const).map((a) => ({ value: a, label: t(`settlementTemplate.action.${a}`) }));

  const setKind = (k: SettlementKind, patch: Partial<KindDraft>) => {
    setSaved(false);
    setDraft({ ...draft, kinds: { ...draft.kinds, [k]: { ...draft.kinds[k], ...patch } } });
  };

  const complete = draft.clearingAccountId !== '' && SETTLEMENT_KINDS.every((k) => draft.kinds[k].action !== 'book' || draft.kinds[k].accountId !== '');

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const kinds: Record<string, unknown> = {};
    for (const k of SETTLEMENT_KINDS) {
      const d = draft.kinds[k];
      if (d.action === 'unmapped') continue;
      kinds[k] = d.action === 'book' ? { action: 'book', accountId: d.accountId, taxCode: d.taxCode === NO_CODE ? null : d.taxCode } : { action: d.action };
    }
    const { body } = await client.call('set_settlement_template', {
      workspaceId,
      system,
      processor,
      clearingAccountId: draft.clearingAccountId,
      kinds,
      idempotencyKey: `a43-template-${crypto.randomUUID()}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setSaved(true);
    onSaved?.();
  };

  return (
    <form
      className="settlement-template"
      aria-label={t('settlementTemplate.label', { system, processor })}
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !busy) void save();
      }}
    >
      <h3 className="settlement-template-title">
        {system} · {processor}
      </h3>
      {error !== null && <ErrorBanner message={refusalText(t, error, { own: 'settlementTemplate.refusal', known: KNOWN })} />}
      <div className="settlement-template-clearing">
        <span id={`${id}-clearing`}>{t('settlementTemplate.clearing')}</span>
        <Select
          id={`${id}-clearing-select`}
          ariaLabel={t('settlementTemplate.clearing')}
          value={draft.clearingAccountId}
          placeholder={t('settlementTemplate.pick')}
          options={balanceAccounts}
          disabled={busy}
          onChange={(v) => {
            setSaved(false);
            setDraft({ ...draft, clearingAccountId: v });
          }}
        />
      </div>
      <table className="settlement-template-kinds">
        <caption className="visually-hidden">{t('settlementTemplate.kinds')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('settlementTemplate.col.kind')}</th>
            <th scope="col">{t('settlementTemplate.col.action')}</th>
            <th scope="col">{t('settlementTemplate.col.account')}</th>
            <th scope="col">{t('settlementTemplate.col.taxCode')}</th>
          </tr>
        </thead>
        <tbody>
          {SETTLEMENT_KINDS.map((k) => {
            const d = draft.kinds[k];
            const kindLabel = t(`settlementTemplate.kind.${k}`);
            return (
              <tr key={k} data-kind={k}>
                <th scope="row">{kindLabel}</th>
                <td>
                  <Select ariaLabel={`${kindLabel}: ${t('settlementTemplate.col.action')}`} value={d.action} options={actionOptions} disabled={busy} onChange={(v) => setKind(k, { action: v as Action })} />
                </td>
                <td>
                  {d.action === 'book' && (
                    <Select
                      ariaLabel={`${kindLabel}: ${t('settlementTemplate.col.account')}`}
                      value={d.accountId}
                      placeholder={t('settlementTemplate.pick')}
                      options={contraAccounts}
                      disabled={busy}
                      invalid={d.accountId === ''}
                      onChange={(v) => setKind(k, { accountId: v })}
                    />
                  )}
                </td>
                <td>
                  {d.action === 'book' && (
                    <Select ariaLabel={`${kindLabel}: ${t('settlementTemplate.col.taxCode')}`} value={d.taxCode} options={codeOptions} disabled={busy} onChange={(v) => setKind(k, { taxCode: v })} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="settlement-template-actions">
        <button type="submit" className="btn btn--primary btn--sm" aria-disabled={!complete || busy}>
          {t('settlementTemplate.save')}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
            {t('settlementTemplate.cancel')}
          </button>
        )}
        {saved && (
          <span role="status" className="settlement-template-saved">
            {t('settlementTemplate.saved')}
          </span>
        )}
      </div>
    </form>
  );
}
