/**
 * The control-total declaration form (G11 §7, US-G11.1/US-G11.5), rendered on the Datenübernahme
 * surface above the Eröffnungsprüfung: a control the operator never declared reports "nicht geprüft"
 * and never green, so declaring the figures the old system said is the input the check gates on.
 *
 * WHAT THIS FORM IS CAREFUL ABOUT:
 *   - Only the DECLARABLE control kinds are offered (trial balance against the source per account, open
 *     AR, open AP, the VAT position at the Stichtag): a kind the engine derives structurally (the
 *     Rohbilanz balancing to zero, the row count) takes no declared figure and is not shown.
 *   - The scope is the account number, the IBAN, or the workspace the figure is about: a per-account
 *     trial-balance total needs its account, the AR/AP and VAT positions default to the workspace.
 *   - The figure is entered as francs and converted to integer Rappen once, so the engine never sees a
 *     float: `12'345.60` becomes `1234560`. A malformed amount is refused before the call.
 *   - Declaring reopens the control (the computed side resets until the next check answers it), which
 *     the confirmation says, so re-declaring is understood as intentional, never a silent overwrite.
 *   - Nothing is minted: it wires `migration_declare_control_total`, already in the registry.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Select } from '../../components/Select';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The key a declared figure is identified by: one figure per (control kind, scope). */
const SEP = '\0';
const declaredKey = (d: { kind: string; scope: string }): string => `${d.kind}${SEP}${d.scope}`;

