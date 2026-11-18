/**
 * Keyboard conformance pins for the Documents surface (TEST-29 = A10-G11, TEST-33 = A10-G15).
 *
 * Both defects were measured in July and are already fixed on develop: the S4 issue dialog is built
 * on the shared Modal (which carries the focus trap), and the type facet is a FilterBar facet, not a
 * hand-rolled tablist. These tests keep them fixed.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import DocumentsSurface from './index';
import { IssueDialog } from './IssueDialog';
import listFixture from './list-documents.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

describe('A10-G11: the S4 issue dialog traps focus', () => {
  it('eight Tabs from the open dialog never leave it', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <MemoryRouter>
          <button type="button">behind the overlay</button>
          <IssueDialog posts totalMinor={10000} currency="CHF" busy={false} error={null} onConfirm={() => {}} onCancel={() => {}} />
        </MemoryRouter>
      </I18nProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('A10-G15: the Documents type filter claims no tabs it does not implement', () => {
  it('renders no tablist and no tab role on the list', async () => {
    const transport: Transport = async (action) =>
      action === 'list_documents'
        ? ok({ documents: listFixture.documents })
        : ok({ contacts: [{ id: 'ct_1', name: 'Muster AG' }] });
    render(
      <TillClientProvider client={new TillClient(transport)}>
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
    await waitFor(() => expect(screen.getByText('O-2026-0001')).toBeInTheDocument());
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});
