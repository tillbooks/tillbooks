/**
 * A41.5 (D184 point 7, the owner-approved "Bankzeilen freigeben" artifact v3): the row's "Sicherheit" column.
 * How sure TILL is about a line, at a glance: three dots, then a word or two ("Regel", "6× so", "Prüfen,
 * Neu"), the engine's reason sentence on hover. Glyph PLUS words, never colour alone; only a `check` line
 * colours its one dot (the artifact: "Nur hier hat die Zeile Farbe").
 *
 * NOTHING IS COMPUTED HERE. The certainty is the engine's: with a pending agent Vorschlag it is the A41.2
 * evidence's (`vorschlagEvidence.certainty`, TILL's own proposal compared with the agent's), and a
 * Vorschlag the engine has no evidence for reads as the engine's `attention` says (`needs`: look first);
 * without one it is the proposal's. The short words are a lookup of the engine's reason code and its
 * `reasonParams.count`, never a score.
 */
import { useT } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import type { BankInboxLine, Certainty, LineVorschlag, RowDraft } from './model';
import { isUntouched } from './model';
import type { Lookups } from './lookups';
import { reasonSentence } from './lookups';

/** What the column shows for one open line. `edited`: the person changed the booking (TILL's word no longer applies). */
export interface Confidence {
  level: Certainty | 'edited';
  /** The short reason key under `bankInbox.confidence.short`, or null for none. */
  short: string | null;
  /** `reasonParams.count` of a history proposal ("6× so"). */
  count: number | null;
}

/** The reason codes that share one short word. */
const SHORT_OF_REASON: Readonly<Record<string, string>> = {
  standard: 'rule',
  rule_needs_amount: 'ruleAsks',
  rule_computed: 'rule',
  rule_ignore: 'rule',
  several_rules: 'severalRules',
  existing_entry_reference: 'reference',
  qr_reference_exact: 'reference',
  payment_batch_reference: 'reference',
  payment_batch_item: 'reference',
  vendor_bill_reference: 'reference',
  qr_reference_amount_differs: 'amountDiffers',
  payment_batch_total_differs: 'amountDiffers',
  payment_batch_item_amount_differs: 'amountDiffers',
  existing_entry_amount_date: 'amountDate',
  vendor_bill_amount: 'amount',
  own_account_transfer: 'transfer',
  own_account_transfer_booked: 'transfer',
  history: 'history',
  journal_history: 'journal',
  model_suggested: 'model',
};

function countOf(params: unknown): number | null {
  const c = typeof params === 'object' && params !== null ? (params as Record<string, unknown>).count : undefined;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** The column's reading of a line: the engine's certainty and its reason, or `edited`. */
export function confidenceOf(line: BankInboxLine, draft: RowDraft | undefined, vorschlag: LineVorschlag | undefined): Confidence {
  const evidence = line.vorschlagEvidence ?? vorschlag?.evidence ?? null;
  const agentDrafted = vorschlag !== undefined || (line as BankInboxLine & { vorschlagActionId?: unknown }).vorschlagActionId != null;
  if (agentDrafted && (draft === undefined || draft.source === 'agent' || draft.source === 'proposal')) {
    if (evidence !== null) {
      const engineCount = evidence.engine.reasonCode === 'history' ? countOf(evidence.engine.reasonParams) : null;
      return { level: evidence.certainty, short: evidence.agrees ? 'agentAgrees' : 'agentDiffers', count: engineCount };
    }
    // The engine's `attention` folds a pending Vorschlag in as `needs`: look first.
    return { level: 'check', short: 'agent', count: null };
  }
  if (!isUntouched(line, draft)) return { level: 'edited', short: null, count: null };
  const proposal = line.proposal;
  if (proposal === null || proposal.certainty === 'open') return { level: 'open', short: null, count: null };
  const code: string = proposal.reasonCode;
  const short = SHORT_OF_REASON[code] ?? null;
  return { level: proposal.certainty, short, count: code === 'history' ? countOf(proposal.reasonParams) : null };
}

/** How many of the three dots a level fills. */
export function dotsOf(level: Confidence['level']): number {
  return level === 'sure' ? 3 : level === 'learned' ? 2 : level === 'check' ? 1 : 0;
}

/** The words the cell shows: "Regel", "6× so", "Prüfen, Neu", "Kein Vorschlag". */
export function confidenceWords(t: ReturnType<typeof useT>, c: Confidence): string {
  if (c.level === 'edited') return t('bankInbox.confidence.edited');
  if (c.level === 'open') return t('bankInbox.confidence.open');
  const short = c.short === null ? '' : c.short === 'history' && c.count !== null ? t('bankInbox.confidence.short.historyCount', { count: c.count }) : t(`bankInbox.confidence.short.${c.short}`);
  if (c.level === 'check') return short === '' ? t('bankInbox.confidence.check') : t('bankInbox.confidence.checkWith', { reason: short });
  return short === '' ? t(`bankInbox.certainty.${c.level}`) : short;
}

/** The cell: the dots, the words, and the engine's reason on hover. */
export function ConfidenceCell({ line, draft, vorschlag, lookups }: { line: BankInboxLine; draft: RowDraft | undefined; vorschlag: LineVorschlag | undefined; lookups: Lookups }) {
  const t = useT();
  const c = confidenceOf(line, draft, vorschlag);
  const words = confidenceWords(t, c);
  const certaintyWord = c.level === 'edited' ? t('bankInbox.certainty.edited') : t(`bankInbox.certainty.${c.level}`);
  const sentence = c.short === 'agentAgrees' ? t('bankInbox.evidence.agrees') : c.short === 'agentDiffers' || c.short === 'agent' ? t('bankInbox.confidence.agentTip') : reasonSentence(t, lookups, line);
  const tip = [certaintyWord, sentence].filter((x) => x !== '').join(': ');
  const filled = dotsOf(c.level);
  return (
    <Tooltip content={tip}>
      {/* No focus stop of its own (one per row would be noise): the review view says the same in words. */}
      <span className="bank-conf" data-confidence={c.level}>
        <span className="bank-conf__dots" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <i key={i} className={i < filled ? 'bank-conf__dot bank-conf__dot--on' : 'bank-conf__dot'} />
          ))}
        </span>
        {words !== certaintyWord && <span className="visually-hidden">{`${certaintyWord}: `}</span>}
        <span className="bank-conf__words">{words}</span>
      </span>
    </Tooltip>
  );
}
