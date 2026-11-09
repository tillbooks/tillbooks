/**
 * TaxCodeCombobox: the searchable MWST picker (A2, the bank inbox; the journal's per-line tax field
 * may adopt it later). A searchable list, never a native `<select>`: the owner asked for the VAT code
 * the way the account is picked, by typing its code, its rate or its name ("8.1", "Bezug", "VST").
 *
 * It is a face over `PickerButton` (the account picker's own popover), so the keyboard contract is
 * the same one: the search field has focus on open, the arrows walk, Enter picks, Escape and Tab
 * close. The list leads with the codes that fit the MONEY'S DIRECTION (money out: Vorsteuer,
 * Bezugsteuer, Einfuhrsteuer; money in: Umsatzsteuer, befreit, ausgenommen) and keeps every other
 * active code one group down, because a refund booked against an input code is legitimate and the
 * engine mirrors it. "Ohne MWST" is always the first row: booking without a code is a real answer
 * (bank fees, transfers, wages), not a missing one.
 *
 * The codes are the workspace's own (`vat_codes`), so the list is exactly what the engine admits.
 */
import { useMemo } from 'react';

import { useT } from '../i18n';
import { codeRateClass, displayRateBp } from '../lib/vatRates';
import { PickerButton, type ComboboxGroup, type ComboboxOption } from './AccountCombobox';

export interface TaxCodeLike {
  code: string;
  kind: string;
  rateBp: number;
  label: string;
  /** The ESTV Ziffer (400 Material, 405 Betriebsaufwand); tells the two Vorsteuer families apart. */
  formLine?: string | null;
}

type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * D167: a code in words a person reads, never the code: "Vorsteuer 8.1 %", "Umsatzsteuer 2.6 %". The
 * rate is the one the engine books on `date` (a zero-rate Vorsteuer seed code is the Normalsatz of the
 * supply date, 8.1 % from 2024, 7.7 % before). A code without a rate is its kind alone ("Befreit").
 */
export function taxCodeName(t: T, c: TaxCodeLike, date?: string | null): string {
  const kind = t(`taxCode.kind.${c.kind}`);
  const rate = displayRateBp(c.kind, c.rateBp, date);
  return rate > 0 ? t('taxCode.rated', { kind, rate: (rate / 100).toFixed(1) }) : kind;
}

/**
 * D167 polish 7: the FIELD's words for a code. The Betriebsaufwand family (Ziffer 405) reads distinct from
 * Material (400) on the field itself, "Vorsteuer 8.1 % (Betrieb)"; the full statutory label is the field's
 * tooltip. Every other code reads as its name.
 */
/** The Vorsteuer family a field names beside the rate ("Betrieb" for Ziffer 405), or null for any other code. */
export function taxCodeFamily(t: T, c: TaxCodeLike): string | null {
  return c.kind === 'input' && c.formLine === '405' ? t('taxCode.hint.operatingShort') : null;
}

export function taxCodeFieldName(t: T, c: TaxCodeLike, date?: string | null): string {
  const name = taxCodeName(t, c, date);
  return c.kind === 'input' && c.formLine === '405' ? t('taxCode.ratedFamily', { name, family: t('taxCode.hint.operatingShort') }) : name;
}

/**
 * The short dim hint under a code's name: which Vorsteuer family (Ziffer 400 or 405), which
 * Umsatzsteuer rate, else the code's own statutory label.
 */
export function taxCodeHint(t: T, c: TaxCodeLike): string {
  if (c.kind === 'input' && c.formLine === '400') return t('taxCode.hint.material');
  if (c.kind === 'input' && c.formLine === '405') return t('taxCode.hint.operating');
  if (c.kind === 'output') {
    const cls = codeRateClass(c.kind, c.rateBp);
    if (cls !== null) return t(`taxCode.hint.${cls}`);
  }
  return c.label;
}

const FAMILY_RANK: Record<string, number> = { '400': 0, '405': 1 };
const CLASS_RANK: Record<string, number> = { normal: 0, reduced: 1, accommodation: 2 };

