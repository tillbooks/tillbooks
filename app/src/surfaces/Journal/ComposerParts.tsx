/**
 * The A1 composer's pieces (A02 §6, owner pick 01.10.2026): the MWST control, the one-line VAT caption,
 * the Beleg paperclip and its chip, and the grid's balance status. Presentational only: the drawer owns
 * the state, the reads and every write. Strings come from the Journal catalogue, money from
 * `formatMoney` in the base currency the drawer hands in.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { useT, useTRich, formatMoney } from '../../i18n';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import { Tooltip } from '../../components/Tooltip';
import { CloseGlyph } from '../../components/icons';
import { CheckGlyph } from '../../components/states/glyphs';
import { COMMITTED_ATTR, commitAck } from '../../lib/motion';
import { TaxCodePicker } from '../Vat/TaxCodePicker';
import { LineVatReadout } from '../Vat/LineVatReadout';
import type { LineVat } from '../Vat/types';
import type { ComposeCaption } from '../../../../src/core/ledger/compose';
import type { TaxCode } from './types';
import { PaperclipGlyph } from './glyphs';

// --- MWST ---------------------------------------------------------------------------------------------

export interface MwstControlProps {
  /** The control's accessible name, carrying the line's identity on the grid ("MWST 1"). */
  label: string;
  codes: readonly TaxCode[];
  value: string;
  onChange: (code: string) => void;
  /** Which way the money runs on this line, so the fitting codes lead the list. */
  direction?: 'in' | 'out';
  /** The workspace has no tax codes: the "MWST einrichten" link stands in for the control (P9). */
  needsConfig: boolean;
  /** The actor may not post: the code reads as text, no control. */
  readOnly: boolean;
  /** The code is not among the active ones (archived or unknown, an old draft): flagged inline. */
  invalidCode: boolean;
  /** M5: a non-import code left on a VAT-account line: flagged inline. */
  stranded: boolean;
}

/**
 * The MWST control: the typeable `TaxCodeCombobox` ("8.1", "Bezug", "VST"), "Ohne MWST" always first, so
 * a code can always be emptied. The two states the shared `TaxCodePicker` owns (unconfigured, read-only)
 * are its own rendering, never a second copy of the link or the text.
 */
export function MwstControl({ label, codes, value, onChange, direction, needsConfig, readOnly, invalidCode, stranded }: MwstControlProps) {
  const t = useT();
  const errorId = useId();
  // The trigger shows the CODE only, so the accounts beside it keep their room; the code's full label is
  // in the trigger's accessible name and in a real tooltip (the screenshot review, 01.10.2026).
  const current = codes.find((c) => c.code === value);
  const name = current !== undefined ? t('entry.mwstNamed', { label, code: current.code, name: current.label }) : label;
  if (needsConfig || readOnly) {
    return (
      <TaxCodePicker ariaLabel={label} codes={[]} value={value} onChange={onChange} needsConfig={needsConfig} readOnly={readOnly} />
    );
  }
  return (
    <div className="journal-tax">
      {current !== undefined ? (
        <Tooltip content={`${current.code} ${current.label}`}>
          <span className="journal-tax-tip">
            <TaxCodeCombobox label={name} codes={codes} value={value} onChange={onChange} direction={direction} className="journal-tax-trigger" />
          </span>
        </Tooltip>
      ) : (
        <TaxCodeCombobox label={name} codes={codes} value={value} onChange={onChange} direction={direction} className="journal-tax-trigger" />
      )}
      {(invalidCode || stranded) && (
        <p id={errorId} role="alert" className="vat-code-error">
          {stranded ? t('vat.error.vatAccountTag') : t('vat.error.archivedCode')}
        </p>
      )}
    </div>
  );
}

// --- The one-line VAT caption -------------------------------------------------------------------------

export interface VatCaptionProps {
  /** The engine's caption for this line (`compose_entry`), null for an untaxed line, undefined in flight. */
  caption: ComposeCaption | null | undefined;
  /** The flagged code's own message already says why; no figure beside it (A06-G3). */
  suppressed: boolean;
  currency: string;
  accountNumber: (id: string) => string;
}

/** A manual-path caption (or a refused code) in the shape the shared per-line readout reads. */
function readoutOf(caption: ComposeCaption): LineVat {
  if (!caption.ok) return { ok: false, error: caption.error };
  return {
    ok: true,
    kind: caption.kind,
    netMinor: caption.net,
    taxMinor: caption.tax,
    grossMinor: caption.gross,
    rateBp: caption.rateBp,
    deductible: caption.deductible,
    formLine: caption.formLine,
    trace: { taxCode: null, taxBaseMinor: caption.net, taxAmountMinor: caption.tax },
  };
}

/**
 * ONE quiet line under a taxed line: "davon MWST CHF 8.07 auf 1170 · netto CHF 99.63". Every figure and
 * account in it is the ENGINE'S caption (`compose_entry`), never one the Studio worked out. On the manual
 * path the line is booked as typed, so it reads the shared per-line readout instead (tax and gross of that
 * net), as does a code the engine could not price.
 */
