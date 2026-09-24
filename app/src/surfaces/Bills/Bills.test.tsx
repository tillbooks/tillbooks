/**
 * A17, Kreditoren: the app-level suite, every GUI state, driven by fixtures from the LIVE engine.
 *
 * Every list payload rendered here is a recording in this directory, and
 * `test/purchase/studio-bills-fixture.test.mjs` pins each one to the real engine VALUE for value.
 * The strings asserted below are display forms of recorded values (`CHF 1'081.00` is `108100`
 * Rappen through `formatMoney`, verbatim and positive per K-39, `10.07.2026` is `2026-07-10` through
 * `formatDate`) and nothing is invented; the option reads the editor issues are canned by hand
 * because they are OTHER capabilities' verbs (A09/A01/A05), asserted by the filtering this surface
 * performs on them, which is exactly the part A17 owns.
 *
 * The LOADING tests prove their read with `transport.started(...)`, per
 * `app/src/loading-state-convention.test.ts`: the skeleton is on screen from the first commit, so
 * without the seam the assertion would pass over a surface that reads nothing at all.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import { billErrorMessage } from './BillEditor';
import Bills from './index';

import listFixture from './list-vendor-bills.fixture.json';
import mismatchFixture from './list-vendor-bills.mismatch.fixture.json';
import previewFixture from './vat-preview.fixture.json';
import accountsFixture from '../Accounts/list-accounts.fixture.json';

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (body: { error: string } & Record<string, unknown>, status = 422): RestResponse => ({
  status,
  body: { ...body, ok: false },
});

/** The editor's option reads: a vendor, a `both`, and a customer the picker must NOT offer. */
const CONTACTS = ok({
  contacts: [
    { id: 'v1', name: 'Lieferant GmbH', partyRole: 'vendor' },
    { id: 'v2', name: 'Werkstoff AG', partyRole: 'both' },
    { id: 'c1', name: 'Muster AG', partyRole: 'customer' },
  ],
});

/**
 * The RECORDED chart, pinned to the live `list_accounts` by
 * `test/accounts/studio-list-accounts-fixture.test.mjs`: the whole shipped Kontenrahmen KMU, which
 * is exactly what the account picker's filtering has to be judged against. It carries the four
 * engine-booked numbers (2000/1170/1171/2200, two of them ASSET rows that pass the type filter),
 * income and equity rows, and 6500 under its real seed name, so a hand-typed chart can never agree
 * with a filtering bug again.
 */
