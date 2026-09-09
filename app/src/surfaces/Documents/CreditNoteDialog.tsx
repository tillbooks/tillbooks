/**
 * S5, the CreditNoteDialog (A13 §6): derive a Gutschrift draft from an issued invoice.
 *
 * The SELECTION is the editable object, never the derived lines (§4b.1): full, selected positions
 * with reducible quantities, or a flat net amount. Every arm caps at what is still creditable after
 * the issued credits the detail already loaded (the round-1 F6 rule), and shows that remainder, so
 * a doomed draft is refused before it exists while the ENGINE stays the authority (`over_credit` is
 * its answer, not ours). Creating navigates to the drafted Gutschrift, which opens in the shared
 * editor's constrained credit-note mode and issues from there.
 *
 * THE AMOUNT ARM SHOWS THE RESULTING GROSS (D78): the input stays NET (no second rounding opinion
 * in the client), and beside it the dialog renders the gross the ENGINE derives, so a
 * gross-anchored operator sees the mismatch before issuing. The derivation mirrors the engine's S3
 * arm with the engine's own pieces: the typed net is split over the remaining per-line nets by the
 * imported `apportionNet` (the identical largest-remainder function `createCreditNote` runs), and
 * each share's VAT is asked of `vat_preview` on the line's own code and pinned Leistungsdatum.
 * NEVER client arithmetic: the client only sums the engine's per-line grosses. While any of that is
 * unresolved (priors still loading, a preview refused, nothing typed), the readout shows NOTHING
 * rather than a figure it cannot stand behind.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ErrorBanner } from '../../components/states';
// The ENGINE's own apportionment (pure leaf module, the RecurringEditor enum-import precedent):
// the shares previewed here and the shares the engine will derive at create are ONE function.
import { apportionNet } from '../../../../src/core/sales/apportion';
import { idemKey, lineTotalMinor, parseMinor, type DocumentDto, type DocumentLine } from './model';

type Arm = 'full' | 'positions' | 'amount';

export interface CreditNoteDialogProps {
  invoice: DocumentDto;
  lines: DocumentLine[];
  /** The NET already taken by issued, non-cancelled credit notes (their subtotal sum). */
  alreadyCreditedNetMinor: number;
  /**
   * The ids of those same issued, non-cancelled credit notes. The gross readout needs their LINES
   * (which invoice position each credited how much) to weight the apportionment over the REMAINING
   * per-line nets, exactly as the engine does; with priors but no ids the readout stays silent
   * rather than weighting over figures the engine will not use.
   */
  priorCreditNoteIds?: readonly string[];
  onClose: () => void;
}

interface Selection {
  position: number;
  checked: boolean;
  /** Quantity as typed, in units (parseMilli semantics), capped at the original. */
  quantity: string;
}