export function VatCaption({ caption, suppressed, currency, accountNumber }: VatCaptionProps) {
  const t = useT();
  if (caption === undefined || caption === null || suppressed) return null;
  if (!caption.ok || !caption.derived) return <LineVatReadout vat={readoutOf(caption)} currency={currency} />;
  const money = (minor: number) => formatMoney(minor, currency);
  const tax = money(caption.tax);
  const legs = caption.vatLegs;
  let text: string;
  if (caption.kind === 'zero') text = t('entry.vatCaption.zero');
  else if (caption.kind === 'exempt') text = t('entry.vatCaption.exempt');
  else if (caption.kind === 'reverse_charge') {
    const owed = legs.find((l) => l.credit > 0);
    const deducted = legs.find((l) => l.debit > 0);
    text =
      owed !== undefined && deducted !== undefined
        ? t('entry.vatCaption.reverseCharge', { tax, owed: accountNumber(owed.account), deducted: accountNumber(deducted.account) })
        : owed !== undefined
          ? t('entry.vatCaption.reverseChargeOwed', { tax, owed: accountNumber(owed.account) })
          : t('entry.vatCaption.noLeg', { tax });
  } else if (caption.kind === 'import') {
    // The assessed tax IS the booking: it lands on 1170 as Vorsteuer, or in the expense when it is not
    // deductible (saldo). There is no separate leg to name.
    text = caption.deductible ? t('entry.vatCaption.importTax', { tax }) : t('entry.vatCaption.importCost', { tax });
  } else if (caption.folded) text = t('entry.vatCaption.folded', { tax });
  else if (caption.vatAccount !== null) {
    text = t('entry.vatCaption.taxed', { tax, account: accountNumber(caption.vatAccount), net: money(caption.net) });
  } else text = t('entry.vatCaption.noLeg', { tax });
  return <p className="journal-caption">{text}</p>;
}

// --- Beleg --------------------------------------------------------------------------------------------

/** A Beleg picked before the entry has an id: filed at once, linked once the entry exists. */
export interface PendingBeleg {
  name: string;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  fileId: string | null;
  /** Minted once per pick, so a retry repeats the same upload and the same link, never a second copy. */
  uploadKey: string;
  linkKey: string;
}

export interface BelegControlProps {
  beleg: PendingBeleg | null;
  onPick: (file: File) => void;
  onRemove: () => void;
  disabled: boolean;
}

/**
 * The paperclip: an icon button with a name and a real tooltip, over a hidden file input. A picked file
 * shows as a chip with its own remove control.
 */
export function BelegControl({ beleg, onPick, onRemove, disabled }: BelegControlProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (beleg !== null) {
    return (
      <span className="journal-beleg-chip" data-status={beleg.status}>
        <PaperclipGlyph size={16} />
        <span className="journal-beleg-name">{beleg.name}</span>
        {beleg.status === 'uploading' && <span className="journal-beleg-state">{t('entry.beleg.uploading')}</span>}
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm"
          aria-label={t('entry.beleg.remove', { name: beleg.name })}
          onClick={onRemove}
        >
          <CloseGlyph size={16} />
        </button>
      </span>
    );
  }
  return (
    <>
      <Tooltip content={t('entry.beleg.attachTip')}>
        <button
          type="button"
          className="btn btn--secondary btn--icon journal-beleg-button"
          aria-label={t('entry.beleg.attach')}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <PaperclipGlyph size={16} />
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        hidden
        data-testid="journal-beleg-input"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked !== undefined) onPick(picked);
        }}
      />
    </>
  );
}

// --- The grid's balance status ------------------------------------------------------------------------

/**
 * Stamp the Commit tint on a figure that changed, RESTARTING it when an earlier tint is still running:
 * the stamp is lifted and a style flush is forced before it is set again (the same reflow
 * `motion.ts` uses to restart the Navigate entrance), because lifting and re-setting an attribute in
 * one task is no change at all to the style engine, and the second change would ride out the first
 * tint's remainder. The timing stays the `--t-motion-tint` token, through `commitAck`.
 */
function retint(el: HTMLElement | null): () => void {
  if (el === null) return () => undefined;
  el.removeAttribute(COMMITTED_ATTR);
  void el.offsetWidth;
  return commitAck(el);
}

/**
 * "Ausgeglichen" with a check glyph, or the difference with its sign in danger: glyph or sign and words,
 * never colour alone. Nothing at all while nothing is typed.
 *
 * When the figure changes (a typed amount moved the difference, or the grid came into balance) it takes
 * the Commit moment's tint (D122 D-I), so the eye finds the total that answered the keystroke. Tint
 * only (Journal.css): the figure never rolls or lands, and its box does not change, so nothing shifts.
 * The first render tints nothing: an entry opened in balance has not changed.
 */
export function BalanceStatus({ debitTotal, creditTotal, currency }: { debitTotal: number; creditTotal: number; currency: string }) {
  const t = useT();
  const tRich = useTRich();
  const difference = debitTotal - creditTotal;
  const figureRef = useRef<HTMLSpanElement | null>(null);
  const shown = debitTotal > 0 && difference === 0 ? 'balanced' : debitTotal > 0 || creditTotal > 0 ? String(difference) : 'none';
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = shown;
    // The first run is the mount, which is not a change. `before === shown` is NOT dead code: under
    // <StrictMode> (src/main.tsx) React runs a mount effect twice, and the second run sees the value
    // the first one recorded; without this guard an entry that opens in balance would tint at once.
    if (before === null || before === shown) return undefined;
    return retint(figureRef.current);
  }, [shown]);
  let body: ReactNode = null;
  if (debitTotal > 0 && difference === 0) {
    body = (
      <span ref={figureRef} className="journal-balance journal-balance--ok">
        <CheckGlyph size={16} />
        {t('entry.balanced')}
      </span>
    );
  } else if (debitTotal > 0 || creditTotal > 0) {
    body = (
      <span ref={figureRef} className="journal-balance journal-balance--off">
        {tRich('entry.difference', { amount: <span className="t-money">{formatMoney(difference, currency)}</span> })}
      </span>
    );
  }
  return (
    <span className="journal-balance-slot" aria-live="polite">
      {body}
    </span>
  );
}
