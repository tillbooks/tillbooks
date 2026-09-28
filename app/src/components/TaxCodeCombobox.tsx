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
import { PickerButton, type ComboboxGroup, type ComboboxOption } from './AccountCombobox';

export interface TaxCodeLike {
  code: string;
  kind: string;
  rateBp: number;
  label: string;
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
}: TaxCodeComboboxProps) {
  const t = useT();

  const { options, groups } = useMemo(() => {
    const fits = (kind: string) =>
      direction === undefined ? true : direction === 'in' ? MONEY_IN_KINDS.has(kind) : !MONEY_IN_KINDS.has(kind);
    const opt = (c: TaxCodeLike, group: string): ComboboxOption => ({
      id: `${group}:${c.code}`,
      code: c.code,
      label: c.label,
      meta: [t(`taxCode.kind.${c.kind}`), rateText(c.rateBp)].filter((s) => s !== '').join(', '),
      keywords: `${rateText(c.rateBp)} ${(c.rateBp / 100).toFixed(1)} ${t(`taxCode.kind.${c.kind}`)}`,
      group,
      current: c.code === value,
    });
    const none: ComboboxOption = {
      id: `natural:${NONE_ID}`,
      label: t('taxCode.none'),
      meta: t('taxCode.noneMeta'),
      keywords: t('taxCode.none'),
      group: 'natural',
      current: value === '',
    };
    const natural = codes.filter((c) => fits(c.kind)).map((c) => opt(c, 'natural'));
    const other = codes.filter((c) => !fits(c.kind)).map((c) => opt(c, 'other'));
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
    return { options: [...head, none, ...natural, ...other], groups: g };
  }, [codes, value, direction, t]);

  const current = codes.find((c) => c.code === value);

  return (
    <PickerButton
      label={label}
      options={options}
      groups={groups}
      value={current !== undefined ? `current:${current.code}` : value === '' ? `current:${NONE_ID}` : ''}
      onChange={(id) => {
        const code = id.slice(id.indexOf(':') + 1);
        onChange(code === NONE_ID ? '' : code);
      }}
      searchLabel={t('taxCode.search')}
      noMatchLabel={t('taxCode.noMatch')}
      hint={t('picker.hint')}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      className={className}
      width={340}
      triggerRef={triggerRef}
    >
      {current !== undefined ? (
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