export function CreditNoteDialog({
  invoice,
  lines,
  alreadyCreditedNetMinor,
  priorCreditNoteIds = [],
  onClose,
}: CreditNoteDialogProps) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();

  const remainingNet = Math.max(0, invoice.subtotalMinor - alreadyCreditedNetMinor);
  const hasPriors = alreadyCreditedNetMinor > 0;

  // A full credit derives every line verbatim, which only closes when nothing was credited before;
  // with priors on the invoice the honest arms are the partial ones, so full is not offered.
  const [arm, setArm] = useState<Arm>(hasPriors ? 'positions' : 'full');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [selection, setSelection] = useState<Selection[]>(() =>
    lines.map((l, i) => ({
      position: l.id !== undefined ? i + 1 : i + 1,
      checked: false,
      quantity: String((l.quantityMilli ?? 1000) / 1000),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const amountMinor = parseMinor(amount);

  /**
   * What each invoice position has already had credited against it, keyed by position: the client
   * half of the engine's `creditedNetByPosition`, summed from the prior credit notes' own lines
   * (`creditedLinePosition`, the §4b.1 attribution). `null` means UNRESOLVED, and the readout
   * stays silent on it. Without priors it resolves to empty immediately, no read spent.
   */
  const [creditedByPosition, setCreditedByPosition] = useState<Map<number, number> | null>(
    hasPriors ? null : new Map(),
  );
  useEffect(() => {
    if (!hasPriors || priorCreditNoteIds.length === 0 || workspaceId === null) return;
    let live = true;
    async function load() {
      const map = new Map<number, number>();
      for (const cnId of priorCreditNoteIds) {
        const { body } = await client.call('get_document', { workspaceId, documentId: cnId });
        if (isErr(body)) return; // unresolved stays unresolved: silence over a wrong weight
        for (const l of (body.lines as DocumentLine[]) ?? []) {
          const pos = l.creditedLinePosition;
          if (pos === null || pos === undefined) continue;
          map.set(pos, (map.get(pos) ?? 0) + (l.lineTotalMinor ?? 0));
        }
      }
      if (live) setCreditedByPosition(map);
    }
    void load();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, hasPriors, priorCreditNoteIds.join('|')]);

  /**
   * The D78 gross readout for the amount arm: the ENGINE's figure, asked for on every change that
   * could move it. Deliberately NOT debounced, matching the Studio's documented idiom (the
   * OpeningBalanceStep readout): the verb is a pure read against a local SQLite file, and the
   * `live` flag means an answer to a superseded question is discarded rather than rendered, which
   * is the property that matters. Every change drops the old figure FIRST, so a stale gross never
   * sits beside a fresher net.
   */
  const [grossMinor, setGrossMinor] = useState<number | null>(null);
  useEffect(() => {
    setGrossMinor(null);
    if (arm !== 'amount' || workspaceId === null) return;
    if (amountMinor <= 0 || amountMinor > remainingNet || creditedByPosition === null) return;
    const credited = creditedByPosition;
    let live = true;
    async function run() {
      // The engine's weights (S3): each line's REMAINING net, never its original one.
      const weights = lines.map(
        (l, i) => Math.max(0, (l.lineTotalMinor ?? 0) - (credited.get(l.position ?? i + 1) ?? 0)),
      );
      const shares = apportionNet(amountMinor, weights);
      const grosses = await Promise.all(
        lines.map(async (l, i) => {
          const share = shares[i] ?? 0;
          if (share === 0) return 0;
          const supplyDate = l.supplyDate ?? invoice.issueDate;
          const { body } = await client.call('vat_preview', {
            workspaceId,
            amountMinor: share,
            amountIsGross: false,
            ...(l.taxCode !== null && l.taxCode !== undefined && l.taxCode !== ''
              ? { taxCode: l.taxCode }
              : {}),
            ...(supplyDate !== null && supplyDate !== undefined ? { supplyDate } : {}),
          });
          if (isErr(body)) return null;
          return body.grossMinor as number;
        }),
      );
      if (!live) return;
      if (grosses.some((g) => g === null)) return; // one refused preview silences the whole figure
      setGrossMinor(grosses.reduce<number>((n, g) => n + (g as number), 0));
    }
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arm, amountMinor, remainingNet, creditedByPosition, workspaceId]);

  /** The net the current selection would credit, previewed with the engine's own line arithmetic. */
  const selectedNet = useMemo(() => {
    if (arm === 'full') return invoice.subtotalMinor;
    if (arm === 'amount') return amountMinor;
    let net = 0;
    selection.forEach((s, i) => {
      if (!s.checked) return;
      const line = lines[i];
      if (line === undefined) return;
      const qty = Math.round(Number(s.quantity.replace(/[\s']/g, '')) * 1000);
      const capped = Math.min(Number.isFinite(qty) && qty > 0 ? qty : 0, line.quantityMilli ?? 1000);
      net += lineTotalMinor(capped, line.unitPriceMinor);
    });
    return net;
  }, [arm, amountMinor, selection, lines, invoice.subtotalMinor]);

  const overCap = arm === 'amount' ? amountMinor > remainingNet : selectedNet > remainingNet;
  const nothingSelected =
    (arm === 'positions' && !selection.some((s) => s.checked)) || (arm === 'amount' && amountMinor <= 0);

  async function onCreate() {
    if (workspaceId === null || busy) return;
    setBusy(true);
    setError(null);
    const input: Record<string, unknown> = {
      workspaceId,
      fromInvoiceId: invoice.id,
      idempotencyKey: idemKey('credit-note-create'),
    };
    if (reason.trim() !== '') input.reason = reason.trim();
    if (arm === 'full') {
      input.mode = 'full';
    } else if (arm === 'amount') {
      input.mode = 'partial';
      input.amountMinor = amountMinor;
    } else {
      input.mode = 'partial';
      input.lines = selection
        .map((s, i) => {
          const line = lines[i];
          if (!s.checked || line === undefined) return null;
          const original = line.quantityMilli ?? 1000;
          const qty = Math.round(Number(s.quantity.replace(/[\s']/g, '')) * 1000);
          const capped = Math.min(Number.isFinite(qty) && qty > 0 ? qty : original, original);
          return capped === original ? { position: i + 1 } : { position: i + 1, quantityMilli: capped };
        })
        .filter((x): x is { position: number; quantityMilli?: number } => x !== null);
    }
    const { body } = await client.call('create_credit_note', input);
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    const draftId = (body.document as { id: string }).id;
    onClose();
    navigate(`/documents/${draftId}`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('creditNote.create')}
      closeLabel={t('document.dialog.close')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('document.issue.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--accent"
            disabled={busy || overCap || nothingSelected}
            onClick={() => void onCreate()}
          >
            {t('creditNote.createAction')}
          </button>
        </>
      }
    >
      <div className="documents-confirm-body">
          <p>{t('creditNote.forInvoice', { number: invoice.number ?? invoice.id })}</p>
          {hasPriors && (
            <p role="note">{t('creditNote.remainingNet', { amount: formatMoney(remainingNet, invoice.currency) })}</p>
          )}

          <fieldset className="documents-field">
            <legend>{t('creditNote.scope')}</legend>
            {!hasPriors && (
              <label>
                <input type="radio" name="cn-arm" checked={arm === 'full'} onChange={() => setArm('full')} />{' '}
                {t('creditNote.full')}
              </label>
            )}
            <label>
              <input type="radio" name="cn-arm" checked={arm === 'positions'} onChange={() => setArm('positions')} />{' '}
              {t('creditNote.partial')}
            </label>
            <label>
              <input type="radio" name="cn-arm" checked={arm === 'amount'} onChange={() => setArm('amount')} />{' '}
              {t('creditNote.partialAmount')}
            </label>
          </fieldset>

          {arm === 'positions' && (
            <table className="documents-detail-lines">
              <thead>
                <tr>
                  <th scope="col">{t('document.editor.description')}</th>
                  <th scope="col">{t('document.editor.quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const sel = selection[i];
                  if (sel === undefined) return null;
                  const label = l.description ?? String(i + 1);
                  return (
                    <tr key={l.id ?? i}>
                      <td>
                        <label>
                          <input
                            type="checkbox"
                            checked={sel.checked}
                            onChange={(e) =>
                              setSelection((prev) =>
                                prev.map((s, k) => (k === i ? { ...s, checked: e.target.checked } : s)),
                              )
                            }
                          />{' '}
                          {label}
                        </label>
                      </td>
                      <td>
                        <input
                          className="t-num"
                          value={sel.quantity}
                          aria-label={t('creditNote.quantityFor', { line: label })}
                          disabled={!sel.checked}
                          onChange={(e) =>
                            setSelection((prev) =>
                              prev.map((s, k) => (k === i ? { ...s, quantity: e.target.value } : s)),
                            )
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {arm === 'amount' && (
            <label className="documents-field">
              <span>{t('creditNote.amountLabel', { currency: invoice.currency })}</span>
              <input className="t-num" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              {/* D78: the resulting GROSS, engine-derived (apportionNet + vat_preview above).
                  Rendered only when resolved; a pending or refused derivation shows nothing. */}
              {grossMinor !== null && (
                <span className="documents-credit-gross" aria-live="polite">
                  {t('creditNote.grossReadout', { amount: formatMoney(grossMinor, invoice.currency) })}
                </span>
              )}
            </label>
          )}

          <label className="documents-field">
            <span>{t('creditNote.reason')}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>

          {/* The live NET preview. The amount arm additionally shows its engine-derived gross
              above (D78); on the exhausting credit D67/D71 can still move the booked VAT off the
              lines' own arithmetic by a per-class Rappen, which is why the ENGINE at issue stays
              the authority and this dialog never blocks on its own figures. */}
          <p aria-live="polite">{t('creditNote.total', { amount: formatMoney(selectedNet, invoice.currency) })}</p>
          {overCap && (
            <p className="documents-confirm-error" role="alert">
              {t('creditNote.overCap', { amount: formatMoney(remainingNet, invoice.currency) })}
            </p>
          )}
        </div>

        {error !== null && <ErrorBanner error={error} message={t('document.genericError')} />}
      </Modal>
  );
}
