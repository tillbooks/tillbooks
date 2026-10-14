/**
 * F00's "Wartet auf dich" block (D90 D-2, extended 30.09.2026): its own loading, denied, empty, failed
 * and pending states, fed by G15's `attention_summary` through the shared live store. It must never show
 * a fake zero: a denied actor renders nothing (the padlock lives on the hub), an all-clear is a quiet
 * line, and pending work is the count plus the leading rows, each a link to the surface that settles it.
 * It re-reads live, and the rail count reads the SAME answer. All fixtures synthetic.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { AttentionBadge } from '../../app/chrome';
import { neverSettles, watchReads } from '../../test-transport';
import { announceAttentionChanged } from '../Attention/attentionSummary';
import { AttentionStrip } from './AttentionStrip';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderStrip(transport: Transport, { withBadge = false }: { withBadge?: boolean } = {}) {
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/overview']}>
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    <AttentionStrip />
                    {withBadge && <AttentionBadge />}
                    <Where />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const canned = (body: RestResponse): Transport => async () => body;

/** The synthetic EBICS rows the engine sends for a book whose bank has not activated the access yet. */
const EBICS_TOP = [
  {
    queueId: 'bank_activation',
    entityId: 'ebconn_synth_1',
    titleKey: 'attention.item.bankActivation.signLetter.title',
    titleParams: { bank: 'Synthbank' },
    subtitleKey: 'attention.item.bankActivation.signLetter.subtitle',
    subtitleParams: { bank: 'Synthbank', lastCheckAt: '2026-10-02T05:02:00.000Z' },
    urgency: 'open',
    deepLink: { route: '/bank-accounts', params: {} },
  },
  {
    queueId: 'dunning_run',
    entityId: 'dun_synth_1',
    titleKey: 'attention.item.dunningRun.title',
    titleParams: {},
    subtitleKey: 'attention.item.dunningRun.subtitle',
    subtitleParams: { count: 2, date: '2026-09-30' },
    urgency: 'due',
    deepLink: { route: '/dunning', params: { runId: 'dun_synth_1' } },
  },
];

describe('the F00 attention block', () => {
  it('loading: a read in flight, not a default', async () => {
    const transport = watchReads(neverSettles);
    renderStrip(transport);
    await transport.started('attention_summary');
    expect(screen.getByText(/geladen/)).toBeInTheDocument();
  });

  it('denied: visibleQueues 0 (total null) renders nothing, never a fake zero', async () => {
    const { container } = renderStrip(canned(ok({ visibleQueues: 0, total: null, top: [] })));
    // The loading strip paints first, then the denied answer clears it: wait for the strip to vanish.
    await waitFor(() => expect(container.querySelector('.att-strip')).toBeNull());
  });

  it('empty: total 0 is a quiet all-clear line, not a link', async () => {
    renderStrip(canned(ok({ visibleQueues: 2, total: 0, top: [] })));
    expect(await screen.findByText(/wartet nichts auf dich/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('with work waiting: the count as a heading, the leading rows as links, and a door to the hub', async () => {
    renderStrip(canned(ok({ visibleQueues: 3, total: 4, top: EBICS_TOP })));
    const block = await screen.findByRole('region', { name: '4 warten auf dich' });
    const rows = within(block).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The owner's own words lead the letter step, and the live EBICS state is on the Übersicht in words.
    expect(rows[0]).toHaveTextContent('Unterschreibe den INI-Brief für die Synthbank');
    expect(rows[0]).toHaveTextContent('Zuletzt bei der Synthbank nachgefragt: 02.10.2026, 07:02.');
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/bank-accounts');
    // The urgency is a glyph with its word for assistive tech, never colour alone.
    expect(rows[0]).toHaveTextContent('offen');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/dunning?runId=dun_synth_1');
    expect(within(block).getByRole('link', { name: /Alle Pendenzen/ })).toHaveAttribute('href', '/attention');
  });

  it('one waiting item reads in the singular', async () => {
    renderStrip(canned(ok({ visibleQueues: 1, total: 1, top: EBICS_TOP.slice(0, 1) })));
    expect(await screen.findByRole('heading', { name: '1 wartet auf dich' })).toBeInTheDocument();
  });

  it('a row opens the surface that settles it', async () => {
    renderStrip(canned(ok({ visibleQueues: 1, total: 1, top: EBICS_TOP.slice(0, 1) })));
    await userEvent.click(await screen.findByRole('link', { name: /Unterschreibe den INI-Brief/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/bank-accounts');
  });

  it('failed: a muted line with a retry, never a stale or fake number; the retry re-reads', async () => {
    let calls = 0;
    renderStrip(async () => {
      calls += 1;
      return calls === 1 ? { status: 422, body: { ok: false, error: 'boom' } } : ok({ visibleQueues: 1, total: 2, top: EBICS_TOP });
    });
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(await screen.findByRole('heading', { name: '2 warten auf dich' })).toBeInTheDocument();
  });

  it('is live: a change announced elsewhere re-reads in place, without a skeleton in between', async () => {
    let total = 1;
    const transport = watchReads(async () => ok({ visibleQueues: 1, total, top: EBICS_TOP.slice(0, 1) }));
    renderStrip(transport);
    expect(await screen.findByRole('heading', { name: '1 wartet auf dich' })).toBeInTheDocument();
    total = 3;
    act(() => announceAttentionChanged());
    // The old answer stays on screen until the new one lands (a quiet refresh, never a flicker),
    // and the re-read really went out.
    expect(screen.getByRole('heading', { name: '1 wartet auf dich' })).toBeInTheDocument();
    await transport.started('attention_summary', 2);
    expect(await screen.findByRole('heading', { name: '3 warten auf dich' })).toBeInTheDocument();
  });

  it('the rail count and the block read ONE shared answer and agree', async () => {
    const transport = watchReads(async () => ok({ visibleQueues: 2, total: 5, top: EBICS_TOP }));
    renderStrip(transport, { withBadge: true });
    expect(await screen.findByRole('heading', { name: '5 warten auf dich' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '5 offen' })).toHaveTextContent('5');
    expect(transport.asked.filter((a) => a === 'attention_summary')).toHaveLength(1);
  });

  it('has no axe violations with work listed', async () => {
    const { container } = renderStrip(canned(ok({ visibleQueues: 3, total: 4, top: EBICS_TOP })));
    await screen.findByRole('region', { name: '4 warten auf dich' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
