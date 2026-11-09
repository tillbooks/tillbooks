/**
 * D152 rule 5 on the money path: the pain.001 run holds exactly the bills the PERSON ticked.
 *
 * The cognitive-load audit (02.10.2026) measured one payable PRE-TICKED on load (the F-03 / J3.4
 * pre-selection of the bills due by the execution date), so a person could generate a payment file
 * holding a payment they never chose. These cases hold the fix:
 *   - nothing is ticked, current or tinted on load, even with a bill due and a proposal flag on it;
 *     the due bills are a suggestion LINE whose one act ("Fällige auswählen") ticks them;
 *   - the create payload carries exactly the ticked ids, in the shape develop sent;
 *   - a workspace switch clears every tick, and an answer from the workspace just left speaks nowhere;
 *   - a `?focus=` deep link marks its row current without ticking it;
 *   - the create key is one per act: a retry of the same act reuses it, a changed selection does not.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import CreditorPayments from './index';

const ok = (body: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...body } });

const BILL = {
  vendorId: 'contact_1',
  currency: 'CHF',
  vendorReference: null,
  hasCreditorProfile: true,
  creditorIban: 'CH9300762011623852957',
  creditorIbanMasked: '•••• 5295',
  isQrIban: false,
  referenceKind: 'free_text',
  referenceValid: true,
  batchable: true,
  alreadyBatchedInto: null,
};

// vb_due is due by any execution date from today on, so the surface SUGGESTS it. The two flags an
// engine might one day answer with a proposal are set on it too: neither may tick a box.
const DUE = { ...BILL, billId: 'vb_due', vendorName: 'Stadtwerke Probe', amountMinor: 48000, dueDate: '2026-09-04', proposed: true, selected: true };
const LATER = { ...BILL, billId: 'vb_later', vendorName: 'Rösterei Probe', amountMinor: 10702, dueDate: '2099-11-02' };
const LATEST = { ...BILL, billId: 'vb_latest', vendorName: 'Druckerei Probe', amountMinor: 5000, dueDate: '2099-12-01' };
const OTHER_WS = { ...BILL, billId: 'vb_b1', vendorName: 'Anderer Mandant AG', amountMinor: 7000, dueDate: '2099-01-01' };

const ACCOUNT = { id: 'ba_chf', name: 'Hauptkonto CHF', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', receiveOnly: false, archived: false };

const BATCH_GENERATED = {
  id: 'pbatch_1',
  bankAccountId: 'ba_chf',
  executionDate: '2026-10-03',
  status: 'generated',
  ctrlSumMinor: 48000,
  nbOfTxs: 1,
  msgId: 'PB-1',
  createdBy: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  items: [],
};

const GENERATED = ok({
  batchId: 'pbatch_1',
  xmlBase64: Buffer.from('<Document/>').toString('base64'),
  filename: 'pain001-pbatch_1.xml',
  valid: true,
  warnings: [],
  ctrlSumMinor: 48000,
  nbOfTxs: 1,
  transmitted: false,
  reason: 'no_channel',
  batch: BATCH_GENERATED,
});

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface Call {
  action: string;
  input: Record<string, unknown>;
}

/** A transport that records every call and answers per workspace; `over` replaces any verb. */
function recording(over: (call: Call) => Promise<RestResponse> | RestResponse | undefined = () => undefined) {
  const calls: Call[] = [];
  const transport: Transport = async (action, input) => {
    const call = { action, input };
    calls.push(call);
    const own = await over(call);
    if (own !== undefined) return own;
    if (action === 'list_payable') {
      return input.workspaceId === 'ws_b'
        ? ok({ items: [OTHER_WS], total: 1, baseCurrency: 'CHF' })
        : ok({ items: [DUE, LATER, LATEST], total: 3, baseCurrency: 'CHF' });
    }
    if (action === 'list_bank_accounts') return ok({ bankAccounts: [ACCOUNT] });
    if (action === 'create_payment_batch') return ok({ batchId: 'pbatch_1', batch: { ...BATCH_GENERATED, status: 'draft' } });
    if (action === 'generate_pain001') return GENERATED;
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { calls, transport, of: (action: string) => calls.filter((c) => c.action === action) };
}

let switchTo: (id: string) => void = () => undefined;
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = (id) => setWorkspaceId(id);
  return null;
}

function mount(transport: Transport, entry = '/creditor-payments') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_a">
          <Switcher />
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps([CAP.pay, CAP.post])}>
              <Routes>
                <Route path="/creditor-payments" element={<CreditorPayments />} />
              </Routes>
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