/** The human order: the Material family first, then Betriebsaufwand; within each, 8.1, 2.6, 3.8. */
function humanOrder(a: TaxCodeLike, b: TaxCodeLike): number {
  const fam = (c: TaxCodeLike) => FAMILY_RANK[c.formLine ?? ''] ?? 2;
  const cls = (c: TaxCodeLike) => CLASS_RANK[codeRateClass(c.kind, c.rateBp) ?? ''] ?? 3;
  return fam(a) - fam(b) || cls(a) - cls(b) || a.code.localeCompare(b.code);
}

export interface TaxCodeComboboxProps {
  /** The trigger's accessible name, carrying the row's identity ("MWST, Alpina Telecom"). */
  label: string;
  codes: readonly TaxCodeLike[];
  /** The chosen code, or '' for "ohne MWST". */
  value: string;
  onChange: (code: string) => void;
  /** Which way the money runs, so the fitting codes lead. */
  direction?: 'in' | 'out';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  triggerRef?: (el: HTMLButtonElement | null) => void;
  /**
   * Opt-in (D167, the bank row's MWST field): "Ohne MWST" alone at the top, then ONLY the codes of the
   * money's direction (input codes for money out, output codes for money in) under `label`, and every
   * other code under `otherLabel`. No "Aktuell" group: the chosen row carries its check. Needs
   * `direction`; without this prop the list is grouped as it always was.
   */
  strictGroups?: { label: string; otherLabel: string };
  /**
   * Opt-in (D167, the bank row): every code reads in words ("Vorsteuer 8.1 %") with a dim hint telling
   * the families apart, never the code, in the human order; the trigger shows the same words. `date`
   * is the supply date the rate is read for (today when absent). The code stays searchable.
   */
  humanLabels?: { date?: string | null };
  /** Forwarded to the trigger, so a wrapping `Tooltip` opens on its hover and focus. */
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  'aria-describedby'?: string;
}

/** The kinds whose natural direction is money IN (a sale); every other kind is money out. */
const MONEY_IN_KINDS: ReadonlySet<string> = new Set(['output', 'zero', 'exempt']);

/** "8.1 %" for a rated code, '' for a code whose rate follows the supply date (input) or is zero. */
function rateText(rateBp: number): string {
  if (rateBp <= 0) return '';
  return `${(rateBp / 100).toFixed(1)}%`;
}

const NONE_ID = 'none';