/** The inverse of `francsToMinor`: integer Rappen back to a plain franc string (`1234560` -> `12345.60`). */
export function minorToFrancs(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The declarable control kinds (engine `declarable: true`); each carries its default scope. */
const DECLARABLE = [
  { kind: 'trial_balance_matches_source', defaultScope: '' },
  { kind: 'ar_control', defaultScope: 'workspace' },
  { kind: 'ap_control', defaultScope: 'workspace' },
  { kind: 'vat_balance_at_cutover', defaultScope: 'workspace' },
] as const;

const KIND_KEY: Record<string, string> = {
  trial_balance_matches_source: 'trialBalanceMatchesSource',
  ar_control: 'arControl',
  ap_control: 'apControl',
  vat_balance_at_cutover: 'vatBalanceAtCutover',
};

/** A control kind as its catalogue label, falling back to the raw id when a kind has no key yet. */
function kindLabel(t: (key: string) => string, kind: string): string {
  const key = `check.kind.${KIND_KEY[kind] ?? kind}`;
  const hit = t(key);
  return hit === key ? kind : hit;
}

/** Parse a franc amount (`12'345.60`, `12345,60`, `-80`) to integer Rappen, or null when malformed. */
export function francsToMinor(input: string): number | null {
  const cleaned = input.replace(/['\s]/g, '').replace(',', '.').trim();
  if (cleaned === '' || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const rappen = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -rappen : rappen;
}

interface Declared {
  kind: string;
  scope: string;
  amount: string;
}

export function ControlTotals(props: { workspaceId: string; planId: string }): React.ReactElement {
  const { workspaceId, planId } = props;
  const client = useClient();
  const t = useT();

  const [kind, setKind] = useState<string>(DECLARABLE[0].kind);
  const [scope, setScope] = useState('');
  const [amount, setAmount] = useState('');
  const [amountHint, setAmountHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declared, setDeclared] = useState<Declared[]>([]);
  // f8: the figures the operator declared PERSIST in the engine and gate the Eröffnungsprüfung, but
  // the list was session-local, so it read as empty after a reload. Fetch the already-declared totals
  // on mount from the newest check's controls (migration_get_check exposes declared_minor per control).
  const [existing, setExisting] = useState<Declared[]>([]);
  // f8: re-declaring an existing figure is never a silent overwrite (the header promise). A confirm
  // fires ONLY on a RE-declare of a (kind, scope) that already carries a figure, never on a first one.
  const [confirmRedeclare, setConfirmRedeclare] = useState<{ kind: string; scope: string; amount: string; minor: number } | null>(null);

  const load = useCallback(async () => {
    const listed = (await client.call('migration_list_checks', { workspaceId, planId })).body;
    if (isErr(listed)) return;
    const newest = ((listed.checks ?? []) as Array<{ checkId: string }>)[0];
    if (newest === undefined) return;
    const full = (await client.call('migration_get_check', { workspaceId, checkId: newest.checkId })).body;
    if (isErr(full)) return;
    const controls = (full.controls ?? []) as Array<{ kind: string; scope: string; declaredMinor: number | null }>;
    setExisting(
      controls
        .filter((c) => c.declaredMinor !== null)
        .map((c) => ({ kind: c.kind, scope: c.scope, amount: minorToFrancs(c.declaredMinor as number) })),
    );
  }, [client, workspaceId, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pickKind(next: string): void {
    setKind(next);
    const def = DECLARABLE.find((d) => d.kind === next);
    setScope(def?.defaultScope ?? '');
    setError(null);
    setConfirmRedeclare(null);
  }

  /** Every (kind, scope) that already carries a declared figure, from the engine and from this session. */
  const declaredKeys = new Set<string>([...existing.map(declaredKey), ...declared.map(declaredKey)]);

  async function submitDeclare(): Promise<void> {
    const minor = francsToMinor(amount);
    if (minor === null) {
      setAmountHint(true);
      return;
    }
    const effectiveScope = scope.trim() === '' ? 'workspace' : scope.trim();
    // A RE-declare of an existing figure asks first; a first declare of a new (kind, scope) does not.
    if (declaredKeys.has(declaredKey({ kind, scope: effectiveScope }))) {
      setConfirmRedeclare({ kind, scope: effectiveScope, amount, minor });
      return;
    }
    await performDeclare(kind, effectiveScope, minor, amount);
  }

  async function performDeclare(k: string, s: string, minor: number, displayAmount: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = (
        await client.call('migration_declare_control_total', {
          workspaceId,
          planId,
          kind: k,
          scope: s,
          declaredMinor: minor,
          idempotencyKey: newIdempotencyKey(),
        })
      ).body;
      if (isErr(res)) {
        setError(res.error === 'unknown_control_kind' ? 'unknownKind' : 'generic');
        return;
      }
      // Overlay onto the session list keyed by (kind, scope), so a re-declare replaces its row.
      setDeclared((prev) => [{ kind: k, scope: s, amount: displayAmount }, ...prev.filter((d) => declaredKey(d) !== declaredKey({ kind: k, scope: s }))]);
      setAmount('');
      setAmountHint(false);
      setConfirmRedeclare(null);
    } finally {
      setBusy(false);
    }
  }

  const needsAccountScope = kind === 'trial_balance_matches_source';

  // The declared figures on screen: this session's declares (newest first), then the engine's
  // already-declared figures for any (kind, scope) this session has not re-declared. One row per figure.
  const sessionKeys = new Set(declared.map(declaredKey));
  const merged: Declared[] = [...declared, ...existing.filter((e) => !sessionKeys.has(declaredKey(e)))];

  return (
    <section className="control-totals" aria-label={t('migration.controlTotals.title')}>
      <h2>{t('migration.controlTotals.title')}</h2>
      <p className="control-totals-body">{t('migration.controlTotals.body')}</p>

      <form
        className="control-totals-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submitDeclare();
        }}
      >
        <label htmlFor="ct-kind">{t('migration.controlTotals.kind')}</label>
        <Select
          id="ct-kind"
          value={kind}
          onChange={(val) => pickKind(val)}
          options={DECLARABLE.map((d) => ({ value: d.kind, label: t(`check.kind.${KIND_KEY[d.kind]}`) }))}
          ariaLabel={t('migration.controlTotals.kind')}
        />

        <label htmlFor="ct-scope">{needsAccountScope ? t('migration.controlTotals.scope.account') : t('migration.controlTotals.scope.workspace')}</label>
        <input
          className="field"
          id="ct-scope"
          type="text"
          value={scope}
          placeholder={needsAccountScope ? t('migration.controlTotals.scope.accountHint') : 'workspace'}
          onChange={(e) => setScope(e.target.value)}
        />

        <label htmlFor="ct-amount">{t('migration.controlTotals.amount')}</label>
        <input
          className="field"
          id="ct-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          aria-invalid={amountHint ? true : undefined}
          aria-describedby="ct-amount-hint"
          onChange={(e) => {
            setAmount(e.target.value);
            setAmountHint(false);
            setConfirmRedeclare(null);
          }}
        />
        <span id="ct-amount-hint" className="control-totals-hint">{t('migration.controlTotals.amountHint')}</span>
        {amountHint && <p className="control-totals-error" role="alert">{t('migration.controlTotals.amountInvalid')}</p>}

        {error !== null && <p className="control-totals-error" role="alert">{t(`migration.controlTotals.err.${error}`)}</p>}

        <button type="submit" className="btn btn--secondary" disabled={busy || amount.trim() === ''}>
          {t('migration.controlTotals.declare')}
        </button>
      </form>

      {/* f8: a RE-declare confirms first, because the header promise is that re-declaring is never a
          silent overwrite. It fires only for a (kind, scope) that already carries a figure (D118 C4:
          the confirm is proportional to the risk, never a blanket confirm on every declare). */}
      {confirmRedeclare !== null && (
        <div className="control-totals-redeclare" role="group" aria-label={t('migration.controlTotals.redeclare.title')}>
          <p>{t('migration.controlTotals.redeclare.body')}</p>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void performDeclare(confirmRedeclare.kind, confirmRedeclare.scope, confirmRedeclare.minor, confirmRedeclare.amount)}
          >
            {t('migration.controlTotals.redeclare.confirm')}
          </button>
          <button className="btn btn--secondary" type="button" onClick={() => setConfirmRedeclare(null)}>{t('migration.intake.back')}</button>
        </div>
      )}

      {merged.length > 0 && (
        <ul className="control-totals-declared" aria-label={t('migration.controlTotals.declaredTitle')}>
          {merged.map((d) => (
            <li key={declaredKey(d)}>
              {t('migration.controlTotals.declaredRow', {
                kind: kindLabel(t, d.kind),
                scope: d.scope,
                amount: d.amount,
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ControlTotals;
