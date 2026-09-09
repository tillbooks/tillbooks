/**
 * S1's currency context: what a row's total is denominated IN, and what the books hold beside it.
 *
 * The Journal list carried a KNOWN GAP comment about this exact shape, and it is now closed at the
 * source: `list_journal` used to send a bare integer with no currency, so a EUR entry rendered under
 * a CHF label there and the client correctly refused to guess rather than inventing one. It now
 * sends `currency` unconditionally (null only when the entry has no lines), plus `baseTotal`,
 * `fxRate` and `baseCurrency` where a conversion actually happened.
 *
 * This list never needed that refusal for the transaction figure, because `list_documents` has
 * always sent `currency`, and it now has `totalBaseMinor` and `baseCurrency` for the second one. The
 * two surfaces name their FX keys differently on purpose (`baseTotal` pairs with `total` there,
 * `totalBaseMinor` pairs with `totalMinor` here); neither should be "fixed" into the other without
 * renaming its partner too.
 *
 * Every document body comes from `document-fx.fixture.json`, pinned to the live engine by
 * `test/sales/studio-fx-document-fixture.test.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import DocumentsSurface from './index';
import fx from './document-fx.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

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

function tree(client: TillClient) {
  return (
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
    </TillClientProvider>
  );
}

function renderList(canned: Canned) {
  return render(tree(new TillClient(fakeTransport(canned))));
}

/** The list as the engine sends it: one foreign posted row, one franc row, one draft, one pegged. */
const MIXED = (): Canned => ({
  list_documents: ok({ documents: [fx.issuedForeign, fx.issuedBase, fx.issuedPegged, fx.draftForeign] }),
  list_contacts: ok({ contacts: CONTACTS }),
});

const rowFor = (number: string) => (screen.getByText(number).closest('tr') as HTMLElement);

describe('Documents list, currency context', () => {
  it('LOADING: shows the skeleton only once the list read is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    render(tree(new TillClient(transport)));
    // `loading` starts true, so the skeleton is on screen before any effect fires: without waiting
    // for the read this assertion could not tell a load in flight from a load that never started.
    await transport.started('list_documents');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/CHF/)).not.toBeInTheDocument();
  });

  it('EMPTY: an empty list shows no figures and no stray currency labels', async () => {
    renderList({ list_documents: ok({ documents: [] }), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByText('Noch keine Belege')).toBeInTheDocument();
    expect(screen.queryByText(/CHF|EUR/)).not.toBeInTheDocument();
  });

  it('ERROR: a failed list read shows the banner and no figures', async () => {
    renderList({ list_documents: reject('invalid_input'), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/EUR/)).not.toBeInTheDocument();
  });

  it('DENIED: a refused list shows the permission state, never a row', async () => {
    renderList({ list_documents: reject('permission_denied', 403), list_contacts: ok({ contacts: [] }) });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    expect(screen.queryByText(/1'621\.50/)).not.toBeInTheDocument();
  });

  it('SUCCESS: every row names the currency its total is in', async () => {
    renderList(MIXED());
    await screen.findByText('R-2026-0001');
    // The transaction figure, denominated per row. A mixed list where one column silently mixed EUR
    // and CHF under one "Total" header is the Journal's remaining defect, not this one's.
    expect(within(rowFor('R-2026-0001')).getByText("EUR 1'621.50")).toBeInTheDocument();
    expect(within(rowFor('R-2026-0002')).getByText("CHF 1'621.50")).toBeInTheDocument();
    expect(within(rowFor('R-2026-0003')).getByText("USD 1'621.50")).toBeInTheDocument();
  });

  it('adds the base-currency total on a posted foreign row, as the engine sends it', async () => {
    renderList(MIXED());
    await screen.findByText('R-2026-0001');
    const row = rowFor('R-2026-0001');
    // Read off the pinned fixture rather than typed as a literal: this figure is the sum of the
    // posted rows' base debits, and if the engine ever stops sending it this fails here.
    expect(fx.issuedForeign.totalBaseMinor).toBe(152616);
    expect(within(row).getByText("CHF 1'526.16")).toBeInTheDocument();
    // Both readings of the same money live in the one amount cell, so the two are read together.
    const amountCell = within(row).getByText("EUR 1'621.50").closest('td') as HTMLElement;
    expect(within(amountCell).getByText("CHF 1'526.16")).toBeInTheDocument();
  });

  it('adds nothing to a base-currency row, which would be the same number twice', async () => {
    renderList(MIXED());
    await screen.findByText('R-2026-0002');
    const row = rowFor('R-2026-0002');
    // The engine sends no FX group at all here, and restating CHF 1'621.50 as a CHF base total
    // beside itself is noise on the overwhelming majority of documents.
    expect(within(row).getAllByText("CHF 1'621.50").length).toBe(1);
  });

  it('adds nothing to a DRAFT, whose baseCurrency arrives with no figures behind it', async () => {
    renderList(MIXED());
    await screen.findByText('(Entwurf)');
    const row = rowFor('(Entwurf)');
    // A draft EUR invoice carries `baseCurrency: "CHF"` and two nulls. A row keyed on the currency
    // alone would print "CHF 0.00" here, which is a figure the books have never held.
    expect(fx.draftForeign.baseCurrency).toBe('CHF');
    expect(within(row).getByText("EUR 1'500.00")).toBeInTheDocument();
    expect(within(row).queryByText(/CHF/)).not.toBeInTheDocument();
  });

  it('still shows the base total at parity, where the two figures coincide', async () => {
    renderList(MIXED());
    await screen.findByText('R-2026-0003');
    const row = rowFor('R-2026-0003');
    // The rate is 1, so the numbers match. Going quiet here would make a pegged foreign invoice
    // indistinguishable from a franc one, which is the disclosure §H-FX exists to prevent.
    expect(within(row).getByText("USD 1'621.50")).toBeInTheDocument();
    expect(within(row).getByText("CHF 1'621.50")).toBeInTheDocument();
  });

  it('prints the ENGINE base total, never the transaction total scaled by the rate', async () => {
    // The ledger converts and rounds per posted row and sums the results, so its answer is not
    // always `round(totalMinor * fxRate)`. Here the two are forced apart: the naive product is
    // 152616, the figure sent is 152600.
    renderList({
      list_documents: ok({ documents: [{ ...fx.issuedForeign, totalBaseMinor: 152600 }] }),
      list_contacts: ok({ contacts: CONTACTS }),
    });
    await screen.findByText('R-2026-0001');
    const row = rowFor('R-2026-0001');
    expect(within(row).getByText("CHF 1'526.00")).toBeInTheDocument();
    expect(within(row).queryByText("CHF 1'526.16")).not.toBeInTheDocument();
  });

  it('has no axe violations with a mixed-currency list on screen', async () => {
    const { container } = renderList(MIXED());
    await screen.findByText('R-2026-0001');
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
