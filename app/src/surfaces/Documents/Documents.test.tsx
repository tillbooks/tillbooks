import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import DocumentsSurface from './index';
import listFixture from './list-documents.fixture.json';

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

const CONTACTS = [{ id: 'ct_1', name: 'Muster AG' }];

function renderList(canned: Canned, workspaceId: string | null = 'ws_test', initial = '/documents') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
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

const happy = (): Canned => ({
  list_documents: ok({ documents: listFixture.documents }),
  list_contacts: ok({ contacts: CONTACTS }),
});

describe('Documents list, five states', () => {
  it('shows a loading skeleton while the list resolves', async () => {
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/documents']}>
              <Routes>
                <Route path="/documents/*" element={<DocumentsSurface />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The skeleton is the surface's first commit, so it proves nothing on its own: wait for the
    // list read to be genuinely in flight before calling this a loading state.
    await transport.started('list_documents');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders a no-workspace empty state without calling a ctx verb', async () => {
    const listSpy = vi.fn<CannedHandler>(() => ok({ documents: [] }));
    renderList({ list_documents: listSpy, list_contacts: ok({ contacts: [] }) }, null);
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('renders an empty state when there are no documents', async () => {
    renderList({ list_documents: ok({ documents: [] }), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByText('Noch keine Belege')).toBeInTheDocument();
  });

  it('renders an error banner when list_documents rejects', async () => {
    renderList({ list_documents: reject('invalid_input'), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a permission-denied state on permission_denied', async () => {
    renderList({ list_documents: reject('permission_denied', 403), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
  });

  it('renders the document rows with word-only status chips and the customer name', async () => {
    renderList(happy());
    expect(await screen.findByText('O-2026-0001')).toBeInTheDocument();
    // The draft invoice shows the "(Entwurf)" placeholder, never a provisional number (ST9).
    expect(screen.getByText('(Entwurf)')).toBeInTheDocument();
    expect(screen.getByText('Ausgestellt')).toBeInTheDocument();
    expect(screen.getByText('Entwurf')).toBeInTheDocument();
    expect(screen.getAllByText('Muster AG').length).toBeGreaterThan(0);
  });

  it('has no axe violations on the success render', async () => {
    const { container } = renderList(happy());
    await screen.findByText('O-2026-0001');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Documents list, truncation notice (D34)', () => {
  it('renders a quiet notice when the engine flags the list as truncated', async () => {
    renderList({
      list_documents: ok({ documents: listFixture.documents, truncated: true, total: 1234, ceiling: 1000 }),
      list_contacts: ok({ contacts: CONTACTS }),
    });
    // Truncation is never silent: the user is told the list shows the first 1000 of 1234.
    expect(await screen.findByText(/Zeigt die ersten 1000 von 1234 Belegen\./)).toBeInTheDocument();
  });

  it('renders no truncation notice when the list is complete', async () => {
    renderList(happy());
    await screen.findByText('O-2026-0001');
    expect(screen.queryByText(/Zeigt die ersten/)).not.toBeInTheDocument();
  });
});

describe('Documents list, filter tabs', () => {
  it('drives a ?type= filter through list_documents', async () => {
    const listSpy = vi.fn((input: Record<string, unknown>) =>
      ok({ documents: input.type === 'invoice' ? [listFixture.documents[0]] : listFixture.documents }),
    );
    renderList({ list_documents: listSpy, list_contacts: ok({ contacts: CONTACTS }) });
    await screen.findByText('O-2026-0001');
    await userEvent.click(screen.getByRole('tab', { name: 'Rechnung' }));
    await waitFor(() =>
      expect(listSpy.mock.calls.some((c) => (c[0] as Record<string, unknown>).type === 'invoice')).toBe(true),
    );
  });
});

describe('Documents list, row storno', () => {
  it('cancels a posted document via the overflow behind a confirm dialog', async () => {
    const transitionSpy = vi.fn<CannedHandler>(() => ok({ document: { status: 'cancelled' } }));
    renderList({ ...happy(), transition_document: transitionSpy });
    const row = (await screen.findByText('O-2026-0001')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Aktionen für O-2026-0001' }));
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Stornieren' }));
    // The confirm dialog gates the destructive act; nothing is sent until it is confirmed.
    const dialog = await screen.findByRole('alertdialog');
    expect(transitionSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stornieren' }));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledOnce());
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ documentId: 'doc_1', to: 'cancelled' });
  });
});