function deferred() {
  let resolve: (value: RestResponse) => void = () => undefined;
  const promise = new Promise<RestResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const today = () => new Date().toISOString().slice(0, 10);
const box = (name: RegExp) => screen.getByRole('checkbox', { name });
const generateButton = () => screen.getByRole('button', { name: 'pain.001 generieren' });

/** Nothing ticked, current or tinted in the payable table. */
function expectNothingChosen() {
  const table = screen.getByRole('table');
  for (const b of within(table).getAllByRole('checkbox')) expect(b).not.toBeChecked();
  expect(table.querySelector('[aria-current="true"], [aria-selected="true"], tr[data-selected]')).toBeNull();
}

beforeEach(() => {
  installMemoryStorage();
});

describe('CreditorPayments, D152 rule 5: nothing is ticked for the person', () => {
  it('on load nothing is ticked, current or tinted, even with a bill due and a proposal flag on it; Generate waits', async () => {
    const t = recording();
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await waitFor(() => expect(screen.getByLabelText('Belastungskonto')).toHaveTextContent('Hauptkonto CHF'));

    expectNothingChosen();
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText('Ausgewählter Betrag').parentElement).toHaveTextContent('CHF 0.00');
    // The proposal is a LINE: it names the due bill and its sum, it ticks nothing.
    expect(screen.getByText(/^Vorschlag: 1 Zahlung fällig bis \d\d\.\d\d\.\d{4}, CHF 480\.00\.$/)).toBeTruthy();
    expect(t.of('create_payment_batch')).toHaveLength(0);
    expect(t.of('generate_pain001')).toHaveLength(0);
  });

  it('the suggestion ticks its bills only on the explicit "Fällige auswählen" act, and the line then goes', async () => {
    const user = userEvent.setup();
    const t = recording();
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(screen.getByRole('button', { name: 'Fällige auswählen' }));
    expect(box(/Stadtwerke Probe/)).toBeChecked();
    expect(box(/Rösterei Probe/)).not.toBeChecked();
    expect(box(/Druckerei Probe/)).not.toBeChecked();
    expect(screen.queryByText(/^Vorschlag:/)).toBeNull();
    // Unticking it by hand empties the selection and brings the suggestion back, ticking nothing.
    await user.click(box(/Stadtwerke Probe/));
    expectNothingChosen();
    expect(screen.getByRole('button', { name: 'Fällige auswählen' })).toBeTruthy();
  });

  it('a changed execution date moves the suggestion and still ticks nothing', async () => {
    mount(recording().transport);
    await screen.findByText('Stadtwerke Probe');
    fireEvent.change(screen.getByLabelText('Ausführungsdatum'), { target: { value: '2099-11-30' } });
    expect(screen.getByText(/^Vorschlag: 2 Zahlungen fällig bis 30\.11\.2099, CHF 587\.02\.$/)).toBeTruthy();
    expectNothingChosen();
  });
});