const ACCOUNTS = ok(accountsFixture);
const account = (number: string) => {
  const row = accountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the chart recording has no account ${number}`);
  return row;
};

/** Input- and output-side codes: the picker offers the purchase kinds only. */
const CODES = ok({
  taxCodes: [
    { code: 'VST-M', kind: 'input', label: 'Vorsteuer Material' },
    { code: 'BEZUG', kind: 'reverse_charge', label: 'Bezugsteuer' },
    { code: 'IMPORT', kind: 'import', label: 'Einfuhrsteuer' },
    { code: 'UST81', kind: 'output', label: 'Umsatzsteuer 8.1%' },
    { code: 'EXPORT0', kind: 'zero', label: 'Export' },
  ],
});

const NO_CENTERS = ok({ costCenters: [] });
const CENTERS = ok({
  costCenters: [
    { id: 'cc1', code: 'PROJ', name: 'Projekte' },
    { id: 'cc2', code: 'ADMIN', name: 'Verwaltung' },
  ],
});

/** The B03 project dimension: no projects hides the picker, exactly the cost-centre rule. */
const NO_PROJECTS = ok({ projects: [] });
const PROJECTS = ok({
  projects: [
    { id: 'p1', code: 'P-2026-001', name: 'Relaunch' },
    { id: 'p2', code: 'P-2026-002', name: 'Migration' },
  ],
});

const HAPPY: Canned = {
  list_vendor_bills: ok(listFixture),
  list_contacts: CONTACTS,
  list_accounts: ACCOUNTS,
  vat_codes: CODES,
  list_cost_centers: NO_CENTERS,
  project_list: NO_PROJECTS,
  vat_preview: ok(previewFixture),
};

/** A capability context answering a fixed set, so the fail-open default cannot mask a gate. */
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'viewer',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface RenderOptions {
  route?: string;
  transport?: Transport;
  held?: readonly string[] | null;
  workspaceId?: string | null;
}

function renderBills(canned: Canned = HAPPY, options: RenderOptions = {}) {
  const { route = '/bills', transport, held = null, workspaceId = 'ws_test' } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  const tree = (
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <TillClientProvider client={client}>
            <Bills />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(
    held === null ? tree : <CapabilitiesContext.Provider value={caps(held)}>{tree}</CapabilitiesContext.Provider>,
  );
}

/** A recorded row by its vendor reference. Throws rather than asserting against `undefined`. */
function recorded(reference: string) {
  const row = listFixture.bills.find((b) => b.vendorReference === reference);
  if (row === undefined) throw new Error(`the recording has no bill ${reference}`);
  return row;
}

async function openEditor(canned: Canned = HAPPY, options: RenderOptions = {}) {
  renderBills(canned, options);
  await userEvent.click(await screen.findByRole('button', { name: 'Rechnung erfassen' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

// --- the list, five states ------------------------------------------------------------------------

describe('the Kreditoren list, in all five states', () => {
  it('LOADING: shows a skeleton while list_vendor_bills is genuinely in flight', async () => {
    const transport = watchReads(neverSettles);
    renderBills(HAPPY, { transport });
    // The proof. Without it this assertion holds over a surface that reads nothing at all.
    await transport.started('list_vendor_bills');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('NO WORKSPACE: says so instead of rendering dead controls', async () => {
    renderBills(HAPPY, { workspaceId: null });
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
  });

  it('EMPTY: invites the first bill and says what the screen is for', async () => {
    renderBills({ ...HAPPY, list_vendor_bills: ok({ ...listFixture, bills: [], baseTotalOpenMinor: 0 }) });
    expect(await screen.findByText('Noch keine Lieferantenrechnungen.')).toBeInTheDocument();
    expect(screen.getByText(/sobald du sie erfasst/)).toBeInTheDocument();
    // K-33: the one action mirrors the title.
    expect(screen.getAllByRole('button', { name: 'Rechnung erfassen' }).length).toBeGreaterThan(1);
  });

  it('EMPTY (filtered): blames the filter and offers to reset it', async () => {
    renderBills(
      { ...HAPPY, list_vendor_bills: ok({ ...listFixture, bills: [], filtered: true }) },
      { route: '/bills?status=draft' },
    );
    expect(await screen.findByText('Keine Rechnung passt zu diesem Filter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter zurücksetzen' })).toBeInTheDocument();
  });

  it('ERROR: shows the banner and the retry really re-reads', async () => {
    let calls = 0;
    renderBills({
      ...HAPPY,
      list_vendor_bills: () => {
        calls += 1;
        return calls === 1 ? reject({ error: 'transport_error' }) : ok(listFixture);
      },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect((await screen.findAllByText('Lieferant GmbH')).length).toBeGreaterThan(0);
  });

  it('DENIED: names the missing right rather than showing an empty table', async () => {
    renderBills({ ...HAPPY, list_vendor_bills: reject({ error: 'permission_denied' }, 403) });
    expect(
      await screen.findByText('Dazu fehlt dir die Berechtigung, die Bücher zu lesen.'),
    ).toBeInTheDocument();
  });

  it('POPULATED: renders the recording verbatim, open payables positive, in Swiss formats', async () => {
    renderBills();
    // The reference is the row's identity, and the row itself is the opener (K-21). The date renders
    // dd.mm.yyyy. The money renders exactly as the engine sends it: an open payable is POSITIVE on
    // Kreditoren (K-39, D137), as on the Übersicht tile and in the payment run.
    expect(await screen.findByRole('row', { name: 'Rechnung LG-2026-0093 öffnen' })).toBeInTheDocument();
    expect(screen.getByText('10.07.2026')).toBeInTheDocument();
    expect(screen.getAllByText("CHF 1'081.00").length).toBeGreaterThan(0);
    // The partly paid remainder is exact, from the engine, never browser arithmetic.
    expect(screen.getByText('CHF 540.50')).toBeInTheDocument();
    // The header total is the recorded base open figure, labelled as open, and positive.
    expect(document.querySelector('.bills-total')?.textContent).toBe("Offen CHF 3'783.50");
    expect(document.querySelector('.bills-total .t-money')).toHaveTextContent("CHF 3'783.50");
    // No figure on the recording is a credit, so no amount on screen carries a minus. The one signed
    // figure the surface can show is the reconciliation difference, which is absent on a healthy book.
    expect(screen.queryByText(/CHF -/)).not.toBeInTheDocument();
  });

  it('K-39: an open payable of 23\'151.68 renders "CHF 23\'151.68"; a credit keeps its minus', async () => {
    const [template] = listFixture.bills.filter((b) => b.status === 'posted' && b.openMinor > 0);
    if (template === undefined) throw new Error('the recording has no open posted bill');
    const payable = {
      ...template,
      id: 'k39-payable',
      vendorReference: 'K39-OFFEN',
      grossMinor: 2315168,
      payableMinor: 2315168,
      paidMinor: 0,
      openMinor: 2315168,
    };
    // A credit with the supplier: the engine reports the open amount below zero (paid more than was
    // payable). This is the case the minus is reserved for, and it keeps it.
    const credit = {
      ...template,
      id: 'k39-credit',
      vendorReference: 'K39-GUTSCHRIFT',
      grossMinor: 50000,
      payableMinor: 50000,
      paidMinor: 62345,
      openMinor: -12345,
      overdue: false,
      daysOverdue: 0,
    };
    renderBills({
      ...HAPPY,
      list_vendor_bills: ok({ ...listFixture, bills: [payable, credit], baseTotalOpenMinor: 2302823 }),
    });
    const payableRow = await screen.findByRole('row', { name: 'Rechnung K39-OFFEN öffnen' });
    // Gross and open: both the positive figure, exactly the engine's value.
    expect(within(payableRow).getAllByText("CHF 23'151.68")).toHaveLength(2);
    expect(within(payableRow).queryByText(/CHF -/)).not.toBeInTheDocument();
    const creditRow = screen.getByRole('row', { name: 'Rechnung K39-GUTSCHRIFT öffnen' });
    expect(within(creditRow).getByText('CHF -123.45')).toBeInTheDocument();
    expect(within(creditRow).getByText('CHF 500.00')).toBeInTheDocument();
    // The header total is the engine's figure, printed with its own sign.
    expect(document.querySelector('.bills-total')?.textContent).toBe("Offen CHF 23'028.23");
  });

  it('shows every recorded status word, and the overdue note only on an overdue open row', async () => {
    renderBills();
    await screen.findByText('LG-2026-0093');
    for (const word of ['Entwurf', 'Teilweise bezahlt', 'Bezahlt', 'Storniert']) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    }
    const overdue = recorded('WA-4471');
    expect(overdue.overdue).toBe(true);
    expect(screen.getAllByText(`${overdue.daysOverdue} Tage überfällig`)).toHaveLength(1);
    // K-22: the word rides the shared Status primitive (glyph plus word), never a coloured chip.
    const overdueRow = screen.getByRole('row', { name: 'Rechnung WA-4471 öffnen' });
    expect(overdueRow.querySelector('.status-word[data-kind="warn"]')).not.toBeNull();
  });

  it('suppresses the reconciliation band on a healthy recording and renders it on the mismatch', async () => {
    renderBills();
    await screen.findByText('LG-2026-0093');
    expect(screen.queryByText(/weichen um/)).not.toBeInTheDocument();
  });

  it('renders the band with the SIGNED difference from the mismatch recording', async () => {
    renderBills({ ...HAPPY, list_vendor_bills: ok(mismatchFixture) });
    await screen.findByText('LG-2026-0093');
    const band = document.querySelector('.bills-band') as HTMLElement;
    expect(band).toHaveTextContent(/weichen um CHF -12\.50 ab/);
    // Each figure in the sentence is its own money span (C2 F4), the sign kept as the engine sent it.
    expect([...band.querySelectorAll('p:first-child .t-money')].map((el) => el.textContent)[0]).toBe('CHF -12.50');
    expect(screen.getByText(/nicht aus einer Kreditorenrechnung/)).toBeInTheDocument();
  });

  it('suppresses the band on a FILTERED list: a subset compared to the ledger is a false alarm', async () => {
    renderBills(
      { ...HAPPY, list_vendor_bills: ok({ ...mismatchFixture, filtered: true }) },
      { route: '/bills?status=posted' },
    );
    await screen.findByText('LG-2026-0093');
    expect(screen.queryByText(/weichen um/)).not.toBeInTheDocument();
  });

  it('offers Zahlung erfassen only on a posted row with an open amount', async () => {
    renderBills();
    await screen.findByText('LG-2026-0093');
    const open = recorded('LG-2026-0093');
    const paid = recorded('LG-2026-0031');
    expect(open.openMinor).toBeGreaterThan(0);
    expect(paid.openMinor).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für LG-2026-0093' }));
    expect(await screen.findByRole('menuitem', { name: 'Zahlung erfassen' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    // A settled row has no verb besides opening, so it carries no overflow at all (K-21).
    expect(screen.queryByRole('button', { name: 'Aktionen für LG-2026-0031' })).not.toBeInTheDocument();
  });

  it('K-21: the whole row opens the bill in the drawer', async () => {
    renderBills();
    await userEvent.click(await screen.findByRole('row', { name: 'Rechnung LG-2026-0093 öffnen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /LG-2026-0093/ })).toBeInTheDocument();
  });

  it('A24: pre-disables Zahlung erfassen with the reason for an actor without pay', async () => {
    renderBills(HAPPY, { held: [CAP.readMasterData, CAP.post] });
    await screen.findByText('LG-2026-0093');
    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für LG-2026-0093' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Zahlung erfassen (erfordert die Buchhalter-Rolle)',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('has no axe violations on the settled surface', async () => {
    // Anchored on a SETTLED surface, and the read is proven to have really run: an axe pass over a
    // skeleton audits the skeleton and calls it the surface (the three-files defect).
    const transport = watchReads(fakeTransport(HAPPY));
    const { container } = renderBills(HAPPY, { transport });
    await transport.started('list_vendor_bills');
    await screen.findByText('LG-2026-0093');
    await waitFor(() => expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0));
    expect(await axe(container)).toHaveNoViolations();
  });
});

// --- the editor -----------------------------------------------------------------------------------

describe('the BillEditor drawer', () => {
  it('LOADING: proves the option reads went in flight before the form claims anything', async () => {
    const transport = watchReads(async (action, input) =>
      action === 'list_contacts' ? neverSettles(action, input) : fakeTransport(HAPPY)(action, input),
    );
    renderBills(HAPPY, { transport });
    await userEvent.click(await screen.findByRole('button', { name: 'Rechnung erfassen' }));
    await transport.started('list_contacts');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers only vendor-role contacts, so needs_vendor(party_role) is unreachable from here', async () => {
    const dialog = await openEditor();
    const picker = within(dialog).getByLabelText('Lieferant');
    await userEvent.click(picker);
    const names = screen.getAllByRole('option').map((o) => (o.textContent ?? '').replace('✓', '').trim());
    expect(names).toContain('Lieferant GmbH');
    expect(names).toContain('Werkstoff AG');
    expect(names).not.toContain('Muster AG');
  });

  it('offers only expense and asset accounts MINUS the four the engine books itself', async () => {
    const dialog = await openEditor();
    const picker = within(dialog).getByLabelText('Aufwand- oder Aktivkonto');
    await userEvent.click(picker);
    const labels = screen.getAllByRole('option').map((o) => (o.textContent ?? '').replace('✓', '').trim());
    expect(labels).toContain(`6500 ${account('6500').name}`);
    expect(labels).toContain(`1510 ${account('1510').name}`);
    // The four engine-booked numbers are absent even though 1170/1171 are ASSET rows that would
    // pass the type filter, and so is every income/liability/equity row (3200 stands in for them).
    for (const reserved of ['2000', '1170', '1171', '2200', '3200']) {
      expect(labels.some((l) => l !== null && l.startsWith(reserved))).toBe(false);
    }
  });

  it('offers only input-side MWST codes, so needs_input_tax_code is unreachable from here', async () => {
    const dialog = await openEditor();
    const picker = within(dialog).getByLabelText('Vorsteuer');
    await userEvent.click(picker);
    const labels = screen.getAllByRole('option').map((o) => (o.textContent ?? '').replace('✓', '').trim());
    expect(labels).toContain('Vorsteuer Material');
    expect(labels).toContain('Bezugsteuer');
    expect(labels).toContain('Einfuhrsteuer');
    expect(labels).not.toContain('Umsatzsteuer 8.1%');
    expect(labels).not.toContain('Export');
  });

  it('renders NO cost-centre picker when the workspace has no cost centres', async () => {
    const dialog = await openEditor();
    expect(within(dialog).queryByLabelText('Kostenstelle')).not.toBeInTheDocument();
  });

  it('renders the cost-centre picker when centres exist, and sends the chosen id', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      list_cost_centers: CENTERS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new', vendorBill: listFixture.bills[1] });
      },
    });
    await userEvent.click(within(dialog).getByLabelText('Lieferant'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lieferant GmbH' }));
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
    await userEvent.click(await screen.findByRole('option', { name: `${account('6500').number} ${account('6500').name}` }));
    await userEvent.click(within(dialog).getByLabelText('Kostenstelle'));
    await userEvent.click(await screen.findByRole('option', { name: 'PROJ Projekte' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].costCenterId).toBe('cc1');
    expect(writes[0].amountMinor).toBe(108100);
    expect(writes[0].amountIsGross).toBe(true);
    expect(writes[0].vendorId).toBe('v1');
    expect(writes[0].expenseAccountId).toBe(account('6500').id);
    expect(typeof writes[0].idempotencyKey).toBe('string');
  });

  it('renders NO project picker when the workspace has no projects', async () => {
    const dialog = await openEditor();
    expect(within(dialog).queryByLabelText('Projekt')).not.toBeInTheDocument();
  });

  it('renders the project picker when projects exist, and sends the chosen id (B03 cost dimension)', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      project_list: PROJECTS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new', vendorBill: listFixture.bills[1] });
      },
    });
    await userEvent.click(within(dialog).getByLabelText('Lieferant'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lieferant GmbH' }));
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '500');
    await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
    await userEvent.click(await screen.findByRole('option', { name: `${account('6500').number} ${account('6500').name}` }));
    await userEvent.click(within(dialog).getByLabelText('Projekt'));
    await userEvent.click(await screen.findByRole('option', { name: 'P-2026-001 Relaunch' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].projectId).toBe('p1');
  });

  it('omits projectId entirely when none is chosen, so the engine sees no empty-string reference', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      project_list: PROJECTS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new', vendorBill: listFixture.bills[1] });
      },
    });
    await userEvent.click(within(dialog).getByLabelText('Lieferant'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lieferant GmbH' }));
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '500');
    await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
    await userEvent.click(await screen.findByRole('option', { name: `${account('6500').number} ${account('6500').name}` }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect('projectId' in writes[0]).toBe(false);
  });

  it('shows the ENGINE preview split for the typed amount, never browser arithmetic', async () => {
    const dialog = await openEditor();
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    // vat-preview.fixture.json is the live computeLineTax answer: 1'000.00 / 81.00 / 1'081.00.
    expect(await within(dialog).findByText("CHF 1'000.00")).toBeInTheDocument();
    expect(within(dialog).getByText("CHF 81.00")).toBeInTheDocument();
    expect(within(dialog).getByText("CHF 1'081.00")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Saldosteuersatz/)).not.toBeInTheDocument();
  });

  it('says in words why no Vorsteuer line appears under Saldo, before the post', async () => {
    const dialog = await openEditor({
      ...HAPPY,
      vat_preview: ok({ ...previewFixture, deductible: false }),
    });
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    expect(await within(dialog).findByText(/Saldosteuersatz/)).toBeInTheDocument();
  });

  it('renders the rejection copy for a period lock, and every typed value survives it', async () => {
    const dialog = await openEditor({
      ...HAPPY,
      record_expense: reject({ error: 'period_locked', period: '2026-07' }),
    });
    await userEvent.click(within(dialog).getByLabelText('Lieferant'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lieferant GmbH' }));
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
    await userEvent.click(await screen.findByRole('option', { name: `${account('6500').number} ${account('6500').name}` }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));

    expect(await within(dialog).findByText(/Periode ist gesperrt/)).toBeInTheDocument();
    expect(dialog.querySelector('#bill-amount')).toHaveValue('1081');
    expect(within(dialog).getByLabelText('Lieferant')).toHaveTextContent('Lieferant GmbH');
  });

  it('A24: pre-disables every write control with the reason for an actor without post', async () => {
    const dialog = await openEditor(HAPPY, { held: [CAP.readMasterData] });
    expect(within(dialog).getByText('Erfordert die Buchhalter-Rolle.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Buchen' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Als Entwurf speichern' })).toBeDisabled();
    // Schliessen stays live: the padlock disables writes, it does not trap the operator.
    expect(within(dialog).getByRole('button', { name: 'Schliessen' })).toBeEnabled();
  });

  it('a POSTED bill opens frozen: the figures read-only, the receipt still editable', async () => {
    const posted = recorded('LG-2026-0093');
    const dialog = await openEditorFor(posted.id);
    expect(within(dialog).getByText(/Gebuchtes wird nie überschrieben/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Lieferant')).toBeDisabled();
    expect(dialog.querySelector('#bill-amount')).toBeDisabled();
    expect(dialog.querySelector('#bill-receipt')).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Stornieren' })).toBeEnabled();
    // The receipt save is disabled until the reference actually changes: a no-op is not offered.
    expect(within(dialog).getByRole('button', { name: 'Beleg speichern' })).toBeDisabled();
    await userEvent.type(dialog.querySelector('#bill-receipt') as HTMLElement, 'beleg/2026/0042.pdf');
    expect(within(dialog).getByRole('button', { name: 'Beleg speichern' })).toBeEnabled();
  });
});

/** Open the drawer for one recorded bill by id, settled. */
async function openEditorFor(billId: string) {
  renderBills(HAPPY, { route: `/bills?bill=${billId}` });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

// --- the rejection copy map -----------------------------------------------------------------------

describe('billErrorMessage', () => {
  const t = (key: string) => key;

  it('maps every rejection this drawer can still receive to its own sentence', () => {
    expect(billErrorMessage(t, { ok: false, error: 'needs_vendor', reason: 'party_role' })).toBe(
      'bills.error.vendorRole',
    );
    expect(billErrorMessage(t, { ok: false, error: 'needs_vendor' })).toBe('bills.error.needsVendor');
    expect(billErrorMessage(t, { ok: false, error: 'needs_account' })).toBe('bills.error.needsAccount');
    expect(billErrorMessage(t, { ok: false, error: 'needs_input_tax_code' })).toBe(
      'bills.error.needsInputTaxCode',
    );
    expect(billErrorMessage(t, { ok: false, error: 'period_locked' })).toBe('bills.error.periodLocked');
    expect(billErrorMessage(t, { ok: false, error: 'already_settled' })).toBe('bills.error.alreadySettled');
    expect(billErrorMessage(t, { ok: false, error: 'already_posted' })).toBe('bills.error.alreadyPosted');
    expect(billErrorMessage(t, { ok: false, error: 'already_void' })).toBe('bills.error.alreadyVoid');
    expect(billErrorMessage(t, { ok: false, error: 'needs_fx_rate' })).toBe('bills.error.needsFxRate');
    expect(billErrorMessage(t, { ok: false, error: 'permission_denied' })).toBe(
      'bills.error.permissionDenied.write',
    );
  });

  it('falls back to the shared transport sentence for anything unrecognised, never a raw code', () => {
    expect(billErrorMessage(t, { ok: false, error: 'some_future_code' })).toBe('bills.error.transport');
  });
});
