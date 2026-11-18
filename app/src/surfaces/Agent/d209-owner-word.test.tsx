/**
 * D209: an approval the agent took on the owner's word reads differently in the trace from a person's and from
 * one under the standing grant, and shows the owner's words (and when they were said) on hover; the parsers read
 * the row history defensively.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { Turn } from './TurnList';
import { parseDecidedOnOwnerWord, type AgentCall, type AgentTurn } from './model';
import { decidedByOf, decidedOnOwnerWordOf } from './vorschlagView';

function call(over: Partial<AgentCall>): AgentCall {
  return {
    callId: 'c1', seq: 1, verb: 'import_bank_statement', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask',
    dialCapability: 'post', ok: true, errorCode: null, entityRef: null, durationMs: 3, at: '2026-11-18T10:00:00Z',
    agentActionId: 'aa1', draftStatus: 'executed', rejectReason: null, ...over,
  };
}

const turnOf = (c: AgentCall): AgentTurn => ({ turnId: 't1', seq: 1, role: 'agent', text: null, at: '2026-11-18T10:00:00Z', calls: [c] });

describe('D209 trace: approved on the owner\'s word', () => {
  it('says so, and shows the words with their date on hover', () => {
    render(<I18nProvider><Turn turn={turnOf(call({ decidedOnOwnerWord: { quote: 'Beide genehmigt.', saidAt: '2026-11-18T09:55:00.000Z' } }))} /></I18nProvider>);
    const chip = screen.getByText('Vom Agenten ausgeführt, im Chat freigegeben');
    expect(chip.getAttribute('data-decided-by')).toBe('owner-word');
    expect(chip.getAttribute('title')).toBe('«Beide genehmigt.», 2026-11-18');
  });

  it('a person\'s approval reads as before', () => {
    render(<I18nProvider><Turn turn={turnOf(call({ decidedOnOwnerWord: null }))} /></I18nProvider>);
    expect(screen.getByText('Genehmigt').getAttribute('data-decided-by')).toBe('person');
  });
});

describe('D209 parsers', () => {
  it('read the owner\'s words defensively', () => {
    expect(parseDecidedOnOwnerWord(undefined)).toBeNull();
    expect(parseDecidedOnOwnerWord({ quote: 3, saidAt: 'x' })).toBeNull();
    expect(parseDecidedOnOwnerWord({ quote: 'ja', saidAt: '2026-11-18' })).toEqual({ quote: 'ja', saidAt: '2026-11-18' });
    expect(decidedOnOwnerWordOf(null)).toBeNull();
    expect(decidedOnOwnerWordOf([{ event: 'decided_under_grant' }, { event: 'decided_on_owner_word', quote: 'ja', saidAt: '2026-11-18', grantedBy: 'studio' }])).toEqual({ quote: 'ja', saidAt: '2026-11-18', grantedBy: 'studio' });
  });

  it('group who decided: open, a person, the agent under the grant, the owner\'s word', () => {
    expect(decidedByOf({ resolvedAt: null, decidedUnderGrant: null, decidedOnOwnerWord: null })).toBeNull();
    expect(decidedByOf({ resolvedAt: '2026-11-18', decidedUnderGrant: null, decidedOnOwnerWord: null })).toBe('person');
    expect(decidedByOf({ resolvedAt: '2026-11-18', decidedUnderGrant: { decision: 'approved', grantedBy: 'studio', grantedAt: 'x' }, decidedOnOwnerWord: null })).toBe('agent');
    expect(decidedByOf({ resolvedAt: '2026-11-18', decidedUnderGrant: null, decidedOnOwnerWord: { quote: 'ja', saidAt: 'x', grantedBy: 'studio' } })).toBe('ownerWord');
  });
});
