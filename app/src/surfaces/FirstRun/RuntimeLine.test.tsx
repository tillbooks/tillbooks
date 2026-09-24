/**
 * M00 runtime line component test (spec §8): every mode renders, the scheduler line is honest, the
 * agent_session residency caveat renders as text, and an unreadable status shows nothing (never a
 * wrong process line). Rendered in de-CH (the I18nProvider default).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { RuntimeLine } from './RuntimeLine';

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function transport(response: RestResponse): Transport {
  return async () => response;
}

function renderLine(response: RestResponse) {
  const client = new TillClient(transport(response));
  return render(
    <I18nProvider>
      <TillClientProvider client={client}>
        <RuntimeLine />
      </TillClientProvider>
    </I18nProvider>,
  );
}

const scheduler = { enabled: false, lastTickAt: null, nextTickAt: null };

describe('RuntimeLine', () => {
  it('renders the till up mode and the scheduler last-tick line', async () => {
    renderLine(ok({ mode: 'up', version: '0.0.0', host: '127.0.0.1', port: 8788, studioServed: true, scheduler: { enabled: true, lastTickAt: '2026-07-16T09:30:00.000Z', nextTickAt: null } }));
    expect(await screen.findByText(/Läuft als:/)).toBeInTheDocument();
    expect(screen.getByText(/till up/)).toBeInTheDocument();
    expect(screen.getByText(/letzter Tick/)).toBeInTheDocument();
  });

  it('renders the scheduler-off line when the scheduler is not running', async () => {
    renderLine(ok({ mode: 'mcp', version: '0.0.0', host: null, port: null, studioServed: false, scheduler }));
    expect(await screen.findByText(/Scheduler aus/)).toBeInTheDocument();
  });

  it('renders the residency caveat as text in agent_session mode', async () => {
    renderLine(ok({ mode: 'agent_session', version: '0.0.0', host: null, port: null, studioServed: false, scheduler }));
    expect(await screen.findByText(/Agent-Sitzung/)).toBeInTheDocument();
    expect(screen.getByText(/Cloud-Umgebung/)).toBeInTheDocument();
  });

  it('renders nothing on an unreadable status (never a wrong process line)', async () => {
    const { container } = renderLine({ status: 500, body: { ok: false, error: 'transport_error' } });
    // The line renders loading first, then removes itself once the failed read resolves.
    await waitFor(() => expect(container.querySelector('.runtime-line')).toBeNull());
  });
});
