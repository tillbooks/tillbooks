import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import getFixture from './get-document.fixture.json';

/**
 * A canned handler exactly as the transport calls it: the request input in, a RestResponse out.
 *
 * Spies are declared `vi.fn<CannedHandler>(...)` rather than bare `vi.fn(...)`, so that
 * `spy.mock.calls[0][0]` is the request the surface actually sent. Inferred from a zero-argument
 * implementation the calls tuple is empty, and every assertion about what the surface asked for is
 * a compile error the moment anyone type-checks this file.
 */
type CannedHandler = (input: Record<string, unknown>) => RestResponse;

type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

const VAT_PREVIEW = ok({ ok: true, kind: 'output', netMinor: 150000, taxMinor: 12150, grossMinor: 162150, rateBp: 810, deductible: false, formLine: '303', trace: { taxCode: 'UST81', taxBaseMinor: 150000, taxAmountMinor: 12150 } });

function renderDetail(canned: Canned, initial = '/documents/doc_1') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={[initial]}>
            <Routes>
              <Route path="/documents/*" element={<DocumentsSurface />} />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const contact = ok({ contact: { id: 'ct_1', name: 'Muster AG' } });

/** A get_document response for a given document body (issued quote from the fixture by default). */
function doc(overrides: Record<string, unknown> = {}) {
  return ok({ document: { ...getFixture.document, ...overrides }, lines: getFixture.lines, history: getFixture.history });
}

describe('DocumentDetail, success render', () => {
  it('shows the header, the status timeline, and the read-only positions', async () => {
    renderDetail({ get_document: doc(), get_contact: contact, vat_preview: VAT_PREVIEW });
    expect(await screen.findByRole('heading', { name: /O-2026-0001/ })).toBeInTheDocument();
    expect(screen.getByText('Muster AG')).toBeInTheDocument();
    // The timeline carries the status words (draft -> issued), never colour alone.
    const timeline = screen.getByLabelText('Statusverlauf');
    expect(within(timeline).getByText('Entwurf')).toBeInTheDocument();
    expect(within(timeline).getByText('Ausgestellt')).toBeInTheDocument();
    // Read-only positions.
    expect(screen.getByText('Beratung')).toBeInTheDocument();
  });

  it('renders a not-found state for an unknown id', async () => {
    renderDetail({ get_document: reject('not_found'), get_contact: contact });
    expect(await screen.findByText('Beleg nicht gefunden')).toBeInTheDocument();
  });
});

