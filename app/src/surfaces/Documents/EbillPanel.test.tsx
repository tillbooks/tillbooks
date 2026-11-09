/**
 * A32, the EbillPanel: all five states (loading, empty, error, success, permission-denied) plus the
 * reconciled OI1 surface (PDF/A-3b pending), the honest OP4 card, and the partner-status recovery.
 * The verb rejection codes asserted here are the codes the ENGINE emits (spec §5), never invented on
 * this side. The panel posts nothing; it only reads the delivery read model and calls the two writes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { EbillPanel } from './EbillPanel';
import type { DocumentDto } from './model';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 422, body: { ok: false, error, ...extra } });

const ALL_CAPS = ['issue', 'send', 'read_sales', 'manage_settings'];
const whoami = (caps: string[]) => ok({ actor: 'user', role: 'owner', capabilities: caps });

function makeDoc(status: string): DocumentDto {
  return { id: 'doc_1', type: 'invoice', status, number: 'RE-2026-1', currency: 'CHF', totalMinor: 100000 } as unknown as DocumentDto;
}

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'ebd_1',
  invoiceId: 'doc_1',
  artifactDocumentId: 'file_1',
  status: 'prepared',
  pdfaProfile: null,
  ebillAddressed: true,
  partnerStatus: null,
  partnerReason: null,
  businessCaseId: null,
  transmittedAt: null,
  ...over,
});

function renderPanel(canned: Canned, caps: string[] = ALL_CAPS, doc = makeDoc('issued')) {
  const transport = fakeTransport({ whoami: whoami(caps), ...canned });
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <CapabilitiesProvider>
            <MemoryRouter>
              <EbillPanel doc={doc} />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('EbillPanel', () => {
  it('empty state: an issued invoice with no deliveries offers Prepare', async () => {
    renderPanel({ ebill_delivery_status: ok({ deliveries: [] }) });
    expect(await screen.findByRole('button', { name: /Für eBill vorbereiten/i })).toBeTruthy();
  });

  it('read error (f15): a failed status read shows the error banner with a retry, NOT the empty get-started state', async () => {
    // First call rejects, the retry succeeds: the panel must offer the retry and recover, never the
    // `ebill.empty` card (which conflated a failed read with a genuinely empty invoice).
    let attempt = 0;
    const status = vi.fn<CannedHandler>(() => {
      attempt += 1;
      return attempt === 1 ? reject('unexpected_error') : ok({ deliveries: [] });
    });
    renderPanel({ ebill_delivery_status: status });
    // The error banner, not the get-started copy.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(de.ebill.loadError)).toBeTruthy();
    expect(screen.queryByText(de.ebill.empty)).toBeNull();
    expect(screen.queryByRole('button', { name: /Für eBill vorbereiten/i })).toBeNull();
    // The retry re-drives the read; on success the panel reaches the genuine empty state.
    await userEvent.click(screen.getByRole('button', { name: /Erneut versuchen/i }));
    expect(await screen.findByText(de.ebill.empty)).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('success: a prepared delivery shows its status, the recorded PDF/A gap, Download and Transmit', async () => {
    renderPanel({ ebill_delivery_status: ok({ deliveries: [delivery()] }) });
    expect(await screen.findByText('Vorbereitet')).toBeTruthy();
    // The reconciled OI1 surface: the gap is stated, conformance is never claimed.
    expect(screen.getByText(/PDF\/A-3b ausstehend/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Nutzlast herunterladen/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Übermitteln/i })).toBeTruthy();
  });

  it('error: transmit with no connector shows the honest OP4 cloud_tier card', async () => {
    const status = vi.fn<CannedHandler>(() => ok({ deliveries: [delivery()] }));
    renderPanel({
      ebill_delivery_status: status,
      ebill_transmit: ok({ transmitted: false, transmittedDeliveryId: null, reason: 'cloud_tier' }),
    });
    await screen.findByRole('button', { name: /Übermitteln/i });
    await userEvent.click(screen.getByRole('button', { name: /Übermitteln/i }));
    expect(await screen.findByText(/kein eBill-Konnektor konfiguriert/i)).toBeTruthy();
  });

  it('error: transmit needing a biller id links to Setup', async () => {
    renderPanel({
      ebill_delivery_status: ok({ deliveries: [delivery()] }),
      ebill_transmit: reject('needs_biller_pid'),
    });
    await screen.findByRole('button', { name: /Übermitteln/i });
    await userEvent.click(screen.getByRole('button', { name: /Übermitteln/i }));
    expect(await screen.findByText(/keine eBill-Biller-ID konfiguriert/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Einrichtung öffnen/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/setup');
  });

  it('error: a non-conformant payload is refused and never claimed transmitted', async () => {
    renderPanel({
      ebill_delivery_status: ok({ deliveries: [delivery()] }),
      ebill_transmit: reject('payload_not_conformant', { missing: ['pdfa_profile (need PDF/A-3b)'] }),
    });
    await screen.findByRole('button', { name: /Übermitteln/i });
    await userEvent.click(screen.getByRole('button', { name: /Übermitteln/i }));
    expect(await screen.findByText(/nicht übermittelt/i)).toBeTruthy();
  });

  it('partner REJECTED shows the reason verbatim and the recovery path', async () => {
    renderPanel({
      ebill_delivery_status: ok({ deliveries: [delivery({ status: 'transmitted', partnerStatus: 'REJECTED', partnerReason: 'unknown recipient' })] }),
    });
    expect(await screen.findByText('Abgelehnt')).toBeTruthy();
    expect(screen.getByText(/unknown recipient/)).toBeTruthy();
    expect(screen.getByText(/per E-Mail/i)).toBeTruthy();
  });

  it('a failed delivery offers Erneut vorbereiten', async () => {
    renderPanel({ ebill_delivery_status: ok({ deliveries: [delivery({ status: 'failed' })] }) });
    expect(await screen.findByRole('button', { name: /Erneut vorbereiten/i })).toBeTruthy();
  });

  it('permission-denied: without send, Übermitteln is pre-disabled with an inline reason', async () => {
    renderPanel({ ebill_delivery_status: ok({ deliveries: [delivery()] }) }, ['issue', 'read_sales']);
    await screen.findByText('Vorbereitet');
    expect(screen.queryByRole('button', { name: /Übermitteln/i })).toBeNull();
    expect(screen.getByText(/Berechtigung «Senden»/i)).toBeTruthy();
  });

  it('permission-denied: without issue, Prepare is pre-disabled with an inline reason', async () => {
    renderPanel({ ebill_delivery_status: ok({ deliveries: [] }) }, ['read_sales']);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Für eBill vorbereiten/i })).toBeNull());
    expect(screen.getByText(/Berechtigung «Ausstellen»/i)).toBeTruthy();
  });
});
