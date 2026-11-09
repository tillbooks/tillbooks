/**
 * N01 US-N01.8 at the surface: the agent's own sentence (`agentReason`, stored on the Vorschlag and listed by
 * `list_drafted_actions`) is shown QUOTED under the line's title, in both the Agent tab's line and the
 * Pendenzen line (which builds its action through `vorschlagOf`), and nothing is shown when the agent gave
 * none. Synthetic data only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, ALLOW_ALL } from '../../lib/capabilities';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport } from '../../lib/client';
import { WorkspaceProvider } from '../../app/workspace';
import { VorschlagLine } from './VorschlagLine';
import { parseDrafted, type DraftedAction } from './model';
import { vorschlagOf } from '../Attention/model';

const quiet: Transport = async () => ({ status: 200, body: { ok: true } });

function wrap(node: React.ReactNode) {
  return render(
    <TillClientProvider client={new TillClient(quiet)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesContext.Provider value={ALLOW_ALL}>
            <MemoryRouter initialEntries={['/agent']}>{node}</MemoryRouter>
          </CapabilitiesContext.Provider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const post: DraftedAction = {
  actionId: 'act_1',
  actor: 'agent',
  dialCapability: 'post',
  actionTool: 'post_entry',
  agentReason: 'Quittung Papeterie Muster vom 1. März, bar bezahlt',
  payload: { workspaceId: 'ws_test', date: '2026-03-01', lines: [{ account: 'acc_6500', debit: 4850 }, { account: 'acc_1000', credit: 4850 }] },
  status: 'pending',
  createdAt: '2026-03-01T09:00:00.000Z',
  rejectReason: null,
  figures: null,
  changedSinceProposal: false,
};

const reason = () => document.querySelector('.vorschlag-line-reason');

beforeEach(() => {
  window.localStorage.clear();
});

describe('N01: the agent reason on a Vorschlag', () => {
  it('reads agentReason off the drafted list, and null when the agent gave none or a blank', () => {
    const parsed = parseDrafted({
      actions: [
        { actionId: 'a1', actionTool: 'post_entry', agentReason: 'Weil die Quittung vorliegt', payload: {} },
        { actionId: 'a2', actionTool: 'post_entry', payload: {} },
        { actionId: 'a3', actionTool: 'post_entry', agentReason: '   ', payload: {} },
      ],
    });
    expect(parsed.map((a) => a.agentReason)).toEqual(['Weil die Quittung vorliegt', null, null]);
  });

  it('shows the sentence quoted under the title, with whose words they are for a screen reader', () => {
    wrap(<VorschlagLine action={post} onApprove={() => undefined} onReject={() => undefined} />);
    const node = reason();
    expect(node).not.toBeNull();
    expect(node?.textContent).toBe('Begründung des Agenten:«Quittung Papeterie Muster vom 1. März, bar bezahlt»');
    expect(node?.getAttribute('title')).toBe('Quittung Papeterie Muster vom 1. März, bar bezahlt');
    expect(node?.querySelector('.visually-hidden')?.textContent).toBe('Begründung des Agenten:');
  });

  it('shows nothing when the agent gave no reason', () => {
    wrap(<VorschlagLine action={{ ...post, agentReason: null }} onApprove={() => undefined} onReject={() => undefined} />);
    expect(reason()).toBeNull();
  });

  it('the Pendenzen line carries the reason from the drafted read (vorschlagOf)', () => {
    const item = {
      queueId: 'agent_vorschlaege',
      entityKind: 'agent_action',
      entityId: 'act_1',
      titleKey: 'attention.item.vorschlag',
      titleParams: {},
      since: '2026-03-01T09:00:00.000Z',
      count: 1,
      urgency: 'normal',
      deepLink: { route: '/agent', params: {} },
    } as unknown as Parameters<typeof vorschlagOf>[0];
    expect(vorschlagOf(item, post).agentReason).toBe(post.agentReason);
    expect(vorschlagOf(item, undefined).agentReason).toBeNull();
  });
});
