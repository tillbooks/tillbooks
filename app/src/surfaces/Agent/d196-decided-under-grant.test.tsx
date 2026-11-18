/**
 * D196: a decision the agent took under the owner's grant reads differently in the trace from a person's
 * decision, and names the grant (who gave it, when) on hover.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { Turn } from './TurnList';
import { parseDecidedUnderGrant, type AgentCall, type AgentTurn } from './model';

function call(over: Partial<AgentCall>): AgentCall {
  return {
    callId: 'c1', seq: 1, verb: 'post_entry', kind: 'write', args: {}, mode: 'draft', decisionReason: 'dial_ask',
    dialCapability: 'post', ok: true, errorCode: null, entityRef: null, durationMs: 3, at: '2026-11-12T10:00:00Z',
    agentActionId: 'aa1', draftStatus: 'rejected', rejectReason: 'falscher Faktor', ...over,
  };
}

function turnOf(c: AgentCall): AgentTurn {
  return { turnId: 't1', seq: 1, role: 'agent', text: null, at: '2026-11-12T10:00:00Z', calls: [c] };
}

describe('D196 trace: decided under the owner\'s grant', () => {
  it('a person\'s rejection reads as before', () => {
    render(<I18nProvider><Turn turn={turnOf(call({ decidedUnderGrant: null }))} /></I18nProvider>);
    const chip = screen.getByText('Abgelehnt: falscher Faktor');
    expect(chip.getAttribute('data-decided-by')).toBe('person');
    expect(chip.getAttribute('title')).toBeNull();
  });

  it('an agent rejection under the grant says so and names the grant on hover', () => {
    const grant = { decision: 'rejected' as const, grantedBy: 'studio', grantedAt: '2026-11-12T09:00:00Z' };
    render(<I18nProvider><Turn turn={turnOf(call({ decidedUnderGrant: grant }))} /></I18nProvider>);
    const chip = screen.getByText('Vom Agenten abgelehnt');
    expect(chip.getAttribute('data-decided-by')).toBe('agent');
    expect(chip.getAttribute('title')).toBe('Freigabe erteilt im Studio am 2026-11-12');
  });

  it('an agent approval under the grant says so', () => {
    const grant = { decision: 'approved' as const, grantedBy: 'studio', grantedAt: '2026-11-12T09:00:00Z' };
    render(<I18nProvider><Turn turn={turnOf(call({ draftStatus: 'executed', rejectReason: null, decidedUnderGrant: grant }))} /></I18nProvider>);
    expect(screen.getByText('Vom Agenten genehmigt').getAttribute('data-decided-by')).toBe('agent');
  });

  it('parses defensively: an unreadable grant is a person\'s decision', () => {
    expect(parseDecidedUnderGrant(undefined)).toBeNull();
    expect(parseDecidedUnderGrant({ decision: 'maybe', grantedBy: 'x', grantedAt: 'y' })).toBeNull();
    expect(parseDecidedUnderGrant({ decision: 'approved', grantedBy: 'studio', grantedAt: '2026-11-12' })).toEqual({ decision: 'approved', grantedBy: 'studio', grantedAt: '2026-11-12' });
  });
});
