/**
 * A41.3 re-cut v2 (D184) in the Studio: the person's receipt assignment on an OPEN line (`assign_beleg`), who
 * assigned it on the clip and in the review view, "Lösen" (`release_beleg`), I-E (no field, no state), and the
 * figure trust beside a candidate with "Zahlen bestätigen" (`confirm_capture_figures`). A41.3 follow-ups: a drop on an
 * open row is the person's assignment (`assign_beleg_file`), and a new version left on the line asks "Zuordnen".
 *
 * SYNTHETIC DATA ONLY: every name, IBAN, file and figure here is invented.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { CAP, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore } from '../../lib/prefs';
import { recordedOk } from '../../lib/test-support';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import Bank from './index';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function account(number: string): string {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
}
const BANK_LEDGER = account('1020');
const ACCOUNT = { id: 'ba_1', name: 'Seeufer Geschäftskonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: BANK_LEDGER, archived: false };

const LINE = {
  attention: 'sure',
  receiptCount: 0,
  needsReceipt: false,
  bankTxnId: 'bt_rule',
  bankAccountId: 'ba_1',
  statementId: 'st_1',
  state: 'open',
  bookingDate: '2026-10-14',
  valueDate: '2026-10-15',
  amountMinor: -1_250,
  currency: 'CHF',
  creditDebit: 'DBIT',
  reversal: false,
  counterparty: { name: 'Wolkenhaus Hosting AG', iban: null },
  remittance: { text: 'Hosting Oktober', referenceKind: 'NON', referenceValue: null, endToEndId: null },
  entryRef: null,
  creditId: null,
  decision: null,
  proposal: { target: { kind: 'accounts', legs: [{ accountId: account('6900'), amountMinor: 1_250, taxCode: '' }] }, certainty: 'sure', reasonCode: 'standard', reasonParams: { standardId: 'bs_1' }, vatCode: null },
  standardId: 'bs_1',
  ruleIds: [],
  followUp: null,
  vorschlagActionId: null,
  bulkBookable: true,
  belegCandidates: [
    {
      groupKey: 'g1',
      files: [{ fileId: 'file_inv', captureId: 'cap_1', filename: 'wolkenhaus-oktober.pdf', vendorName: 'Wolkenhaus Hosting AG', invoiceDate: '2026-10-12', amountMinor: 1_250, currency: 'CHF', vatAmountMinor: null }],
      amountMinor: 1_250,
      currency: 'CHF',
      vendorName: 'Wolkenhaus Hosting AG',
      date: '2026-10-12',
      match: { amount: 'exact', days: 2, counterparty: 'name' },
      vat: null,
    },
  ],
};
const ASSIGNED = {
  ...LINE,
  belegCandidates: [],
  belegAssignment: { assignmentId: 'ba_1', source: 'engine_unique', createdAt: '2026-10-14T08:00:00Z', files: [{ fileId: 'file_inv', captureId: 'cap_1', amountMinor: 1_250, currency: 'CHF', vatMinor: null }] },
};

const SUMMARY = {
  bankAccountId: 'ba_1',
  name: 'Seeufer Geschäftskonto',
  iban: 'CH5604835012345678009',
  currency: 'CHF',
  ledgerAccountId: BANK_LEDGER,
  judgeable: false,
  reason: 'no_statement',
  statementId: 'st_1',
  statementDate: '2026-10-14',
  bankBalanceMinor: null,
  ledgerBalanceMinor: null,
  openCount: 0,
  openSumMinor: 0,
  differenceMinor: null,
};

const pdf: Canned = { files_get_content: ok({ contentBase64: btoa('%PDF-1.4'), mime: 'application/pdf', filename: 'wolkenhaus-oktober.pdf' }) };
const ENGINE_FIELDS = { amount: { minor: 1_250, currency: 'CHF' }, vendor_name: 'Wolkenhaus Hosting AG', iban: 'CH9300762011623852957', vendor_uid: 'CHE-109.322.551', invoice_date: '2026-10-12', reference: '210000000003139471430009017' };
const capture = (trust: string | null, provenance: string, engineFields: Record<string, unknown> = ENGINE_FIELDS): RestResponse =>
  ok({
    documentId: 'file_inv',
    capture: { id: 'cap_1', status: 'needs_review', sha256: 'a'.repeat(64), engineFields, figuresTrusted: trust !== null, figuresTrust: trust },
    fields: [
      { key: 'amount', value: { minor: 1_250, currency: 'CHF' }, provenance, confidence: 'high', superseded: false },
      { key: 'vendor_name', value: 'Wolkenhaus Hosting AG', provenance, confidence: 'high', superseded: false },
      { key: 'vendor_name', value: 'Alter Name', provenance, confidence: 'high', superseded: true },
      { key: 'iban', value: 'CH9300762011623852957', provenance, confidence: 'high', superseded: false },
      { key: 'vendor_uid', value: 'CHE-109.322.551', provenance, confidence: 'high', superseded: false },
      { key: 'invoice_date', value: '2026-10-12', provenance, confidence: 'high', superseded: false },
    ],
  });

function canned(lines: unknown[], extra: Canned = {}): Canned {
  return {
    list_bank_accounts: ok({ bankAccounts: [ACCOUNT] }),
    list_bank_inbox: (input) => {
      const status = input.status as string;
      const mine = lines.filter((l) => (l as { state: string }).state === status || status === 'all');
      return ok({ lines: input.limit === 1 ? mine.slice(0, 1) : mine, nextCursor: null, total: mine.length, summary: [SUMMARY], bulkLearnedMin: null });
    },
    list_accounts: { status: 200, body: recordedOk(listAccountsFixture) },
    vat_codes: ok({ taxCodes: [] }),
    list_open_items: ok({ items: [] }),
    list_vendor_bills: ok({ bills: [] }),
    list_drafted_actions: ok({ actions: [] }),
    get_agent_dial: ok({ levels: { post: 'ask', pay: 'ask' } }),
    list_bank_standards: ok({ standards: [] }),
    compose_entry: ok({ mode: 'expand', composed: false, stamped: false, lines: [], captions: [], verdict: { ok: true } }),
    files_list_linked: ok({ files: [] }),
    ...extra,
  };
}

function recording(c: Canned) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = async (action, input) => {
    calls.push({ action, input });
    const entry = c[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
  return { transport, calls };
}

const EVERY_RIGHT = [CAP.readSales, CAP.post, CAP.pay, CAP.manageFiles, CAP.readMasterData, CAP.readFileContent, 'manage_agent_dial', 'read_books', 'read_vat'];
function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'member', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  } as Capabilities;
}

function renderBank(transport: Transport) {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:a413/1' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  return render(
    <CapabilitiesContext.Provider value={caps(EVERY_RIGHT)}>
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="de-CH">
          <WorkspaceProvider initialId="ws_test">
            <PrefsProvider store={new PrefsStore(null, null, { useCache: false })}>
              <MemoryRouter initialEntries={['/bank']}>
                <Bank />
              </MemoryRouter>
            </PrefsProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
    </CapabilitiesContext.Provider>,
  );
}

async function rowReady(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`tr.bank-row[data-line="${id}"]`)).not.toBeNull());
  return document.querySelector(`tr.bank-row[data-line="${id}"]`) as HTMLElement;
}
async function openArea(id: string): Promise<HTMLElement> {
  const row = await rowReady(id);
  await userEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement);
  return waitFor(() => {
    const area = document.querySelector(`[data-area-for="${id}"]`);
    expect(area).not.toBeNull();
    return area as HTMLElement;
  });
}

/** The trust fields on screen, by key: [label, value], read off the labelled elements. */
function shownFields(root: HTMLElement): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const el of root.querySelectorAll<HTMLElement>('.figure-trust__field')) {
    out[el.dataset.field ?? ''] = [el.querySelector('dt')?.textContent ?? '', el.querySelector('dd')?.textContent ?? ''];
  }
  return out;
}

