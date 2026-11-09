/**
 * A41.3 re-cut v2 (D184, I-F): whether a captured receipt's figures may back an UNATTENDED booking, said as a
 * glyph plus words (never colour alone), with "Zahlen bestätigen" while they are not trusted. The engine
 * decides (`figuresTrust` on `list_captures` / `get_capture`: `confirmed`, `qr`, or null); this only says it.
 * A not-trusted capture whose amount an agent (or the local model) read says so: that is the case the
 * confirmation exists for. Used beside a candidate or assigned receipt in the bank line's review view and in
 * the Belegeingang's capture drawer.
 */
import { useT } from '../i18n';
import { StatusNeutralGlyph, StatusSuccessGlyph } from './icons';
import './FigureTrust.css';

export type FiguresTrust = 'confirmed' | 'qr' | null;

export interface FigureTrustLineProps {
  trust: FiguresTrust;
  /** Who read the live amount (the field's provenance), when known. */
  amountProvenance?: string | null;
  /**
   * Every field the confirmation vouches for, as the person sees it: one labelled element each (security review:
   * a free-text value laid out as one string could imitate another field).
   */
  fields?: readonly { key: string; label: string; text: string }[];
  /** Why the figures cannot be confirmed here, said instead of the button (fail closed). */
  blockedReason?: string;
  /** Offer "Zahlen bestätigen" (the person may; the capture is under review). */
  onConfirm?: (() => void) | null;
  busy?: boolean;
}

export function figureTrustWords(t: ReturnType<typeof useT>, trust: FiguresTrust, amountProvenance: string | null | undefined): string {
  if (trust === 'confirmed') return t('figureTrust.confirmed');
  if (trust === 'qr') return t('figureTrust.qr');
  if (amountProvenance === 'agent' || amountProvenance === 'local_model') return t('figureTrust.agentRead');
  return t('figureTrust.unconfirmed');
}

export function FigureTrustLine({ trust, amountProvenance = null, fields = [], blockedReason, onConfirm = null, busy = false }: FigureTrustLineProps) {
  const t = useT();
  const trusted = trust !== null;
  return (
    <div className="figure-trust" data-trust={trust ?? 'none'}>
      <span className="figure-trust__mark">
        {trusted ? <StatusSuccessGlyph size={16} /> : <StatusNeutralGlyph size={16} />}
        <span>{figureTrustWords(t, trust, amountProvenance)}</span>
      </span>
      {fields.length > 0 && (
        <dl className="figure-trust__fields">
          {fields.map((f) => (
            <div key={f.key} className="figure-trust__field" data-field={f.key}>
              <dt>{f.label}</dt>
              {/* Each value isolated left to right: a bidi character cannot reorder it or its neighbours. */}
              <dd dir="ltr" className={f.key === 'amount' || f.key === 'vat_amount' ? 'figure-trust__value t-money' : 'figure-trust__value'}>
                {f.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!trusted && blockedReason !== undefined && <span className="figure-trust__blocked">{blockedReason}</span>}
      {!trusted && blockedReason === undefined && onConfirm !== null && (
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onConfirm}>
          {t('figureTrust.confirm')}
        </button>
      )}
    </div>
  );
}