export function TaxCodeCombobox({
  label,
  codes,
  value,
  onChange,
  direction,
  open,
  onOpenChange,
  disabled,
  className,
  triggerRef,
  strictGroups,
  humanLabels,
  ...forwarded
}: TaxCodeComboboxProps) {
  const t = useT();
  const strict = strictGroups !== undefined && direction !== undefined;
  // Read once as primitives, so a caller's inline `{ date }` does not rebuild the list on every render.
  const human = humanLabels !== undefined;
  const humanDate = humanLabels?.date ?? null;

  const { options, groups } = useMemo(() => {
    const fits = (kind: string) =>
      direction === undefined ? true : direction === 'in' ? MONEY_IN_KINDS.has(kind) : !MONEY_IN_KINDS.has(kind);
    const date = humanDate;
    const opt = (c: TaxCodeLike, group: string): ComboboxOption =>
      human
        ? {
            id: `${group}:${c.code}`,
            label: taxCodeName(t, c, date),
            meta: taxCodeHint(t, c),
            keywords: `${c.code} ${c.label} ${(displayRateBp(c.kind, c.rateBp, date) / 100).toFixed(1)} ${t(`taxCode.kind.${c.kind}`)}`,
            group,
            current: c.code === value,
          }
        : {
            id: `${group}:${c.code}`,
            code: c.code,
            label: c.label,
            meta: [t(`taxCode.kind.${c.kind}`), rateText(c.rateBp)].filter((s) => s !== '').join(', '),
            keywords: `${rateText(c.rateBp)} ${(c.rateBp / 100).toFixed(1)} ${t(`taxCode.kind.${c.kind}`)}`,
            group,
            current: c.code === value,
          };
    const ordered = human ? [...codes].sort(humanOrder) : codes;
    const none: ComboboxOption = {
      id: `natural:${NONE_ID}`,
      label: t('taxCode.none'),
      meta: t('taxCode.noneMeta'),
      keywords: t('taxCode.none'),
      group: 'natural',
      current: value === '',
    };
    const natural = ordered.filter((c) => fits(c.kind)).map((c) => opt(c, 'natural'));
    const other = ordered.filter((c) => !fits(c.kind)).map((c) => opt(c, 'other'));
    const current = codes.find((c) => c.code === value);
    const head: ComboboxOption[] =
      current !== undefined
        ? [{ ...opt(current, 'current'), id: `current:${current.code}` }]
        : value === ''
          ? [{ ...none, id: `current:${NONE_ID}`, group: 'current' }]
          : [];
    const g: ComboboxGroup[] = [
      { key: 'current', label: t('taxCode.group.current'), hideWhileSearching: true },
      { key: 'natural', label: t(direction === 'in' ? 'taxCode.group.in' : direction === 'out' ? 'taxCode.group.out' : 'taxCode.group.all') },
      { key: 'other', label: t('taxCode.group.other') },
    ];
    if (strictGroups !== undefined && direction !== undefined) {
      // D167: the direction's own kind only (Vorsteuer out, Umsatzsteuer in); "Ohne MWST" leads, alone.
      const own = (kind: string) => (direction === 'in' ? kind === 'output' : kind === 'input');
      const loose: ComboboxOption = { ...none, id: `loose:${NONE_ID}`, group: undefined };
      return {
        options: [loose, ...ordered.filter((c) => own(c.kind)).map((c) => opt(c, 'natural')), ...ordered.filter((c) => !own(c.kind)).map((c) => opt(c, 'other'))],
        groups: [
          { key: 'natural', label: strictGroups.label },
          { key: 'other', label: strictGroups.otherLabel },
        ] satisfies ComboboxGroup[],
      };
    }
    return { options: [...head, none, ...natural, ...other], groups: g };
  }, [codes, value, direction, t, strictGroups, human, humanDate]);

  const current = codes.find((c) => c.code === value);

  return (
    <PickerButton
      label={label}
      options={options}
      groups={groups}
      value={
        strict
          ? (options.find((o) => o.current === true)?.id ?? '')
          : current !== undefined
            ? `current:${current.code}`
            : value === ''
              ? `current:${NONE_ID}`
              : ''
      }
      onChange={(id) => {
        const code = id.slice(id.indexOf(':') + 1);
        onChange(code === NONE_ID ? '' : code);
      }}
      searchLabel={t('taxCode.search')}
      // The field shows the short form, so the narrow popover never cuts it; the full sentence is its name.
      searchPlaceholder={t('taxCode.searchShort')}
      noMatchLabel={t('taxCode.noMatch')}
      hint={t('picker.hint')}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      className={className}
      width={340}
      triggerRef={triggerRef}
      {...forwarded}
    >
      {current !== undefined && human ? (
        // The rate is never the part that is cut: the family tag sits apart, so a narrow field can drop it
        // (its host's container query) while "Vorsteuer 8.1 %" stays whole; the full words stay the name.
        <span className="picker-trigger__name">
          {taxCodeName(t, current, humanDate)}
          {taxCodeFamily(t, current) !== null && <span className="picker-trigger__family"> ({taxCodeFamily(t, current)})</span>}
        </span>
      ) : current !== undefined ? (
        <>
          <span className="picker-trigger__code">{current.code}</span>
          <span className="picker-trigger__name">{current.label}</span>
        </>
      ) : (
        <span className="picker-trigger__name">{t('taxCode.none')}</span>
      )}
    </PickerButton>
  );
}
