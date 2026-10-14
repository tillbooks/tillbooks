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
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import { billErrorMessage } from './BillEditor';
import { defaultDueDate, todayIso } from './model';
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

/** D163: the workspace default Zahlungsfrist, unset (null), as on every workspace until someone sets one. */
const NO_DEFAULT_TERMS = ok({ profile: { defaultPaymentTermsDays: null } });
/** The Firmenprofil's Standard-Zahlungsfrist set to 20 days. */
const DEFAULT_TERMS_20 = ok({ profile: { defaultPaymentTermsDays: 20 } });

const HAPPY: Canned = {
  get_company_profile: NO_DEFAULT_TERMS,
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

  it('suppresses the reconciliation line on a healthy recording', async () => {
    renderBills();
    await screen.findByText('LG-2026-0093');
    expect(document.querySelector('.bills-mismatch')).toBeNull();
    expect(screen.queryByText(/weichen um/)).not.toBeInTheDocument();
  });

  it('D152: the mismatch is ONE line with the SIGNED difference, and the sentence sits behind its (i)', async () => {
    renderBills({ ...HAPPY, list_vendor_bills: ok(mismatchFixture) });
    await screen.findByText('LG-2026-0093');
    const line = document.querySelector('.bills-mismatch') as HTMLElement;
    // The fact and the figure on the surface, nothing else: the sign kept as the engine sent it, in its
    // own money span (C2 F4), and no box (the old two-line band is gone).
    expect(line.querySelector('.bills-mismatch-title')).toHaveTextContent('Abweichung zu Konto 2000: CHF -12.50');
    expect(line.querySelector('.bills-mismatch-title .t-money')).toHaveTextContent('CHF -12.50');
    expect(document.querySelector('.bills-band')).toBeNull();
    // The line sits beside the total it is about (one status, one place).
    expect(line.parentElement).toBe(document.querySelector('.bills-total')?.parentElement);
    // The explanation is the (i)'s description, reached through aria-describedby, not a paragraph.
    const info = within(line).getByRole('button', { name: 'Was die Abweichung bedeutet' });
    const tip = document.getElementById(info.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tip).toHaveTextContent(/weichen um CHF -12\.50 ab/);
    expect(tip).toHaveTextContent(/nicht aus einer Kreditorenrechnung/);
    expect([...tip.querySelectorAll('.t-money')].map((el) => el.textContent)[0]).toBe('CHF -12.50');
    // No multi-sentence paragraph is left on the working surface.
    expect(multiSentenceParagraphs(document.querySelector('.bills') as HTMLElement)).toEqual([]);
  });

  it('suppresses the band on a FILTERED list: a subset compared to the ledger is a false alarm', async () => {
    renderBills(
      { ...HAPPY, list_vendor_bills: ok({ ...mismatchFixture, filtered: true }) },
      { route: '/bills?status=posted' },
    );
    await screen.findByText('LG-2026-0093');
    expect(document.querySelector('.bills-mismatch')).toBeNull();
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
    // The Vorsteuer control follows the account (D152): choose one that can carry a code first.
    await chooseAccount(dialog, '6500');
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
    await chooseAccount(dialog, '6500');
    expect(within(dialog).queryByLabelText('Kostenstelle')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Kostenstelle' })).not.toBeInTheDocument();
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
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kostenstelle' }));
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
    await chooseAccount(dialog, '6500');
    expect(within(dialog).queryByLabelText('Projekt')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Projekt' })).not.toBeInTheDocument();
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
    await userEvent.click(within(dialog).getByRole('button', { name: 'Projekt' }));
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
    // D152 rule 4: the split is ONE line, not a table of three figures under a heading.
    const split = dialog.querySelector('.bill-split') as HTMLElement;
    expect(split).toHaveTextContent("Netto CHF 1'000.00 · MWST CHF 81.00 · Brutto CHF 1'081.00");
    expect(within(dialog).queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('says in words why no Vorsteuer line appears under Saldo, before the post', async () => {
    const dialog = await openEditor({
      ...HAPPY,
      vat_preview: ok({ ...previewFixture, deductible: false }),
    });
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    // The sentence is the (i)'s description beside the MWST figure, words on demand (D152 rule 4).
    const info = await within(dialog).findByRole('button', { name: 'Warum keine Vorsteuer' });
    const tip = document.getElementById(info.getAttribute('aria-describedby') ?? '');
    expect(tip).toHaveTextContent(/Saldosteuersatz/);
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
    // One line on the surface; why it is frozen is the (i)'s description.
    expect(within(dialog).getByText('Gebucht: nur der Beleg lässt sich noch nachtragen.')).toBeInTheDocument();
    const why = within(dialog).getByRole('button', { name: 'Warum die Rechnung gesperrt ist' });
    expect(document.getElementById(why.getAttribute('aria-describedby') ?? '')).toHaveTextContent(
      /Gebuchtes wird nie überschrieben/,
    );
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

/**
 * The paragraphs of two or more sentences a person sees, with every (i)'s description taken out first
 * (it is in the DOM for `aria-describedby`, and on screen only on hover or focus).
 */
function multiSentenceParagraphs(root: HTMLElement): string[] {
  return [...root.querySelectorAll('p')]
    .filter((p) => p.closest('[role="tooltip"]') === null)
    .map((p) => {
      const copy = p.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove());
      return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
    })
    .filter((text) => (text.match(/[^.!?]{12,}?[.!?](?=\s|$)/g) ?? []).length >= 2);
}

/** Pick an account in the drawer's Konto picker by its number. */
async function chooseAccount(dialog: HTMLElement, number: string) {
  await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
  await userEvent.click(await screen.findByRole('option', { name: `${account(number).number} ${account(number).name}` }));
}

/** Open the drawer for one recorded bill by id, settled. */
async function openEditorFor(billId: string) {
  renderBills(HAPPY, { route: `/bills?bill=${billId}` });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
  return dialog;
}

// --- D152: the drawer infers before it asks ---------------------------------------------------------

/**
 * Wait until the drawer's option reads have answered, so what follows is asserted on the settled form.
 * (A wait for the end of loading, not a loading-state assertion: the reads are proven by the writes.)
 */
async function drawerSettled(dialog: HTMLElement) {
  await waitFor(() => expect(dialog.querySelector('[aria-busy="true"]')).toBeNull());
}

/** The recorded chart with account defaults set the way a configured workspace sets them. */
function chartWith(defaults: Record<string, string | null>): RestResponse {
  return ok({
    ...accountsFixture,
    accounts: accountsFixture.accounts.map((a) =>
      a.number in defaults ? { ...a, vatCodeDefault: defaults[a.number] } : a,
    ),
  });
}

/** 6500 carries Vorsteuer Material; 4000 carries an OUTPUT code a purchase may never take. */
const CONFIGURED = chartWith({ '6500': 'VST-M', '4000': 'UST81' });

/** Vendors with a Zahlungsfrist: v1 30 days, v2 none (0, the engine's "no terms"). */
const TERMS_CONTACTS = ok({
  contacts: [
    { id: 'v1', name: 'Lieferant GmbH', partyRole: 'vendor', paymentTermsDays: 30 },
    { id: 'v2', name: 'Werkstoff AG', partyRole: 'both', paymentTermsDays: 0 },
  ],
});

/** The drawer's controls in DOM order, outside the pinned footer: what a person is asked. */
function drawerInputs(dialog: HTMLElement): string[] {
  const form = dialog.querySelector('.bill-form') as HTMLElement;
  return [...form.querySelectorAll('input:not([type="hidden"]), [aria-haspopup="listbox"]')].map((el) => {
    const aria = el.getAttribute('aria-label');
    if (aria !== null) return aria;
    const label = (el as HTMLInputElement).labels?.[0];
    return (label?.textContent ?? el.id).trim();
  });
}

async function pickVendor(dialog: HTMLElement, name: string) {
  await userEvent.click(within(dialog).getByLabelText('Lieferant'));
  await userEvent.click(await screen.findByRole('option', { name }));
}

async function pickCode(dialog: HTMLElement, label: string) {
  await userEvent.click(within(dialog).getByLabelText('Vorsteuer'));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

/** Capture one bill through the drawer and return what `record_expense` was sent. */
async function captureOnce(
  canned: Canned,
  steps: (dialog: HTMLElement) => Promise<void>,
): Promise<Record<string, unknown>> {
  const writes: Record<string, unknown>[] = [];
  const view = renderBills({
    ...canned,
    record_expense: (input: Record<string, unknown>) => {
      writes.push(input);
      return ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
    },
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Rechnung erfassen' }));
  const dialog = await screen.findByRole('dialog');
  await drawerSettled(dialog);
  await steps(dialog);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  view.unmount();
  return writes[0];
}

const withoutKey = ({ idempotencyKey: _key, ...rest }: Record<string, unknown>) => rest;

/** A stored minor amount as the drawer's amount field shows it ("1081.00"). */
const minorText = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

describe('D152: the capture drawer infers before it asks', () => {
  it('at rest asks seven things, in the order of the paper bill, and nothing it could infer', async () => {
    const dialog = await openEditor();
    // Before: 12 inputs (Vorsteuer, Kostenstelle, Projekt, Fällig and Beleg all asked up front).
    expect(drawerInputs(dialog)).toEqual([
      'Lieferant',
      'Rechnungsdatum',
      'Rechnungsnummer',
      'Betrag',
      'Brutto',
      'Netto',
      'Aufwand- oder Aktivkonto',
    ]);
    expect(within(dialog).queryByLabelText('Vorsteuer')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Fällig')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Kostenstelle')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Projekt')).not.toBeInTheDocument();
    expect(dialog.querySelector('#bill-receipt')).toBeNull();
    // The Beleg waits behind "+ Beleg"; pressing it shows the field, empty.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Beleg' }));
    expect(dialog.querySelector('#bill-receipt')).toHaveValue('');
    // The keyboard lands in the field the "+" opened, not on the page behind a vanished button.
    expect(dialog.querySelector('#bill-receipt')).toHaveFocus();
    // Words on demand: no paragraph of two sentences anywhere in the drawer.
    expect(multiSentenceParagraphs(dialog)).toEqual([]);
  });

  it('the Vorsteuer comes after the Konto, pre-filled from its default, and follows the account', async () => {
    const dialog = await openEditor({ ...HAPPY, list_accounts: CONFIGURED });
    await chooseAccount(dialog, '6500');
    // The control appears after the account, and holds the account's default.
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Vorsteuer Material');
    const order = drawerInputs(dialog);
    expect(order.indexOf('Vorsteuer')).toBeGreaterThan(order.indexOf('Aufwand- oder Aktivkonto'));
    // An account whose default is an OUTPUT code brings nothing: a purchase never carries it.
    await chooseAccount(dialog, '4000');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Keine MWST');
    // Anlagevermögen (14xx to 17xx) carries MWST (owner D152 point 5), here with no default.
    await chooseAccount(dialog, '1510');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Keine MWST');
    // Back to 6500: its default again, never the value chosen for another account.
    await chooseAccount(dialog, '6500');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Vorsteuer Material');
    // Vorräte (1200) carry MWST too (owner, 04.10.2026: asset accounts 12xx or 14xx to 17xx).
    await chooseAccount(dialog, '1200');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Keine MWST');
    // Liquid funds (1060 Wertpapiere) carry no code: no control, and nothing hidden keeps a value.
    await pickCode(dialog, 'Vorsteuer Material');
    await chooseAccount(dialog, '1060');
    expect(within(dialog).queryByLabelText('Vorsteuer')).not.toBeInTheDocument();
    // Nor does 1300 Aktive Rechnungsabgrenzung (accruals: a code would invite a second Vorsteuer claim).
    await chooseAccount(dialog, '1300');
    expect(within(dialog).queryByLabelText('Vorsteuer')).not.toBeInTheDocument();
    // 1100 Debitoren is not even offered (the engine books it itself), so it can never carry one.
    await userEvent.click(within(dialog).getByLabelText('Aufwand- oder Aktivkonto'));
    const offered = screen.getAllByRole('option').map((o) => (o.textContent ?? '').replace('✓', '').trim());
    expect(offered.some((l) => l.startsWith('1100 '))).toBe(false);
    await userEvent.keyboard('{Escape}');
  });

  it('critic L2: a Bankkonto linked to 1500 in a custom chart never offers MWST, default code or not', async () => {
    const dialog = await openEditor({
      ...HAPPY,
      list_accounts: chartWith({ '1500': 'VST-I' }),
      list_bank_accounts: ok({ bankAccounts: [{ id: 'ba_1', name: 'Konto', ledgerAccountId: account('1500').id, archived: false }] }),
    });
    await chooseAccount(dialog, '1500');
    expect(within(dialog).queryByLabelText('Vorsteuer')).not.toBeInTheDocument();
    // Its default code is not inferred either: nothing hidden carries a value.
    await chooseAccount(dialog, '1510');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Keine MWST');
  });

  it('critic L3 (M5): a stored code on an account that carries none stays on screen, so it is seen before it posts', async () => {
    const draft = recorded('LG-2026-0107');
    const odd = { ...draft, expenseAccountId: account('1060').id, taxCode: 'VST-M' };
    renderBills(
      { ...HAPPY, list_vendor_bills: ok({ ...listFixture, bills: [odd, ...listFixture.bills.slice(1)] }) },
      { route: `/bills?bill=${draft.id}` },
    );
    const dialog = await screen.findByRole('dialog');
    await drawerSettled(dialog);
    expect(within(dialog).getByLabelText('Aufwand- oder Aktivkonto')).toHaveTextContent('1060');
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Vorsteuer Material');
  });

  it('MONEY PATH: the inferred code posts EXACTLY what a person picking that code by hand posts', async () => {
    const inferred = await captureOnce({ ...HAPPY, list_accounts: CONFIGURED }, async (dialog) => {
      await pickVendor(dialog, 'Lieferant GmbH');
      await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
      await chooseAccount(dialog, '6500');
    });
    const byHand = await captureOnce(HAPPY, async (dialog) => {
      await pickVendor(dialog, 'Lieferant GmbH');
      await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
      await chooseAccount(dialog, '6500');
      // The recorded chart sets no default, so the code is chosen by hand, as on develop.
      expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Keine MWST');
      await pickCode(dialog, 'Vorsteuer Material');
    });
    expect(withoutKey(inferred)).toEqual(withoutKey(byHand));
    // The payload is develop's shape: the same keys, the code as a plain field, nothing new but the
    // Fälligkeit the engine would have defaulted to anyway (no terms: the bill date).
    const today = todayIso();
    expect(withoutKey(inferred)).toEqual({
      workspaceId: 'ws_test',
      vendorId: 'v1',
      billDate: today,
      dueDate: today,
      amountMinor: 108100,
      amountIsGross: true,
      taxCode: 'VST-M',
      expenseAccountId: account('6500').id,
    });
  });

  it('MONEY PATH: a deleted inferred code posts as "no VAT", exactly as an empty one always did', async () => {
    const previews: Record<string, unknown>[] = [];
    const deleted = await captureOnce(
      {
        ...HAPPY,
        list_accounts: CONFIGURED,
        vat_preview: (input: Record<string, unknown>) => {
          previews.push(input);
          return ok(previewFixture);
        },
      },
      async (dialog) => {
        await pickVendor(dialog, 'Lieferant GmbH');
        await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
        await chooseAccount(dialog, '6500');
        await pickCode(dialog, 'Keine MWST');
      },
    );
    const empty = await captureOnce(HAPPY, async (dialog) => {
      await pickVendor(dialog, 'Lieferant GmbH');
      await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
      await chooseAccount(dialog, '6500');
    });
    // No `taxCode` key at all: never an empty string, never the inferred code riding along.
    expect('taxCode' in deleted).toBe(false);
    expect(withoutKey(deleted)).toEqual(withoutKey(empty));
    // And the split on screen was asked for the same question: the last preview carries no code.
    expect('taxCode' in previews[previews.length - 1]).toBe(false);
  });

  it('Kostenstelle and Projekt only on an account that allows them, and an account change clears them', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      list_cost_centers: CENTERS,
      project_list: PROJECTS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
      },
    });
    // No account yet, and an account that allows no cost centre (1510): neither is offered.
    expect(within(dialog).queryByRole('button', { name: 'Kostenstelle' })).not.toBeInTheDocument();
    await chooseAccount(dialog, '1510');
    expect(account('1510').costCenterAllowed).toBe(false);
    expect(within(dialog).queryByRole('button', { name: 'Kostenstelle' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Projekt' })).not.toBeInTheDocument();
    // 6500 allows them: offered behind "+", and chosen.
    await chooseAccount(dialog, '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kostenstelle' }));
    expect(within(dialog).getByLabelText('Kostenstelle')).toHaveFocus();
    await userEvent.click(within(dialog).getByLabelText('Kostenstelle'));
    await userEvent.click(await screen.findByRole('option', { name: 'PROJ Projekte' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Projekt' }));
    await userEvent.click(within(dialog).getByLabelText('Projekt'));
    await userEvent.click(await screen.findByRole('option', { name: 'P-2026-001 Relaunch' }));
    // Another account: both are cleared and closed, never carried silently onto it.
    await chooseAccount(dialog, '6000');
    expect(within(dialog).queryByLabelText('Kostenstelle')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Projekt')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Kostenstelle' })).toBeInTheDocument();
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect('costCenterId' in writes[0]).toBe(false);
    expect('projectId' in writes[0]).toBe(false);
  });

  it("Fällig comes from the vendor's Zahlungsfrist, after the vendor, the engine's default day for day", async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      list_contacts: TERMS_CONTACTS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
      },
    });
    expect(within(dialog).queryByLabelText('Fällig')).not.toBeInTheDocument();
    await pickVendor(dialog, 'Lieferant GmbH');
    // Across a month end: 31.01.2026 + 30 days is 02.03.2026 (2026 is no leap year).
    fireEvent.change(dialog.querySelector('#bill-date') as HTMLElement, { target: { value: '2026-01-31' } });
    expect(within(dialog).getByLabelText('Fällig')).toHaveValue('2026-03-02');
    expect(defaultDueDate('2026-01-31', 30)).toBe('2026-03-02');
    // Where it comes from is the (i)'s description, not a sentence on the form.
    const info = within(dialog).getByRole('button', { name: 'Woher das Fälligkeitsdatum kommt' });
    expect(document.getElementById(info.getAttribute('aria-describedby') ?? '')).toHaveTextContent('30 Tage');
    // A vendor whose terms are 0 (due immediately, D163): due on the bill date.
    await pickVendor(dialog, 'Werkstoff AG');
    expect(within(dialog).getByLabelText('Fällig')).toHaveValue('2026-01-31');
    expect(document.getElementById(
      within(dialog).getByRole('button', { name: 'Woher das Fälligkeitsdatum kommt' }).getAttribute('aria-describedby') ?? '',
    )).toHaveTextContent('Zahlung sofort');
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '200');
    await chooseAccount(dialog, '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].dueDate).toBe('2026-03-02');
    expect(writes[0].billDate).toBe('2026-01-31');
  });

  it('Fällig is editable: a typed date stays put, and a cleared one sends no dueDate', async () => {
    const writes: Record<string, unknown>[] = [];
    let refuse = true;
    const dialog = await openEditor({
      ...HAPPY,
      list_contacts: TERMS_CONTACTS,
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return refuse ? reject({ error: 'period_locked' }) : ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
      },
    });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '200');
    await chooseAccount(dialog, '6500');
    fireEvent.change(within(dialog).getByLabelText('Fällig'), { target: { value: '2026-12-24' } });
    // The bill date moves; the date the person typed does not.
    fireEvent.change(dialog.querySelector('#bill-date') as HTMLElement, { target: { value: '2026-11-01' } });
    expect(within(dialog).getByLabelText('Fällig')).toHaveValue('2026-12-24');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].dueDate).toBe('2026-12-24');
    // Cleared: the field stays on screen, empty, and the write carries no dueDate (the blank of old). The
    // date the engine will then store is said under it (critic L1): the terms from the bill date.
    expect(dialog.querySelector('#bill-due-blank')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Fällig'), { target: { value: '' } });
    const hint = dialog.querySelector('#bill-due-blank') as HTMLElement;
    expect(hint).toHaveTextContent('Leer lassen: fällig am 01.12.2026 aus der Zahlungsfrist.');
    expect(within(dialog).getByLabelText('Fällig')).toHaveAttribute('aria-describedby', 'bill-due-blank');
    expect(defaultDueDate('2026-11-01', 30)).toBe('2026-12-01');
    // A vendor due immediately: the empty field says the bill date. Then back to the vendor with terms.
    await pickVendor(dialog, 'Werkstoff AG');
    expect(dialog.querySelector('#bill-due-blank')).toHaveTextContent('Leer lassen: fällig am 01.11.2026, dem Rechnungsdatum.');
    await pickVendor(dialog, 'Lieferant GmbH');
    refuse = false;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect('dueDate' in writes[1]).toBe(false);
  });

  it('D163: a vendor with no terms of its own falls due after the Firmenprofil default; 0 stays immediate', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      get_company_profile: DEFAULT_TERMS_20,
      list_contacts: ok({
        contacts: [
          { id: 'v1', name: 'Lieferant GmbH', partyRole: 'vendor', paymentTermsDays: 30 },
          { id: 'v2', name: 'Werkstoff AG', partyRole: 'both', paymentTermsDays: 0 },
          { id: 'v3', name: 'Ohne Frist AG', partyRole: 'vendor', paymentTermsDays: null },
        ],
      }),
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
      },
    });
    const info = () =>
      document.getElementById(
        within(dialog).getByRole('button', { name: 'Woher das Fälligkeitsdatum kommt' }).getAttribute('aria-describedby') ?? '',
      );
    fireEvent.change(dialog.querySelector('#bill-date') as HTMLElement, { target: { value: '2026-01-31' } });
    // No terms of its own: the Standard-Zahlungsfrist, 20 days, across the month end.
    await pickVendor(dialog, 'Ohne Frist AG');
    expect(within(dialog).getByLabelText('Fällig')).toHaveValue('2026-02-20');
    expect(defaultDueDate('2026-01-31', null, 20)).toBe('2026-02-20');
    expect(info()).toHaveTextContent('Standard-Zahlungsfrist aus dem Firmenprofil: 20 Tage');
    // Cleared, the hint names the date the ENGINE will store from the default.
    fireEvent.change(within(dialog).getByLabelText('Fällig'), { target: { value: '' } });
    expect(dialog.querySelector('#bill-due-blank')).toHaveTextContent('Leer lassen: fällig am 20.02.2026 aus der Standard-Zahlungsfrist.');
    // Its own terms win over the default.
    await pickVendor(dialog, 'Lieferant GmbH');
    expect(dialog.querySelector('#bill-due-blank')).toHaveTextContent('Leer lassen: fällig am 02.03.2026 aus der Zahlungsfrist.');
    // 0 is "due immediately": the default does NOT apply.
    await pickVendor(dialog, 'Werkstoff AG');
    expect(dialog.querySelector('#bill-due-blank')).toHaveTextContent('Leer lassen: fällig am 31.01.2026, dem Rechnungsdatum.');
    expect(info()).toHaveTextContent('Zahlung sofort');
    // A cleared field posts with no dueDate, so the engine applies the same rule the hint stated.
    await pickVendor(dialog, 'Ohne Frist AG');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '200');
    await chooseAccount(dialog, '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect('dueDate' in writes[0]).toBe(false);
  });

  it('D163: an untouched Fällig sends the default-derived date, never a different guess', async () => {
    const writes: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      get_company_profile: DEFAULT_TERMS_20,
      list_contacts: ok({ contacts: [{ id: 'v3', name: 'Ohne Frist AG', partyRole: 'vendor', paymentTermsDays: null }] }),
      record_expense: (input: Record<string, unknown>) => {
        writes.push(input);
        return ok({ vendorBillId: 'vb_new', entryId: 'e_new' });
      },
    });
    fireEvent.change(dialog.querySelector('#bill-date') as HTMLElement, { target: { value: '2026-12-15' } });
    await pickVendor(dialog, 'Ohne Frist AG');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '200');
    await chooseAccount(dialog, '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].dueDate).toBe('2027-01-04');
  });

  it('D163: a failed Firmenprofil read stops the capture rather than guessing the default away', async () => {
    const dialog = await openEditor({ ...HAPPY, get_company_profile: reject({ error: 'internal_error' }, 500) });
    expect(within(dialog).getByText('TILL konnte Lieferanten, Konten und MWST-Codes nicht laden.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Fällig')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Buchen' })).not.toBeInTheDocument();
  });

  it('IDEMPOTENCY (critic L-b): ONE capture key per drawer, kept across retries, edits and account switches', async () => {
    const keys: string[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      list_accounts: CONFIGURED,
      record_expense: (input: Record<string, unknown>) => {
        keys.push(String(input.idempotencyKey));
        return reject({ error: 'transport_error' });
      },
    });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    await chooseAccount(dialog, '6500');
    const post = within(dialog).getByRole('button', { name: 'Buchen' });
    await userEvent.click(post);
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.click(post);
    await waitFor(() => expect(keys).toHaveLength(2));
    // An edited amount and a switched account (another inferred code) are still the SAME paper bill.
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '0');
    await chooseAccount(dialog, '6000');
    await userEvent.click(post);
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys).size).toBe(1);
  });

  /**
   * A fake of the engine's capture rule (`createVendorBill` / `recordExpense`): each verb replays its own
   * answer for a key it already answered; a key that already created a bill by the OTHER verb is refused
   * `idempotency_key_conflict`, naming that bill. Every first answer is LOST on the way back.
   */
  function captureEngine(ids: { draft: string; posted: string }) {
    const created = new Map<string, { verb: string; id: string }>();
    const sent: Array<{ verb: string; key: string }> = [];
    const answer = (verb: string, id: string) => (input: Record<string, unknown>) => {
      const key = String(input.idempotencyKey);
      sent.push({ verb, key });
      const holder = created.get(key);
      if (holder !== undefined && holder.verb !== verb) {
        return reject({ error: 'idempotency_key_conflict', idempotencyKey: key, vendorBillId: holder.id });
      }
      if (holder === undefined) {
        created.set(key, { verb, id });
        return reject({ error: 'transport_error' });
      }
      return ok({ vendorBillId: holder.id });
    };
    return {
      sent,
      bills: () => created.size,
      canned: { create_vendor_bill: answer('create_vendor_bill', ids.draft), record_expense: answer('record_expense', ids.posted) },
    };
  }

  it('MONEY PATH (critic H1): a lost draft save, then Buchen: ONE bill, the refusal said, and the draft opened', async () => {
    const draft = recorded('LG-2026-0107');
    const engine = captureEngine({ draft: draft.id, posted: 'vb_never' });
    const dialog = await openEditor({ ...HAPPY, ...engine.canned });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const draftButton = within(dialog).getByRole('button', { name: 'Als Entwurf speichern' });
    await userEvent.click(draftButton);
    await waitFor(() => expect(engine.sent).toHaveLength(1));
    await waitFor(() => expect(draftButton).toBeEnabled());
    // Buchen is the SAME act (capturing this paper bill): the same key, so the engine refuses it.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(engine.sent).toHaveLength(2));
    expect(engine.sent.map((s) => s.verb)).toEqual(['create_vendor_bill', 'record_expense']);
    expect(engine.sent[1].key).toBe(engine.sent[0].key);
    expect(engine.bills()).toBe(1);
    // One sentence, and the door to the draft the refusal names. Nothing is posted by id behind it.
    const conflict = await within(dialog).findByRole('alert');
    expect(conflict).toHaveTextContent('Diese Rechnung ist schon erfasst.');
    await userEvent.click(within(conflict).getByRole('button', { name: 'Öffnen' }));
    // The draft opens read-only with ITS stored figures (here the recorded 1'081.00), not the typed 99,
    // and from there Buchen posts that draft by id. (The drawer is keyed by the bill, so the capture's
    // typed state never rides into it, even when the draft is already in the list.)
    const opened = await screen.findByRole('dialog', { name: /LG-2026-0107/ });
    await drawerSettled(opened);
    expect(opened.querySelector('#bill-amount')).toHaveValue(minorText(draft.grossMinor));
    expect(opened.querySelector('#bill-amount')).toBeDisabled();
    expect(within(opened).getByRole('button', { name: 'Buchen' })).toBeEnabled();
    expect(engine.sent).toHaveLength(2);
  });

  it('MONEY PATH (critic H1, mirror): a lost Buchen, then Entwurf: ONE bill, and the posted bill opened', async () => {
    const posted = recorded('LG-2026-0093');
    const engine = captureEngine({ draft: 'vb_never', posted: posted.id });
    const dialog = await openEditor({ ...HAPPY, ...engine.canned });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const post = within(dialog).getByRole('button', { name: 'Buchen' });
    await userEvent.click(post);
    await waitFor(() => expect(engine.sent).toHaveLength(1));
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Als Entwurf speichern' }));
    await waitFor(() => expect(engine.sent).toHaveLength(2));
    expect(engine.sent[1].key).toBe(engine.sent[0].key);
    expect(engine.bills()).toBe(1);
    const conflict = await within(dialog).findByRole('alert');
    // Worded neutrally (critic L-a): the holder may be a draft or a posted bill.
    expect(conflict).toHaveTextContent('Diese Rechnung ist schon erfasst.');
    await userEvent.click(within(conflict).getByRole('button', { name: 'Öffnen' }));
    expect(await screen.findByRole('dialog', { name: /LG-2026-0093/ })).toBeInTheDocument();
  });

  it('MONEY PATH (critic L-b): a lost draft save, an EDIT, then Buchen: still ONE bill, the sentence and Öffnen', async () => {
    const draft = recorded('LG-2026-0107');
    const engine = captureEngine({ draft: draft.id, posted: 'vb_never' });
    const dialog = await openEditor({ ...HAPPY, ...engine.canned });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const draftButton = within(dialog).getByRole('button', { name: 'Als Entwurf speichern' });
    await userEvent.click(draftButton);
    await waitFor(() => expect(engine.sent).toHaveLength(1));
    await waitFor(() => expect(draftButton).toBeEnabled());
    // The person corrects the amount after the lost answer: it is still this paper bill, the same key.
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(engine.sent).toHaveLength(2));
    expect(engine.sent[1].key).toBe(engine.sent[0].key);
    expect(engine.bills()).toBe(1);
    const conflict = await within(dialog).findByRole('alert');
    expect(conflict).toHaveTextContent('Diese Rechnung ist schon erfasst.');
    await userEvent.click(within(conflict).getByRole('button', { name: 'Öffnen' }));
    expect(await screen.findByRole('dialog', { name: /LG-2026-0107/ })).toBeInTheDocument();
  });

  it('critic L-b, same verb: a lost Buchen, an edit, then Buchen is the engine REPLAYING the first: said, never closed on', async () => {
    const posted = recorded('LG-2026-0093');
    const engine = captureEngine({ draft: 'vb_never', posted: posted.id });
    const dialog = await openEditor({ ...HAPPY, ...engine.canned });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const post = within(dialog).getByRole('button', { name: 'Buchen' });
    await userEvent.click(post);
    await waitFor(() => expect(engine.sent).toHaveLength(1));
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '0');
    await userEvent.click(post);
    await waitFor(() => expect(engine.sent).toHaveLength(2));
    expect(engine.bills()).toBe(1);
    // The answer is a success, but for the FIRST attempt's figures: the drawer stays, says the bill exists,
    // and opens it, so the edited 990 is not silently dropped behind a "booked".
    const conflict = await within(dialog).findByRole('alert');
    expect(conflict).toHaveTextContent('Diese Rechnung ist schon erfasst.');
    expect(screen.getByRole('dialog', { name: 'Lieferantenrechnung erfassen' })).toBeInTheDocument();
    await userEvent.click(within(conflict).getByRole('button', { name: 'Öffnen' }));
    expect(await screen.findByRole('dialog', { name: /LG-2026-0093/ })).toBeInTheDocument();
  });

  it('critic L-c: Öffnen reads the bill by id when the list read does not carry it, and opens it', async () => {
    const draft = recorded('LG-2026-0107');
    const elsewhere = { ...draft, id: 'vb_beyond_the_cap', vendorReference: 'FERN-0001' };
    const engine = captureEngine({ draft: elsewhere.id, posted: 'vb_never' });
    const byId: string[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      ...engine.canned,
      get_vendor_bill: (input: Record<string, unknown>) => {
        byId.push(String(input.vendorBillId));
        return ok({ vendorBill: elsewhere, payments: [] });
      },
    });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const draftButton = within(dialog).getByRole('button', { name: 'Als Entwurf speichern' });
    await userEvent.click(draftButton);
    await waitFor(() => expect(draftButton).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    const conflict = await within(dialog).findByRole('alert');
    await userEvent.click(within(conflict).getByRole('button', { name: 'Öffnen' }));
    expect(await screen.findByRole('dialog', { name: /FERN-0001/ })).toBeInTheDocument();
    expect(byId).toContain('vb_beyond_the_cap');
    expect(screen.queryByRole('row', { name: /FERN-0001/ })).not.toBeInTheDocument();
  });

  it('a retry of the same capture after a lost answer replays it under the same key', async () => {
    const engine = captureEngine({ draft: 'vb_d', posted: 'vb_p' });
    const dialog = await openEditor({ ...HAPPY, ...engine.canned });
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '99');
    await chooseAccount(dialog, '6500');
    const post = within(dialog).getByRole('button', { name: 'Buchen' });
    await userEvent.click(post);
    await waitFor(() => expect(engine.sent).toHaveLength(1));
    await waitFor(() => expect(post).toBeEnabled());
    await userEvent.click(post);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(engine.sent[1].key).toBe(engine.sent[0].key);
    expect(engine.bills()).toBe(1);
  });

  it("the split is the NEWEST question's answer: a late answer for an amount since edited is dropped", async () => {
    let releaseFirst: (r: RestResponse) => void = () => undefined;
    const first = new Promise<RestResponse>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const dialog = await openEditor({
      ...HAPPY,
      vat_preview: (() => {
        calls += 1;
        return calls === 1 ? first : Promise.resolve(ok(previewFixture));
      }) as unknown as RestResponse,
    });
    fireEvent.change(dialog.querySelector('#bill-amount') as HTMLElement, { target: { value: '1' } });
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.change(dialog.querySelector('#bill-amount') as HTMLElement, { target: { value: '1081' } });
    const split = dialog.querySelector('.bill-split') as HTMLElement;
    await waitFor(() => expect(split).toHaveTextContent("Brutto CHF 1'081.00"));
    // The answer for "1" arrives last. It describes a figure no longer in the field: it is dropped.
    await act(async () => {
      releaseFirst(ok({ ...previewFixture, netMinor: 93, taxMinor: 7, grossMinor: 100 }));
      await first;
    });
    expect(split).toHaveTextContent("Brutto CHF 1'081.00");
    expect(split).not.toHaveTextContent('CHF 1.00');
  });

  it('a DRAFT opens read-only: Buchen posts the stored draft by id, so nothing typed can diverge from it', async () => {
    const writes: Array<{ action: string; input: Record<string, unknown> }> = [];
    const draft = recorded('LG-2026-0107');
    expect(draft.status).toBe('draft');
    renderBills(
      {
        ...HAPPY,
        list_accounts: CONFIGURED,
        post_vendor_bill: (input: Record<string, unknown>) => {
          writes.push({ action: 'post_vendor_bill', input });
          return ok({ vendorBillId: draft.id });
        },
      },
      { route: `/bills?bill=${draft.id}` },
    );
    const dialog = await screen.findByRole('dialog');
    await drawerSettled(dialog);
    expect(within(dialog).getByText('Entwurf: Buchen bucht genau diese Angaben.')).toBeInTheDocument();
    for (const el of dialog.querySelectorAll('.bill-form input, .bill-form [aria-haspopup="listbox"]')) {
      expect(el).toBeDisabled();
    }
    // The stored code shows as stored (never re-inferred) and the stored Fälligkeit with it.
    expect(within(dialog).getByLabelText('Vorsteuer')).toHaveTextContent('Vorsteuer Material');
    expect(within(dialog).getByLabelText('Fällig')).toHaveValue(draft.dueDate);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(Object.keys(writes[0].input).sort()).toEqual(['idempotencyKey', 'vendorBillId', 'workspaceId']);
  });

  it('critic M1: a draft with its own Leistungsdatum is previewed at it, the date Buchen prices it at', async () => {
    const draft = recorded('LG-2026-0107');
    const asked: Record<string, unknown>[] = [];
    const across = { ...draft, billDate: '2024-01-10', dueDate: '2024-02-09', supplyDate: '2023-12-15' };
    renderBills(
      {
        ...HAPPY,
        list_vendor_bills: ok({ ...listFixture, bills: [across, ...listFixture.bills.slice(1)] }),
        vat_preview: (input: Record<string, unknown>) => {
          asked.push(input);
          return ok(previewFixture);
        },
      },
      { route: `/bills?bill=${draft.id}` },
    );
    const dialog = await screen.findByRole('dialog');
    await drawerSettled(dialog);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.every((q) => q.supplyDate === '2023-12-15')).toBe(true);
  });

  it('a new capture is previewed at its bill date, the date the engine prices a bill with no supply date at', async () => {
    const asked: Record<string, unknown>[] = [];
    const dialog = await openEditor({
      ...HAPPY,
      vat_preview: (input: Record<string, unknown>) => {
        asked.push(input);
        return ok(previewFixture);
      },
    });
    fireEvent.change(dialog.querySelector('#bill-date') as HTMLElement, { target: { value: '2026-02-03' } });
    fireEvent.change(dialog.querySelector('#bill-amount') as HTMLElement, { target: { value: '100' } });
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[asked.length - 1].supplyDate).toBe('2026-02-03');
  });

  it('a row is one line: the Nummer and the Lieferant clip, and carry the whole text in the title', async () => {
    renderBills();
    const row = await screen.findByRole('row', { name: 'Rechnung LG-2026-0093 öffnen' });
    const clips = row.querySelectorAll('.bills-clip');
    expect([...clips].map((c) => c.getAttribute('title'))).toEqual(['LG-2026-0093', 'Lieferant GmbH']);
    expect(row.querySelectorAll('.bills-nowrap')).toHaveLength(2);
  });
});