describe('A41.3: the person assigns, releases and vouches', () => {
  it('the clip\'s one candidate on an OPEN line is assigned (assign_beleg), never filed with files_link', async () => {
    const { transport, calls } = recording(canned([LINE], { assign_beleg: ok({ assignmentId: 'ba_1', bankTxnId: 'bt_rule', fileIds: ['file_inv'], replaced: [], alreadyAssigned: false }) }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    await userEvent.click(within(row).getByRole('button', { name: /1 passender Beleg, anhängen/ }));
    await waitFor(() => expect(calls.find((c) => c.action === 'assign_beleg')?.input).toMatchObject({ bankTxnId: 'bt_rule', fileIds: ['file_inv'] }));
    expect(calls.some((c) => c.action === 'files_link')).toBe(false);
  });

  it('an assigned line says who assigned it, on the clip and in the review view; Lösen calls release_beleg', async () => {
    const { transport, calls } = recording(canned([ASSIGNED], { ...pdf, get_capture: capture('qr', 'qr'), release_beleg: ok({ bankTxnId: 'bt_rule', releasedAssignmentId: 'ba_1', alreadyReleased: false }) }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    expect(within(row).getByRole('button', { name: 'Belege, Wolkenhaus Hosting AG, zugeordnet: Von TILL zugeordnet, passt eindeutig' })).toHaveAttribute('data-assigned', 'engine_unique');
    const area = await openArea('bt_rule');
    const preview = await within(area).findByRole('region', { name: 'Zugeordneter Beleg' });
    expect(preview).toHaveTextContent('Von TILL zugeordnet, passt eindeutig');
    expect(await within(area).findByText('Zahlen aus dem QR-Code')).toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: 'Zahlen bestätigen' })).toBeNull();
    await userEvent.click(within(area).getByRole('button', { name: 'Lösen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'release_beleg')?.input).toMatchObject({ bankTxnId: 'bt_rule' }));
  });

  it('figures that moved since they were shown are refused: the view reloads, says so, and nothing retries', async () => {
    let reads = 0;
    const { transport, calls } = recording(
      canned([LINE], {
        ...pdf,
        get_capture: () => {
          reads += 1;
          return capture(null, 'agent');
        },
        confirm_capture_figures: { status: 409, body: { ok: false, error: 'figures_changed' } },
      }),
    );
    renderBank(transport);
    const area = await openArea('bt_rule');
    await within(area).findByText('Vom Agent gelesen, nicht bestätigt');
    const before = reads;
    await userEvent.click(within(area).getByRole('button', { name: 'Zahlen bestätigen' }));
    expect(await within(document.body).findByText('Die Zahlen haben sich geändert. Prüf sie und bestätige nochmals.')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect(calls.filter((c) => c.action === 'confirm_capture_figures')).toHaveLength(1);
  });

  it('a free-text value cannot imitate another field, and a non-date in a date field is shown in full', async () => {
    const fields = { amount: { minor: 1_250, currency: 'CHF' }, vendor_name: 'Acme, CHF 16.10, IBAN CH0000000000000000000', invoice_date: '2026-07-01 / IBAN CH1111111111111111111' };
    const { transport, calls } = recording(canned([LINE], { ...pdf, get_capture: capture(null, 'agent', fields), confirm_capture_figures: ok({ confirmed: [] }) }));
    renderBank(transport);
    const area = await openArea('bt_rule');
    await within(area).findByText('Vom Agent gelesen, nicht bestätigt');
    const shown = shownFields(area);
    // The vendor is ONE labelled value; nothing of it reads as an amount or an IBAN field.
    expect(shown.vendor_name).toEqual(['Lieferant', 'Acme, CHF 16.10, IBAN CH0000000000000000000']);
    expect(shown.amount).toEqual(['Betrag', 'CHF 12.50']);
    expect(shown.iban).toBeUndefined();
    // Not a clean date: the whole value, unformatted.
    expect(shown.invoice_date).toEqual(['Rechnung vom', '2026-07-01 / IBAN CH1111111111111111111']);
    await userEvent.click(within(area).getByRole('button', { name: 'Zahlen bestätigen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'confirm_capture_figures')).toBe(true));
    // The confirmation sends back exactly the fields shown.
    expect(calls.find((c) => c.action === 'confirm_capture_figures')?.input.captures).toEqual([{ captureId: 'cap_1', expected: { sha256: 'a'.repeat(64), fields } }]);
  });

  it('a line break, a right-to-left override or a zero-width space cannot be shown exactly: shown isolated and normalised, never confirmable here', async () => {
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const fields = { amount: { minor: 1_250, currency: 'CHF' }, vendor_name: `Acme ${RLO}GA hcaB`, iban: `CH93${ZWSP}00762011623852957`, invoice_date: '2026-10-12' };
    const { transport, calls } = recording(canned([LINE], { ...pdf, get_capture: capture(null, 'agent', fields) }));
    renderBank(transport);
    const area = await openArea('bt_rule');
    await within(area).findByText('Vom Agent gelesen, nicht bestätigt');
    const shown = shownFields(area);
    expect(shown.vendor_name?.[1]).toBe('Acme  GA hcaB');
    expect(shown.iban?.[1]).toBe('CH93 00762011623852957');
    expect(area.textContent ?? '').not.toContain(RLO);
    expect(area.textContent ?? '').not.toContain(ZWSP);
    for (const dd of area.querySelectorAll('.figure-trust__field dd')) expect(dd).toHaveAttribute('dir', 'ltr');
    // Fail closed: no confirmation is offered, so no value the person did not see is vouched for.
    expect(within(area).queryByRole('button', { name: 'Zahlen bestätigen' })).toBeNull();
    expect(within(area).getByText(/lässt sich nicht genau so zeigen/)).toBeInTheDocument();
    expect(calls.some((c) => c.action === 'confirm_capture_figures')).toBe(false);
    // A line break blocks the same way.
    const { transport: t2, calls: c2 } = recording(canned([LINE], { ...pdf, get_capture: capture(null, 'agent', { ...ENGINE_FIELDS, vendor_name: 'Acme,\nIBAN CH00' }) }));
    document.body.innerHTML = '';
    renderBank(t2);
    const again = await openArea('bt_rule');
    await within(again).findByText('Vom Agent gelesen, nicht bestätigt');
    expect(within(again).queryByRole('button', { name: 'Zahlen bestätigen' })).toBeNull();
    expect(c2.some((c) => c.action === 'confirm_capture_figures')).toBe(false);
  });

  it('I-E: a line without the field shows no assignment state at all', async () => {
    renderBank(recording(canned([{ ...LINE, belegCandidates: [] }])).transport);
    const row = await rowReady('bt_rule');
    expect(row.querySelector('[data-assigned]')).toBeNull();
  });

  it('a candidate whose amount the agent read says so; "Zahlen bestätigen" calls confirm_capture_figures', async () => {
    const { transport, calls } = recording(canned([LINE], { ...pdf, get_capture: capture(null, 'agent'), confirm_capture_figures: ok({ confirmed: [{ captureId: 'cap_1', alreadyConfirmed: false }] }) }));
    renderBank(transport);
    const area = await openArea('bt_rule');
    expect(await within(area).findByText('Vom Agent gelesen, nicht bestätigt')).toBeInTheDocument();
    // What the person sees is what the confirmation vouches for: the same read, EVERY trust field with a value,
    // each its own labelled element.
    const shownAtClick = shownFields(area);
    expect(shownAtClick).toEqual({
      vendor_name: ['Lieferant', 'Wolkenhaus Hosting AG'],
      iban: ['IBAN', 'CH9300762011623852957'],
      vendor_uid: ['UID', 'CHE-109.322.551'],
      amount: ['Betrag', 'CHF 12.50'],
      invoice_date: ['Rechnung vom', '12.10.2026'],
      reference: ['Referenz', '210000000003139471430009017'],
    });
    await userEvent.click(within(area).getByRole('button', { name: 'Zahlen bestätigen' }));
    await waitFor(() => expect(calls.some((c) => c.action === 'confirm_capture_figures')).toBe(true));
    // The engine's shape: captures [{ captureId, expected: { sha256, fields } }], the read's engineFields as answered.
    const captures = calls.find((c) => c.action === 'confirm_capture_figures')?.input.captures as { captureId: string; expected: { sha256: string; fields: Record<string, unknown> } }[];
    expect(captures).toEqual([{ captureId: 'cap_1', expected: { sha256: 'a'.repeat(64), fields: ENGINE_FIELDS } }]);
    // Every field the confirmation names was on screen, under its own label, when it was clicked, and nothing else.
    expect(Object.keys(shownAtClick).sort()).toEqual(Object.keys(captures[0]?.expected.fields ?? {}).sort());
    // On the open line the review view's Zuordnen is the person's assignment too.
    expect(within(area).getByRole('button', { name: 'Zuordnen' })).toBeInTheDocument();
  });
});

describe('A41.3: a value shown differently from what would be sent is never confirmable', () => {
  for (const [what, engineFields] of [
    ['a fractional minor', { ...ENGINE_FIELDS, amount: { minor: 1_250.5, currency: 'CHF' } }],
    ['a currency with a hidden character', { ...ENGINE_FIELDS, amount: { minor: 1_250, currency: `CH${String.fromCharCode(0x202e)}F` } }],
  ] as const) {
    it(`${what}: no Zahlen bestätigen, the reason in words, nothing sent`, async () => {
      const { transport, calls } = recording(canned([LINE], { ...pdf, get_capture: capture(null, 'agent', engineFields) }));
      renderBank(transport);
      const area = await openArea('bt_rule');
      await within(area).findByText('Vom Agent gelesen, nicht bestätigt');
      expect(within(area).queryByRole('button', { name: 'Zahlen bestätigen' })).toBeNull();
      expect(within(area).getByText(/lässt sich nicht genau so zeigen/)).toBeInTheDocument();
      expect(calls.some((c) => c.action === 'confirm_capture_figures')).toBe(false);
    });
  }
});

describe('A41.3 re-cut v3: booking with a receipt assigned to ANOTHER bank line', () => {
  it('the ✓ is refused receipt_assigned: the dialog names that line, Lösen, then the person books again; never on its own', async () => {
    let held = true;
    const books: Record<string, unknown>[] = [];
    const { transport, calls } = recording(
      canned([LINE], {
        book_bank_line: (input) => {
          books.push(input);
          return held ? { status: 409, body: { ok: false, error: 'receipt_assigned', holders: [{ bankTxnId: 'bt_other', assignmentId: 'ba_9', source: 'person' }] } } : ok({ state: 'booked', entryId: 'je_1', warnings: [] });
        },
        release_beleg: () => {
          held = false;
          return ok({ bankTxnId: 'bt_other', releasedAssignmentId: 'ba_9', alreadyReleased: false });
        },
      }),
    );
    renderBank(transport);
    const row = await rowReady('bt_rule');
    await userEvent.click(within(row).getByRole('button', { name: 'Buchen' }));
    const dialog = await within(document.body).findByRole('alertdialog', { name: 'Beleg einer Bankzeile zugeordnet' });
    expect(books).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lösen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'release_beleg')?.input).toMatchObject({ bankTxnId: 'bt_other' }));
    expect(books).toHaveLength(1);
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Nochmals' }));
    await waitFor(() => expect(books).toHaveLength(2));
    expect(books[1]?.attach).toEqual(books[0]?.attach);
  });
});

// --- A41.3 follow-ups: the drop on an open row assigns; "Neue Version, bitte zuordnen" -------------------------------

const UNASSIGNED = { ...LINE, belegCandidates: [] };
const NEW_VERSION = { ...LINE, belegCandidates: [], receiptCount: 1, newVersionToAssign: { fileId: 'file_v2' } };
const FILED = {
  id: 'file_v2',
  title: 'Quittung v2',
  filename: 'quittung-v2.png',
  mime: 'image/png',
  bytes: 120,
  sha256: 'b'.repeat(64),
  version: 2,
  createdAt: '2026-10-14T09:00:00Z',
  updatedAt: '2026-10-14T09:00:00Z',
  retentionLocked: false,
  pendingDelete: false,
  folderId: null,
  entityKind: 'bank_txn',
  entityId: 'bt_rule',
  retentionUntil: null,
  retentionSource: null,
  supersedesId: 'file_v1',
  tags: [],
};
const ASSIGNED_OK = ok({ bankTxnId: 'bt_rule', fileId: 'file_v2', captureId: 'cap_9', assignmentId: 'basg_9', amountFrom: 'line', notAssigned: null, released: [], alreadyAssigned: false });
const drop = (row: HTMLElement, name: string) => {
  const file = new File(['synthetisch'], name, { type: 'image/png' });
  fireEvent.drop(row, { dataTransfer: { files: [file], types: ['Files'], dropEffect: 'none' } });
};

describe('A41.3 follow-ups: a filed file is captured and assigned in one act', () => {
  it('a file dropped on an OPEN line with no assigned receipt: files_upload, then assign_beleg_file; never files_link', async () => {
    const { transport, calls } = recording(canned([UNASSIGNED], { files_upload: ok({ file: { id: 'file_d' } }), assign_beleg_file: ASSIGNED_OK }));
    renderBank(transport);
    drop(await rowReady('bt_rule'), 'quittung.png');
    await waitFor(() => expect(calls.find((c) => c.action === 'assign_beleg_file')?.input).toMatchObject({ bankTxnId: 'bt_rule', fileId: 'file_d' }));
    expect(typeof calls.find((c) => c.action === 'assign_beleg_file')?.input.idempotencyKey).toBe('string');
    expect(calls.some((c) => c.action === 'files_link')).toBe(false);
    expect(await screen.findByText('Beleg zugeordnet: Wolkenhaus Hosting AG.')).toBeInTheDocument();
  });

  it('a line that already holds an assigned receipt keeps the D142 filing (files_link), never a second assignment', async () => {
    const { transport, calls } = recording(canned([ASSIGNED], { ...pdf, get_capture: capture('qr', 'qr'), files_upload: ok({ file: { id: 'file_d' } }), files_link: ok({ file: { id: 'file_d' }, retentionDerived: false }) }));
    renderBank(transport);
    drop(await rowReady('bt_rule'), 'zweiter.png');
    await waitFor(() => expect(calls.find((c) => c.action === 'files_link')?.input).toMatchObject({ fileId: 'file_d', entityKind: 'bank_txn', entityId: 'bt_rule' }));
    expect(calls.some((c) => c.action === 'assign_beleg_file')).toBe(false);
  });

  it('under assign_if_stated a file without its own amount is filed and captured, and the ack says the amount is missing', async () => {
    const { transport } = recording(
      canned([UNASSIGNED], {
        files_upload: ok({ file: { id: 'file_d' } }),
        assign_beleg_file: ok({ bankTxnId: 'bt_rule', fileId: 'file_d', captureId: 'cap_9', assignmentId: null, amountFrom: null, notAssigned: 'beleg_without_amount', released: [], alreadyAssigned: false }),
      }),
    );
    renderBank(transport);
    drop(await rowReady('bt_rule'), 'ohne-betrag.png');
    expect(await screen.findByText('Beleg abgelegt und erfasst: Wolkenhaus Hosting AG. Er nennt keinen Betrag. Nenne ihn, dann ordne ihn zu.')).toBeInTheDocument();
  });

  it('"Neue Version, bitte zuordnen": the row\'s clip says it and its one act assigns the new version (assign_beleg_file)', async () => {
    const { transport, calls } = recording(canned([NEW_VERSION], { assign_beleg_file: ASSIGNED_OK }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    const clip = within(row).getByRole('button', { name: 'Belege, Wolkenhaus Hosting AG: neue Version, bitte zuordnen' });
    expect(clip).toHaveAttribute('data-new-version', 'true');
    await userEvent.click(clip);
    await waitFor(() => expect(calls.find((c) => c.action === 'assign_beleg_file')?.input).toMatchObject({ bankTxnId: 'bt_rule', fileId: 'file_v2' }));
  });

  it('critic r1 F1: an AGENT\'s new version says so on the clip (confirm the figures); its act is still the one "Zuordnen"', async () => {
    const { transport, calls } = recording(canned([{ ...NEW_VERSION, newVersionOrigin: 'machine' }], { assign_beleg_file: ASSIGNED_OK }));
    renderBank(transport);
    const row = await rowReady('bt_rule');
    const clip = within(row).getByRole('button', { name: 'Belege, Wolkenhaus Hosting AG: neue Version vom Agenten, Zahlen bestätigen' });
    expect(clip).toHaveAttribute('data-new-version', 'machine');
    await userEvent.click(clip);
    await waitFor(() => expect(calls.find((c) => c.action === 'assign_beleg_file')?.input).toMatchObject({ fileId: 'file_v2' }));
  });

  it('the review view of that line names it and "Zuordnen" assigns the new version', async () => {
    const { transport, calls } = recording(canned([NEW_VERSION], { ...pdf, files_list_linked: ok({ files: [FILED] }), assign_beleg_file: ASSIGNED_OK }));
    renderBank(transport);
    const area = await openArea('bt_rule');
    await waitFor(() => expect(area.querySelector('[data-new-version="true"]')).not.toBeNull());
    expect(within(area).getAllByText('Neue Version, bitte zuordnen').length).toBeGreaterThan(0);
    await userEvent.click(within(area).getByRole('button', { name: 'Zuordnen' }));
    await waitFor(() => expect(calls.find((c) => c.action === 'assign_beleg_file')?.input).toMatchObject({ bankTxnId: 'bt_rule', fileId: 'file_v2' }));
  });
});
