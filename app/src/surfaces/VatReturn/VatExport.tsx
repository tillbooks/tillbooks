/**
 * A07's primary action: the eCH-0217 file, and the cross-check that ships with it.
 *
 * THE SLOT WAS HELD OPEN FOR THIS, and it is now filled. `VatReturn.tsx` shipped with NO primary
 * action and said so on the journey strip, because `vat_export_ech0217` did not exist and a disabled
 * button in the accent slot advertises a capability by shape while withholding it. The verb landed,
 * so owner decision W3 applies as written: the export takes `.btn--primary`, the solid accent fill,
 * and "Als eingereicht markieren" stays `.btn--secondary` behind its confirm. That is the same law
 * `Periods.tsx` set, where the reversible `closeMonth` is primary and the irreversible `closeYear`
 * is not.
 *
 * NOTHING HERE TRANSMITS ANYTHING, and the copy never lets that be inferred. There is no ESTV
 * submission API. The button produces a file in the operator's downloads folder; step 4 of the
 * journey is a link to the portal where a person uploads it themselves. `transmits: false` is in the
 * engine's own payload for the same reason.
 *
 * THE ENGINE SENDS THE MARKUP, NOT BASE64. A08's `ExportAction` decodes base64 because it carries
 * PDF bytes; eCH-0217 is a UTF-8 XML document and `xml` is the string itself. The half of the
 * pattern that matters is reused verbatim: the Blob is saved under the ENGINE's `filename` with the
 * ENGINE's `contentType`, so the file the browser writes is the file the verb described.
 *
 * A SUCCESSFUL EXPORT GETS NO CONFIRMATION. The file arriving is the feedback, per DESIGN.md, and
 * `ExportAction` set the precedent. The ONE exception is the tax cross-check, and it is not a
 * confirmation: eCH-0217 carries no per-rate tax figure, so the ESTV recomputes from the declared
 * turnovers, and where the books rounded differently the gap is REAL and lands at the authority. It
 * is shown only when it is non-zero, because a nil difference is the thing that needs no telling.
 *
 * A FAILED EXPORT RENDERS ON THE PAGE WITH A NEXT STEP, and is never a toast. Twelve refusal codes
 * group into four remedies plus a plain failure: `exportRefusalOf` in `model.ts` owns that mapping
 * and documents why each code sits where it does.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';

import { isErr } from '../../lib/client';
import { useClient } from '../../lib/client-context';
import { useT, formatMoney } from '../../i18n';
import { ExternalGlyph } from './glyphs';
import { exportRefusalOf, parseEch0217, type ExportRefusal, type TaxCrossCheck } from './model';

/** Hand the bytes to the browser under the engine's own filename, the way A08 already does. */
function save(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface VatExportState {
  working: boolean;
  refusal: ExportRefusal | null;
  crossCheck: TaxCrossCheck | null;
  run: () => Promise<void>;
}

export interface UseVatExportInput {
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  /**
   * G22 (D127): called after the verb SUCCEEDED and the file was handed to the browser. The checklist
   * completes its export item through `checklist_item_complete`, which re-runs the export in the
   * engine and binds the return hash, so a click without a successful export can never flip it.
   */
  onExported?: () => void | Promise<void>;
}

/**
 * The read, the download and the outcome, in one place.
 *
 * A hook rather than one component because the button belongs in the header beside the period
 * picker, while the outcome needs the body's full measure to be readable: a refusal naming an ESTV
 * Ziffer and a next step does not belong squeezed under a right-aligned toolbar.
 */
export function useVatExport({ workspaceId, periodStart, periodEnd, onExported }: UseVatExportInput): VatExportState {
  const client = useClient();
  const [working, setWorking] = useState(false);
  const [refusal, setRefusal] = useState<ExportRefusal | null>(null);
  const [crossCheck, setCrossCheck] = useState<TaxCrossCheck | null>(null);

  const run = useCallback(async () => {
    setWorking(true);
    setRefusal(null);
    setCrossCheck(null);
    const { body, status } = await client.call('vat_export_ech0217', {
      workspaceId,
      periodStart,
      periodEnd,
    });
    if (isErr(body)) {
      setRefusal(exportRefusalOf(body, status));
      setWorking(false);
      return;
    }
    const artifact = parseEch0217(body);
    if (artifact === null) {
      // A 200 whose shape this surface cannot read is a failure like any other: no file is written,
      // because writing a Blob out of a payload nobody could parse is how an empty return reaches
      // the ESTV.
      setRefusal({ band: 'failed', code: '', codes: [], baseCurrency: null, configuredRates: null });
      setWorking(false);
      return;
    }
    save(artifact.filename, new Blob([artifact.xml], { type: artifact.contentType }));
    setCrossCheck(artifact.crossCheck);
    setWorking(false);
    // G22: only AFTER the verb succeeded and the file was handed over. The checklist re-verifies.
    if (onExported !== undefined) await onExported();
  }, [client, workspaceId, periodStart, periodEnd, onExported]);

  return { working, refusal, crossCheck, run };
}

/** The one solid `.btn--primary` on this surface (W3). */
export function VatExportButton({ working, onRun }: { working: boolean; onRun: () => void }) {
  const t = useT();
  return (
    <button type="button" className="btn btn--primary btn--sm" disabled={working} onClick={onRun}>
      {working ? t('vat.return.export.working') : t('vat.return.export.action')}
    </button>
  );
}

export interface VatExportOutcomeProps {
  refusal: ExportRefusal | null;
  crossCheck: TaxCrossCheck | null;
  currency: string;
  /** Re-read the return, so `RefusalPanel` says the compute refusal once and authoritatively. */
  onReload: () => void;
  /** Open the drill-down on a Ziffer the refusal named. */
  onInvestigate: (code: string) => void;
  onRetry: () => void;
}

export function VatExportOutcome({
  refusal,
  crossCheck,
  currency,
  onReload,
  onInvestigate,
  onRetry,
}: VatExportOutcomeProps) {
  const t = useT();

  if (refusal !== null) return <ExportRefusalPanel refusal={refusal} onReload={onReload} onInvestigate={onInvestigate} onRetry={onRetry} />;

  // Silent on a nil difference: the file arriving is the feedback, and a "0.00 abweichend" line
  // would train the reader to skip the one place this note ever matters.
  if (crossCheck === null || crossCheck.differenceMinor === 0) return null;

  return (
    <div className="state-panel panel vr-export-check" role="note">
      <h2 className="state-title">{t('vat.return.export.crossCheckTitle')}</h2>
      <p className="state-body">
        {t('vat.return.export.crossCheck', {
          recomputed: formatMoney(crossCheck.recomputedTaxMinor, currency),
          booked: formatMoney(crossCheck.engineTaxMinor, currency),
          difference: formatMoney(crossCheck.differenceMinor, currency),
        })}
      </p>
      <p className="state-body">{t('vat.return.export.crossCheckCause')}</p>
    </div>
  );
}

function ExportRefusalPanel({
  refusal,
  onReload,
  onInvestigate,
  onRetry,
}: {
  refusal: ExportRefusal;
  onReload: () => void;
  onInvestigate: (code: string) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const zifferList = refusal.codes.join(', ');

  const body =
    refusal.band === 'uid'
      ? t('vat.return.export.uid')
      : refusal.band === 'rateSplit'
        ? t('vat.return.export.rateSplit', { ziffern: zifferList })
        : refusal.band === 'recompute'
          ? t('vat.return.export.recompute')
          : refusal.band === 'failed'
            ? t('vat.return.export.failed')
            : refusal.code === 'unsupported_base_currency'
              ? t('vat.return.export.byHand.currency', { currency: refusal.baseCurrency ?? '' })
              : refusal.code === 'saldo_rates_exceed_form_lines'
                ? t('vat.return.export.byHand.saldoRates', { count: refusal.configuredRates ?? 0 })
                : t('vat.return.export.byHand.unmapped', { ziffern: zifferList });

  return (
    <div className="state-panel panel vr-export-refusal" role="alert">
      <h2 className="state-title">{t(`vat.return.export.title.${refusal.band}`)}</h2>
      <p className="state-body">{body}</p>
      {refusal.band === 'byHand' && <p className="state-body">{t('vat.return.export.byHand.remedy')}</p>}

      {refusal.band === 'uid' && (
        <Link className="btn btn--secondary btn--sm" to="/setup">
          {t('vat.return.export.uidCta')}
        </Link>
      )}
      {refusal.band === 'rateSplit' && refusal.codes.length > 0 && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => onInvestigate(refusal.codes[0] as string)}
        >
          {t('vat.return.export.rateSplitCta', { ziffer: refusal.codes[0] })}
        </button>
      )}
      {refusal.band === 'byHand' && (
        <a
          className="btn btn--secondary btn--sm"
          href={t('vat.return.journey.portalUrl')}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('vat.return.export.portalCta')}
          <ExternalGlyph className="vr-step-external" size={14} />
        </a>
      )}
      {refusal.band === 'recompute' && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={onReload}>
          {t('vat.return.export.reloadCta')}
        </button>
      )}
      {refusal.band === 'failed' && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
          {t('vat.return.export.retryCta')}
        </button>
      )}
    </div>
  );
}