// --- the workspace switch (Wave B-2 lessons) ------------------------------------------------------------

/** Render with a handle on the workspace, the way the switcher in the rail changes it. */
function renderSwitchable(transport: Transport, route = '/bills') {
  let switchTo: (id: string) => void = () => undefined;
  function Switcher() {
    const { setWorkspaceId } = useWorkspace();
    switchTo = (id: string) => setWorkspaceId(id);
    return null;
  }
  render(
    <MemoryRouter initialEntries={[route]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_a">
          <TillClientProvider client={new TillClient(transport)}>
            <Switcher />
            <Bills />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  return { switchTo: (id: string) => act(() => switchTo(id)) };
}

/** A transport that records every call and answers from `canned`. */
function recording(canned: Canned) {
  const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
  const inner = fakeTransport(canned);
  const transport: Transport = (action, input) => {
    asked.push({ action, input: input as Record<string, unknown> });
    return inner(action, input);
  };
  return { asked, transport };
}

describe('Kreditoren across a workspace switch', () => {
  it('drops the half-typed capture: the drawer closes, and a new one opens empty', async () => {
    const { asked, transport } = recording(HAPPY);
    const { switchTo } = renderSwitchable(transport, '/bills?new=1');
    const dialog = await screen.findByRole('dialog');
    await drawerSettled(dialog);
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    switchTo('ws_b');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(asked.some((a) => a.action === 'list_vendor_bills' && a.input.workspaceId === 'ws_b')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rechnung erfassen' }));
    const fresh = await screen.findByRole('dialog');
    await drawerSettled(fresh);
    expect(fresh.querySelector('#bill-amount')).toHaveValue('');
    // The fresh drawer read its options under ws_b.
    expect(asked.some((a) => a.action === 'list_accounts' && a.input.workspaceId === 'ws_b')).toBe(true);
  });

  it('drops an open bill: its id names a bill in the workspace just left', async () => {
    const { transport } = recording(HAPPY);
    const posted = recorded('LG-2026-0093');
    const { switchTo } = renderSwitchable(transport, `/bills?bill=${posted.id}`);
    await screen.findByRole('dialog');
    switchTo('ws_b');
    // ws_b answers the same recording (so the id exists there too), and the drawer still stays shut.
    await screen.findByText('LG-2026-0093');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a Buchen answered after the switch speaks nowhere and re-reads nothing in the new workspace', async () => {
    let answer: (r: RestResponse) => void = () => undefined;
    const pending = new Promise<RestResponse>((resolve) => {
      answer = resolve;
    });
    const { asked, transport } = recording({ ...HAPPY, record_expense: (() => pending) as unknown as RestResponse });
    const { switchTo } = renderSwitchable(transport, '/bills?new=1');
    const dialog = await screen.findByRole('dialog');
    await drawerSettled(dialog);
    await pickVendor(dialog, 'Lieferant GmbH');
    await userEvent.type(dialog.querySelector('#bill-amount') as HTMLElement, '1081');
    await chooseAccount(dialog, '6500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(asked.some((a) => a.action === 'record_expense')).toBe(true));
    expect(asked.find((a) => a.action === 'record_expense')?.input.workspaceId).toBe('ws_a');

    switchTo('ws_b');
    await waitFor(() =>
      expect(asked.some((a) => a.action === 'list_vendor_bills' && a.input.workspaceId === 'ws_b')).toBe(true),
    );
    await screen.findByText('LG-2026-0093');
    const before = asked.length;
    await act(async () => {
      answer(ok({ vendorBillId: 'vb_ws_a' }));
      await pending;
    });
    // Nothing re-read on ws_a's answer, and no Commit moment lands on a ws_b row.
    expect(asked.slice(before)).toEqual([]);
    expect(document.querySelector('.motion-commit-target')).toBeNull();
  });

  it("an old workspace's late list answer never overwrites the new workspace's list", async () => {
    let answerA: (r: RestResponse) => void = () => undefined;
    const pendingA = new Promise<RestResponse>((resolve) => {
      answerA = resolve;
    });
    const inner = fakeTransport(HAPPY);
    const transport: Transport = (action, input) => {
      const ws = (input as { workspaceId?: string }).workspaceId;
      if (action === 'list_vendor_bills' && ws === 'ws_a') return pendingA;
      if (action === 'list_vendor_bills' && ws === 'ws_b') {
        return Promise.resolve(ok({ ...listFixture, bills: listFixture.bills.slice(0, 1) }));
      }
      return inner(action, input);
    };
    const { switchTo } = renderSwitchable(transport);
    switchTo('ws_b');
    await screen.findByText('LG-2026-0107');
    await act(async () => {
      answerA(ok(listFixture));
      await pendingA;
    });
    // ws_b's one row stays; ws_a's six never appear.
    expect(screen.queryByText('LG-2026-0093')).not.toBeInTheDocument();
    expect(screen.getByText('LG-2026-0107')).toBeInTheDocument();
  });
});

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