describe('DocumentDetail, C3 provenance', () => {
  it('names the actor that created the document, verbatim from the creation history row', async () => {
    // The fixture creation row (`null -> draft`) carries `actor: 'user_1'`.
    renderDetail({ get_document: doc(), get_contact: contact, vat_preview: VAT_PREVIEW });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    expect(screen.getByText(/Erfasst durch user_1/)).toBeInTheDocument();
  });

  it('names the agent in words when the creating actor is the agent', async () => {
    const agentHistory = [
      { fromStatus: null, toStatus: 'draft', actor: 'agent', at: '2026-07-16T00:00:00.000Z' },
      ...getFixture.history.slice(1),
    ];
    renderDetail({
      get_document: ok({ document: getFixture.document, lines: getFixture.lines, history: agentHistory }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    expect(screen.getByText(/Erfasst durch den Agenten/)).toBeInTheDocument();
  });

  it('shows the neutral form and no fabricated name when the creating actor is null', async () => {
    const nullActorHistory = [
      { fromStatus: null, toStatus: 'draft', actor: null, at: '2026-07-16T00:00:00.000Z' },
      ...getFixture.history.slice(1),
    ];
    renderDetail({
      get_document: ok({ document: getFixture.document, lines: getFixture.lines, history: nullActorHistory }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    // The C3 line is the "Erfasst, <date>" one below the header; no "durch <name>" is invented.
    expect(screen.getByText(/^Erfasst,/)).toBeInTheDocument();
    expect(screen.queryByText(/Erfasst durch/)).not.toBeInTheDocument();
  });
});

describe('DocumentDetail, legal actions only (D19/M23)', () => {
  it('offers Senden as the primary on an issued document and calls transition_document', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => doc({ status: 'sent' }));
    renderDetail({ get_document: doc(), get_contact: contact, vat_preview: VAT_PREVIEW, transition_document: transitionSpy });
    const send = await screen.findByRole('button', { name: 'Senden' });
    await userEvent.click(send);
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1', to: 'sent' });
  });

  it('converts an accepted quote to an invoice and opens the target', async () => {
    const convertSpy = vi.fn<CannedHandler>(() => ok({ document: { ...getFixture.document, id: 'doc_target', type: 'invoice', status: 'draft', number: null } }));
    renderDetail({
      get_document: (input) =>
        (input.documentId as string) === 'doc_target'
          ? doc({ id: 'doc_target', type: 'invoice', status: 'draft', number: null })
          : doc({ status: 'accepted' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
      convert_document: convertSpy,
    });
    const convert = await screen.findByRole('button', { name: 'In Rechnung umwandeln' });
    await userEvent.click(convert);
    await waitFor(() => expect(convertSpy).toHaveBeenCalledOnce());
    expect(convertSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1', toType: 'invoice' });
  });

  // A10-G5: the waiting-for-payment line used to render for EVERY action-less state, so a converted
  // quote and a cancelled document both claimed to await money. Only a sent invoice does.
  it('claims to wait for payment only on a sent invoice (A10-G5)', async () => {
    renderDetail({
      get_document: doc({ type: 'invoice', status: 'sent', number: 'R-2026-0001', postedEntryId: 'entry_1' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    expect(await screen.findByText('wartet auf Zahlung')).toBeInTheDocument();
  });

  it('does NOT claim to wait for payment on a converted quote or a cancelled document (A10-G5)', async () => {
    const { unmount } = renderDetail({
      get_document: doc({ status: 'converted' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
      list_documents: ok({ documents: [], truncated: false, total: 0, ceiling: 1000 }),
    });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    expect(screen.queryByText('wartet auf Zahlung')).not.toBeInTheDocument();
    unmount();

    renderDetail({
      get_document: doc({ type: 'invoice', status: 'cancelled', number: 'R-2026-0001' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /R-2026-0001/ });
    expect(screen.queryByText('wartet auf Zahlung')).not.toBeInTheDocument();
  });

  // A10-G6: a converted document was a dead end, with zero links to what it became.
  it('links a converted document forward using the read model, with no list_documents scan', async () => {
    // No `list_documents` handler is canned on purpose: the forward link now rides
    // `targetDocumentId` on the document itself. If the surface ever went back to scanning, the
    // fake transport would answer 404/unknown_action and the link would not render at all.
    renderDetail({
      get_document: doc({ status: 'converted', targetDocumentId: 'doc_target' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    const link = await screen.findByRole('link', { name: 'Zielbeleg öffnen' });
    expect(link).toHaveAttribute('href', '/documents/doc_target');
  });

  // The scan it replaced read one page of `list_documents`, so past D34's 1000-row ceiling the
  // target fell off the page and the link silently disappeared. A truncated list must not matter
  // any more, and a document that really has no target must still show nothing.
  it('links forward even when list_documents would be truncated past the D34 ceiling', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ documents: [], truncated: true, total: 4000, ceiling: 1000 }));
    renderDetail({
      get_document: doc({ status: 'converted', targetDocumentId: 'doc_target' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
      list_documents: listSpy,
    });
    const link = await screen.findByRole('link', { name: 'Zielbeleg öffnen' });
    expect(link).toHaveAttribute('href', '/documents/doc_target');
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('shows no target link when the read model reports no conversion target (A10-G6)', async () => {
    renderDetail({
      get_document: doc({ status: 'converted', targetDocumentId: null }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /O-2026-0001/ });
    expect(screen.queryByRole('link', { name: 'Zielbeleg öffnen' })).not.toBeInTheDocument();
  });

  // M16/GAP A: the recipient is durable evidence, so a plain reload (no send in this session, no
  // dialog opened) still names it. This is the state that used to be unreachable.
  it('names the recipient on a reload, read off sentToEmail and never from local state', async () => {
    renderDetail({
      get_document: doc({
        type: 'invoice',
        status: 'sent',
        number: 'R-2026-0001',
        postedEntryId: 'entry_1',
        sentToEmail: 'kunde@example.ch',
      }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    expect(await screen.findByText('Versendet an kunde@example.ch')).toBeInTheDocument();
  });

  it('claims no recipient for a document that was never transmitted', async () => {
    renderDetail({
      get_document: doc({ type: 'invoice', status: 'issued', number: 'R-2026-0001', sentToEmail: null }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
    });
    await screen.findByRole('heading', { name: /R-2026-0001/ });
    expect(screen.queryByText(/Versendet an/)).not.toBeInTheDocument();
  });

  it('cancels a posted document via the overflow behind a confirm dialog', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => doc({ status: 'cancelled' }));
    renderDetail({
      get_document: doc({ type: 'invoice', status: 'issued', number: 'R-2026-0001', postedEntryId: 'entry_1' }),
      get_contact: contact,
      vat_preview: VAT_PREVIEW,
      transition_document: transitionSpy,
    });
    await screen.findByRole('heading', { name: /R-2026-0001/ });
    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für R-2026-0001' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stornieren' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(transitionSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stornieren' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1', to: 'cancelled' });
  });
});