describe('CreditorPayments: the run holds exactly the ticked ids (payload pinned to develop)', () => {
  it('ticking two bills that are NOT the suggestion sends exactly those two, in the shape develop sent', async () => {
    const user = userEvent.setup();
    const t = recording();
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await user.click(box(/Druckerei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');

    const [create] = t.of('create_payment_batch');
    // The exact payload develop (8ddafb92) sends for the same ticked set: same verb, same five
    // fields, nothing added. Only WHICH ids is now the person's alone.
    expect(create.input).toEqual({
      workspaceId: 'ws_a',
      bankAccountId: 'ba_chf',
      itemIds: ['vb_later', 'vb_latest'],
      executionDate: today(),
      idempotencyKey: expect.any(String),
    });
    expect(create.input.itemIds).not.toContain('vb_due');
    const [generate] = t.of('generate_pain001');
    expect(generate.input).toEqual({ workspaceId: 'ws_a', batchId: 'pbatch_1', idempotencyKey: expect.any(String) });
    expect(t.of('create_payment_batch')).toHaveLength(1);
  });

  it('taking the suggestion sends exactly the suggested bill', async () => {
    const user = userEvent.setup();
    const t = recording();
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(screen.getByRole('button', { name: 'Fällige auswählen' }));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    expect(t.of('create_payment_batch')[0].input.itemIds).toEqual(['vb_due']);
  });
});

describe('CreditorPayments: a workspace switch', () => {
  it('clears every tick, and switching back does not bring them back', async () => {
    const user = userEvent.setup();
    mount(recording().transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await user.click(box(/Druckerei Probe/));
    expect(box(/Rösterei Probe/)).toBeChecked();

    act(() => switchTo('ws_b'));
    await screen.findByText('Anderer Mandant AG');
    expect(screen.queryByText('Rösterei Probe')).toBeNull();
    expectNothingChosen();
    expect(screen.getByText('Ausgewählter Betrag').parentElement).toHaveTextContent('CHF 0.00');

    act(() => switchTo('ws_a'));
    await screen.findByText('Rösterei Probe');
    expectNothingChosen();
    expect(generateButton()).toBeDisabled();
  });

  it('a generate still running across the switch completes where it was made and speaks nowhere', async () => {
    const user = userEvent.setup();
    const held = deferred();
    const t = recording(({ action }) => (action === 'create_payment_batch' ? held.promise : undefined));
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Stadtwerke Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await waitFor(() => expect(t.of('create_payment_batch')).toHaveLength(1));

    act(() => switchTo('ws_b'));
    await screen.findByText('Anderer Mandant AG');
    await act(async () => {
      held.resolve(ok({ batchId: 'pbatch_1', batch: { ...BATCH_GENERATED, status: 'draft' } }));
    });
    // The act the person made in ws_a finishes there (no half-done draft batch left holding bills)...
    await waitFor(() => expect(t.of('generate_pain001')).toHaveLength(1));
    expect(t.of('generate_pain001')[0].input.workspaceId).toBe('ws_a');
    // ...and nothing of it shows under ws_b.
    expect(screen.queryByText('Datei ist gültig')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Anderer Mandant AG')).toBeTruthy();
    expectNothingChosen();
  });

  it('a payable read from the workspace just left, answered late, never paints over the new one', async () => {
    const late = deferred();
    const t = recording(({ action, input }) =>
      action === 'list_payable' && input.workspaceId === 'ws_a' ? late.promise : undefined,
    );
    mount(t.transport);
    await waitFor(() => expect(t.of('list_payable')).toHaveLength(1));
    act(() => switchTo('ws_b'));
    await screen.findByText('Anderer Mandant AG');
    await act(async () => {
      late.resolve(ok({ items: [DUE, LATER], total: 2, baseCurrency: 'CHF' }));
    });
    expect(screen.queryByText('Stadtwerke Probe')).toBeNull();
    expect(screen.getByText('Anderer Mandant AG')).toBeTruthy();
  });
});

describe('CreditorPayments: a re-read', () => {
  it('only narrows the ticks: a ticked bill that left the list is no longer in the run', async () => {
    const user = userEvent.setup();
    const NO_PROFILE = { ...LATEST, hasCreditorProfile: false, creditorIban: null, creditorIbanMasked: null, isQrIban: null, referenceKind: 'none' };
    let reads = 0;
    const t = recording(({ action }) => {
      if (action === 'list_payable') {
        reads += 1;
        // The second read: the ticked bill was settled elsewhere, and the IBAN now sits on the other.
        return reads === 1
          ? ok({ items: [LATER, NO_PROFILE], total: 2, baseCurrency: 'CHF' })
          : ok({ items: [LATEST], total: 1, baseCurrency: 'CHF' });
      }
      if (action === 'set_creditor_bank_profile') return ok({ creditorBankProfileId: 'cbp_1', vendorId: 'contact_1' });
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/creditor-payments']}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_a">
            <TillClientProvider client={new TillClient(t.transport)}>
              <CapabilitiesContext.Provider value={caps([CAP.pay, CAP.post, CAP.manageMasterData])}>
                <Routes>
                  <Route path="/creditor-payments" element={<CreditorPayments />} />
                </Routes>
              </CapabilitiesContext.Provider>
            </TillClientProvider>
          </WorkspaceProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Rösterei Probe');
    await user.click(box(/Rösterei Probe/));
    expect(screen.getByText('Ausgewählter Betrag').parentElement).toHaveTextContent('CHF 107.02');
    await user.click(screen.getByRole('button', { name: 'IBAN hinterlegen' }));
    await user.type(screen.getByPlaceholderText('CH.. / QR-IBAN'), 'CH9300762011623852957');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByText('Rösterei Probe')).toBeNull());
    expectNothingChosen();
    expect(screen.getByText('Ausgewählter Betrag').parentElement).toHaveTextContent('CHF 0.00');
    expect(generateButton()).toBeDisabled();
  });
});

describe('CreditorPayments: a deep link', () => {
  it('?focus=<billId> marks that row current and ticks nothing', async () => {
    const t = recording();
    mount(t.transport, '/creditor-payments?focus=vb_later');
    await screen.findByText('Rösterei Probe');
    const row = screen.getByText('Rösterei Probe').closest('tr');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(document.querySelectorAll('tr[aria-current="true"]')).toHaveLength(1);
    for (const b of screen.getAllByRole('checkbox')) expect(b).not.toBeChecked();
    expect(generateButton()).toBeDisabled();
    expect(t.of('create_payment_batch')).toHaveLength(0);
  });
});

describe('CreditorPayments: the create key is one per act', () => {
  it('a retry of the same act reuses its key; a changed selection is a new act with a new key', async () => {
    const user = userEvent.setup();
    let fail = true;
    const t = recording(({ action }) =>
      action === 'create_payment_batch' && fail ? { status: 503, body: { ok: false, error: 'transport_error' } } : undefined,
    );
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByRole('alert');
    // The lost answer is retried as the SAME act: the engine replays a write that did land.
    await user.click(generateButton());
    await waitFor(() => expect(t.of('create_payment_batch')).toHaveLength(2));
    const [first, retry] = t.of('create_payment_batch');
    expect(retry.input.idempotencyKey).toBe(first.input.idempotencyKey);

    // A different selection is a different request: it never reuses the earlier act's key.
    await user.click(box(/Druckerei Probe/));
    fail = false;
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    const third = t.of('create_payment_batch')[2];
    expect(third.input.itemIds).toEqual(['vb_later', 'vb_latest']);
    expect(third.input.idempotencyKey).not.toBe(first.input.idempotencyKey);
  });
});

describe('CreditorPayments: a stale batch is never replayed', () => {
  /**
   * The engine's own replay, modelled: a create key that already wrote answers its first batch for
   * ever; a new key writes a new batch. `dead` holds the batches discarded elsewhere.
   */
  function engine(generateFor: (batchId: string, n: number) => RestResponse) {
    const byKey = new Map<string, string>();
    let generates = 0;
    return recording(({ action, input }) => {
      if (action === 'create_payment_batch') {
        const key = input.idempotencyKey as string;
        if (!byKey.has(key)) byKey.set(key, `pbatch_${byKey.size + 1}`);
        const batchId = byKey.get(key) as string;
        return ok({ batchId, batch: { ...BATCH_GENERATED, id: batchId, status: 'draft' } });
      }
      if (action === 'generate_pain001') {
        generates += 1;
        return generateFor(input.batchId as string, generates);
      }
      return undefined;
    });
  }
  const refused = (error: string, batchId: string): RestResponse => ({ status: 409, body: { ok: false, error, batchId } });

  it('create landed, generate failed, the draft was discarded elsewhere: the retry creates a FRESH run instead of replaying the dead one', async () => {
    const user = userEvent.setup();
    const dead = new Set<string>();
    const t = engine((batchId, n) => {
      if (n === 1) return { status: 503, body: { ok: false, error: 'transport_error' } };
      if (dead.has(batchId)) return refused('batch_discarded', batchId);
      return { ...GENERATED, body: { ...GENERATED.body, batchId, batch: { ...BATCH_GENERATED, id: batchId } } } as RestResponse;
    });
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByRole('alert');
    // Meanwhile an agent discards the draft run this act created.
    dead.add('pbatch_1');

    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    const creates = t.of('create_payment_batch');
    const generates = t.of('generate_pain001');
    // The retry first replays the act (same key, the same dead pbatch_1), sees it refused, and then
    // creates once more under a NEW key: the file is built from the fresh pbatch_2.
    expect(creates).toHaveLength(3);
    expect(creates[1].input.idempotencyKey).toBe(creates[0].input.idempotencyKey);
    expect(creates[2].input.idempotencyKey).not.toBe(creates[0].input.idempotencyKey);
    expect(creates[2].input.itemIds).toEqual(['vb_later']);
    expect(generates.map((g) => g.input.batchId)).toEqual(['pbatch_1', 'pbatch_1', 'pbatch_2']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a batch the engine no longer finds is treated the same way (not_found)', async () => {
    const user = userEvent.setup();
    const t = engine((batchId, n) =>
      n === 1
        ? refused('not_found', batchId)
        : ({ ...GENERATED, body: { ...GENERATED.body, batchId, batch: { ...BATCH_GENERATED, id: batchId } } } as RestResponse),
    );
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    expect(t.of('generate_pain001').map((g) => g.input.batchId)).toEqual(['pbatch_1', 'pbatch_2']);
  });

  it('re-creates at most once per click: a second dead batch is shown as the refusal, never looped on', async () => {
    const user = userEvent.setup();
    const t = engine((batchId) => refused('batch_discarded', batchId));
    mount(t.transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByRole('alert');
    expect(t.of('create_payment_batch')).toHaveLength(2);
    expect(t.of('generate_pain001')).toHaveLength(2);
    expect(screen.queryByText('Datei ist gültig')).toBeNull();
    // The refusal is said in words, with the way forward (a next click is a fresh run).
    expect(screen.getByRole('alert')).toHaveTextContent('Der Zahlungslauf wurde inzwischen verworfen.');
  });

  // Two mechanisms hold this: Mark-paid clears the ticks (the question changes, so the act ends) and
  // a completed act retires its key. The second is defence in depth; this case pins the outcome.
  it('the same question asked again after the run is paid is a new act with a new key', async () => {
    const user = userEvent.setup();
    const t = engine((batchId) => ({ ...GENERATED, body: { ...GENERATED.body, batchId, batch: { ...BATCH_GENERATED, id: batchId } } }) as RestResponse);
    const paid = recording(({ action, input }) =>
      action === 'mark_batch_paid'
        ? ok({ batchId: input.batchId, paymentIds: ['pay_1'], batch: { ...BATCH_GENERATED, id: input.batchId, status: 'paid' } })
        : undefined,
    );
    // Chain: mark_batch_paid from the second recorder, everything else from the engine model.
    const transport: Transport = async (action, input) => (action === 'mark_batch_paid' ? paid.transport(action, input) : t.transport(action, input));
    mount(transport);
    await screen.findByText('Stadtwerke Probe');
    await user.click(box(/Rösterei Probe/));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    await user.click(screen.getByRole('button', { name: 'Als bezahlt markieren' }));
    await user.click(screen.getByRole('checkbox', { name: /bestätige/ }));
    await user.click(screen.getByRole('button', { name: 'Bestätigen' }));
    await user.click(await screen.findByRole('button', { name: 'Neuer Zahlungslauf' }));
    // The model's list still answers the same bill (e.g. the payment was reversed): the same tick,
    // account and date is a NEW act, so it never replays the paid run.
    await user.click(await screen.findByRole('checkbox', { name: /Rösterei Probe/ }));
    await waitFor(() => expect(generateButton()).toBeEnabled());
    await user.click(generateButton());
    await screen.findByText('Datei ist gültig');
    const creates = t.of('create_payment_batch');
    expect(creates).toHaveLength(2);
    expect(creates[1].input.idempotencyKey).not.toBe(creates[0].input.idempotencyKey);
    expect(t.of('generate_pain001').map((g) => g.input.batchId)).toEqual(['pbatch_1', 'pbatch_2']);
  });
});

describe('CreditorPayments: reads in one mount, and the base currency (critic test gaps M10, M13)', () => {
  it('M10: an overtaken payable read in the SAME mount never paints over the newer answer', async () => {
    // StrictMode runs the mount effect twice, so two payable reads race in one workspace: the first
    // answers LAST with an older list. Only the newest read may paint.
    const first = deferred();
    let reads = 0;
    const t = recording(({ action }) => {
      if (action !== 'list_payable') return undefined;
      reads += 1;
      return reads === 1 ? first.promise : ok({ items: [LATER], total: 1, baseCurrency: 'CHF' });
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/creditor-payments']}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_a">
              <TillClientProvider client={new TillClient(t.transport)}>
                <CapabilitiesContext.Provider value={caps([CAP.pay, CAP.post])}>
                  <Routes>
                    <Route path="/creditor-payments" element={<CreditorPayments />} />
                  </Routes>
                </CapabilitiesContext.Provider>
              </TillClientProvider>
            </WorkspaceProvider>
          </I18nProvider>
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByText('Rösterei Probe');
    expect(reads).toBe(2);
    await act(async () => {
      first.resolve(ok({ items: [DUE], total: 1, baseCurrency: 'CHF' }));
    });
    expect(screen.queryByText('Stadtwerke Probe')).toBeNull();
    expect(screen.getByText('Rösterei Probe')).toBeTruthy();
  });

  it('M13: books kept in EUR default the debit account to the EUR account while nothing is ticked', async () => {
    const chfFirst = { ...ACCOUNT, id: 'ba_chf', name: 'Hauptkonto CHF', currency: 'CHF' };
    const eur = { ...ACCOUNT, id: 'ba_eur', name: 'Euro-Konto', currency: 'EUR' };
    const t = recording(({ action }) => {
      if (action === 'list_payable') return ok({ items: [{ ...LATER, currency: 'EUR' }], total: 1, baseCurrency: 'EUR' });
      if (action === 'list_bank_accounts') return ok({ bankAccounts: [chfFirst, eur] });
      return undefined;
    });
    mount(t.transport);
    await screen.findByText('Rösterei Probe');
    await waitFor(() => expect(screen.getByLabelText('Belastungskonto')).toHaveTextContent('Euro-Konto'));
    expectNothingChosen();
  });
});
