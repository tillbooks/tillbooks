/**
 * F00's "Wartet auf dich" strip (D90 D-2): its own loading, denied, empty, failed and pending states,
 * fed by G15's `attention_summary`. It must never show a fake zero: a denied actor renders nothing
 * (the padlock lives on the hub), an all-clear is a quiet line, and pending work is a link into
 * `/attention`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { AttentionStrip } from './AttentionStrip';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function renderStrip(transport: Transport) {
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter>
            <AttentionStrip />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const canned = (body: RestResponse): Transport => async () => body;

describe('the F00 attention strip', () => {
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
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('with work waiting: a link into /attention naming the count and the leading item', async () => {
    renderStrip(
      canned(
        ok({
          visibleQueues: 1,
          total: 4,
          top: [{ titleKey: 'attention.item.qrMatch.title', titleParams: {} }],
        }),
      ),
    );
    const link = await screen.findByRole('button');
    expect(link).toHaveTextContent(/4 warten auf dich/);
    expect(link).toHaveTextContent('Zahlung ohne Zuordnung');
  });

  it('failed: a muted line with a retry, never a stale or fake number', async () => {
    renderStrip(canned({ status: 422, body: { ok: false, error: 'boom' } }));
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Erneut versuchen/ })).toBeInTheDocument();
  });
});
