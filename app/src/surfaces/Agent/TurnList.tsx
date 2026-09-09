/**
 * The turn and its call trace (design §3b/§3c), shared by the dock and the Gespräche archive.
 *
 * A turn leads with WHAT HAPPENED (a derived outcome line, visibly a summary and never in quotation
 * marks) and keeps the trace collapsed above `TRACE_COLLAPSE_THRESHOLD` calls. A partially failed
 * turn names the completed writes and the failures SEPARATELY and never implies a rollback, because
 * each call was its own transaction and the earlier ones are in the books: this is the one place the
 * surface could lie about the ledger, so the wording is fixed here and asserted in the tests.
 *
 * A trace row is glyph PLUS word (gelesen / ausgeführt / Entwurf / verweigert / fehlgeschlagen),
 * never colour alone; the raw verb name and arguments live behind a per-row Details disclosure and
 * the raw key survives as the row's title.
 */
import { useState } from 'react';

import { useT } from '../../i18n';
import { LABELLED_VERBS, TRACE_COLLAPSE_THRESHOLD, type AgentCall, type AgentTurn } from './model';

function verbLabel(t: (key: string) => string, verb: string): string {
  return LABELLED_VERBS.has(verb) ? t(`agent.verb.${verb}`) : verb.replace(/_/g, ' ');
}

function statusOf(call: AgentCall): { glyph: string; key: string } {
  if (call.mode === 'deny') return { glyph: '⊘', key: 'verweigert' };
  if (!call.ok) return { glyph: '!', key: 'fehlgeschlagen' };
  if (call.mode === 'draft') return { glyph: '◪', key: 'entwurf' };
  if (call.kind === 'read') return { glyph: '○', key: 'gelesen' };
  return { glyph: '●', key: 'ausgefuehrt' };
}

/**
 * The derived outcome line: composed from the calls, in the product's own words, never a quote.
 *
 * THE PARTIAL TURN IS THE ONE PLACE THIS SURFACE COULD LIE ABOUT THE LEDGER, and the critic's F5
 * caught the first cut doing exactly that (a read and a pending draft counted as "in den Büchern",
 * plus a measured-looking "0 nicht gestartet" the trace cannot know). The rule now: ONLY an
 * executed, successful WRITE is "in den Büchern", and each one is NAMED individually; a pending
 * draft is its own clause (inert until a human approves); reads are never claimed as ledger
 * effects; and no figure renders that nothing measured. Never a rollback implication: what
 * executed stays named precisely BECAUSE it is still in the books.
 */
function outcomeLine(t: (key: string, params?: Record<string, string | number>) => string, calls: AgentCall[]): string {
  if (calls.length === 0) return '';
  const failed = calls.filter((c) => !c.ok && c.mode !== 'deny').length;
  const denied = calls.filter((c) => c.mode === 'deny').length;
  const drafted = calls.filter((c) => c.mode === 'draft' && c.ok).length;
  const executedWrites = calls.filter((c) => c.kind === 'write' && c.mode === 'execute' && c.ok);
  const reads = calls.filter((c) => c.kind === 'read' && c.ok).length;

  if (failed > 0) {
    const parts: string[] = [];
    if (executedWrites.length > 0) {
      // Name each completed write individually: they are in the books and stay there.
      parts.push(t('agent.turn.partialBooked', { verbs: executedWrites.map((c) => verbLabel(t, c.verb)).join(', ') }));
    } else {
      parts.push(t('agent.turn.partialNothingBooked'));
    }
    parts.push(t('agent.turn.partialFailed', { n: failed }));
    if (drafted > 0) {
      parts.push(drafted === 1 ? t('agent.turn.partialDraftedOne') : t('agent.turn.partialDrafted', { n: drafted }));
    }
    return parts.join(' · ');
  }
  if (denied > 0 && executedWrites.length === 0 && drafted === 0) return t('agent.turn.denied');
  if (drafted > 0) return t('agent.turn.drafted');
  if (executedWrites.length > 0) {
    return executedWrites.length === 1
      ? t('agent.turn.writesOne')
      : t('agent.turn.writes', { n: executedWrites.length });
  }
  return reads === 1 ? t('agent.turn.readsOne') : t('agent.turn.reads', { n: reads });
}

function TraceRow({ call }: { call: AgentCall }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const status = statusOf(call);
  return (
    <li className="trace-row" title={call.verb}>
      <div className="trace-row-line">
        <span className="trace-status" data-status={status.key}>
          <span aria-hidden="true">{status.glyph}</span> {t(`agent.trace.status.${status.key}`)}
        </span>
        <span className="trace-label">{verbLabel(t, call.verb)}</span>
        {call.dialCapability !== null && call.mode === 'draft' && (
          // The row's REAL decision (critic F15): `force_ask` is the strong default asking, not the
          // ordinary ask level, and the two words teach two different facts about the dial.
          <span className="trace-dial">
            {t('agent.card.level', {
              level: call.decisionReason === 'force_ask' ? t('agent.trust.fragtImmer') : t('agent.trust.level.ask'),
            })}
          </span>
        )}
        {/* Where the proposal went (F-08, J5.6): a rejection names the human's reason IN the trace,
            so the next session reads it here instead of proposing the same thing again blind. */}
        {call.mode === 'draft' && call.draftStatus === 'rejected' && (
          <span className="trace-decision" data-decision="rejected">
            {call.rejectReason !== null && call.rejectReason !== ''
              ? t('agent.trace.rejectedWith', { reason: call.rejectReason })
              : t('agent.trace.rejectedNoReason')}
          </span>
        )}
        {call.mode === 'draft' && call.draftStatus === 'executed' && (
          <span className="trace-decision" data-decision="executed">{t('agent.trace.approved')}</span>
        )}
        <span className="trace-duration">{call.durationMs} ms</span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {t('agent.trace.details')}
        </button>
      </div>
      {open && (
        <div className="trace-details">
          <code>{call.verb}</code>
          {call.errorCode !== null && <code className="trace-error">{call.errorCode}</code>}
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

export function Turn({ turn }: { turn: AgentTurn }) {
  const t = useT();
  const collapsed = turn.calls.length > TRACE_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsed);
  const time = turn.at.length >= 16 ? turn.at.slice(11, 16) : turn.at;
  const totalMs = turn.calls.reduce((sum, c) => sum + c.durationMs, 0);

  return (
    <section className="agent-turn" data-role={turn.role}>
      <header className="agent-turn-head">
        <span className="agent-turn-time">{time}</span>
        <span className="agent-turn-actor">{t(turn.role === 'user' ? 'agent.turn.userLabel' : 'agent.turn.agentLabel')}</span>
      </header>
      {turn.text !== null && <p className="agent-turn-text">{turn.text}</p>}
      {turn.calls.length > 0 && (
        <>
          <p className="agent-turn-outcome">{outcomeLine(t, turn.calls)}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm agent-trace-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {turn.calls.length === 1
              ? t('agent.trace.stepsOne')
              : t('agent.trace.steps', { n: turn.calls.length })}
            {' · '}
            {(totalMs / 1000).toFixed(1)} s
          </button>
          {expanded && (
            <ul className="agent-trace">
              {turn.calls.map((call) => (
                <TraceRow key={call.callId} call={call} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function TurnList({ turns }: { turns: AgentTurn[] }) {
  return (
    <div className="agent-turns">
      {turns
        .filter((turn) => turn.text !== null || turn.calls.length > 0)
        .map((turn) => (
          <Turn key={turn.turnId} turn={turn} />
        ))}
    </div>
  );
}
