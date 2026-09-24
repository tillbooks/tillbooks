import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { ALLOW_ALL, CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import VatSettings from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import vatReturnDe from '../VatReturn/messages.de-CH.json';
import vatReturnEn from '../VatReturn/messages.en.json';

/**
 * A canned-response transport: each action maps to a fixed RestResponse or a function of its input.
 * Anything unmapped answers 404, mirroring the real bridge for an unknown action.
 */
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

const ok = (data: Record<string, unknown> = {}): RestResponse => ({
  status: 200,
  body: { ok: true, ...data },
});

const reject = (error: string, status = 422): RestResponse => ({
  status,
  body: { ok: false, error },
});

const SEEDED_CODES = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz 8.1%' },
  { code: 'UST26', kind: 'output', rateBp: 260, formLine: '313', label: 'Reduziert 2.6%' },
  { code: 'UST38', kind: 'output', rateBp: 380, formLine: '343', label: 'Beherbergung 3.8%' },
  { code: 'VST-M', kind: 'input', rateBp: 810, formLine: '400', label: 'Vorsteuer Material' },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, formLine: '383', label: 'Bezugsteuer' },
  { code: 'EXPORT0', kind: 'zero', rateBp: 0, formLine: '220', label: 'Export' },
  { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'Alt-Normalsatz 7.7%', active: false },
];

const effektivConfig = {
  method: 'effektiv',
  timing: 'soll',
  registered: true,
  vatNumber: 'CHE-123.456.789 MWST',
  saldoRates: [],
};

/**
 * The chart comes from the PINNED `list_accounts` recording, never from a literal typed here.
 *
 * `test/accounts/studio-list-accounts-fixture.test.mjs` exists because a hand-typed chart invents
 * ids (`acc_3200` for what the engine answers as `acc_28`), and the mapping assertions would then
 * agree with this file instead of with the chart.
 */
const ACCOUNTS = listAccountsFixture.accounts;

const idOf = (number: string) => {
  const row = ACCOUNTS.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recording carries no account ${number}`);
  return row.id;
};

const saldoConfig = {
  method: 'saldo',
  timing: 'ist',
  registered: true,
  saldoRates: [
    { position: 1, rateBp: 620, formLine: '323' },
    { position: 2, rateBp: 370, formLine: '333' },
  ],
  // F11. Without these the Tätigkeiten panel renders empty and every assertion about it is
  // satisfied by an absent surface.
  saldoActivities: [
    {
      activityId: 'restauration',
      name: 'Restauration',
      activityCode: null,
      position: 1,
      rateBp: 620,
      formLine: '323',
      accounts: [{ accountId: idOf('3200'), number: '3200', name: 'Erlöse aus Handelswaren' }],
    },
    {
      activityId: 'ablieferung',
      name: 'Ablieferung',
      activityCode: null,
      position: 2,
      rateBp: 370,
      formLine: '333',
      accounts: [{ accountId: idOf('3000'), number: '3000', name: 'Erlöse aus eigener Produktion' }],
    },
  ],
  saldoValidFrom: '2026-01-01',
  saldoDeclarationBasis: null,
  saldoDeclarationTaxPeriod: '2026',
};

/** One superseded approval and one open one, so the Bewilligungsverlauf has something to render. */
const SALDO_GENERATIONS = {
  generations: [
    {
      validFrom: '0001-01-01',
      validTo: '2025-12-31',
      createdAt: '2025-01-01T00:00:00.000Z',
      rates: [{ position: 1, rateBp: 530, formLine: '323' }],
      activities: [],
    },
    {
      validFrom: '2026-01-01',
      validTo: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      rates: saldoConfig.saldoRates,
      activities: saldoConfig.saldoActivities,
    },
  ],
  elections: [],
};

/** A register row's verb lives behind the row's one overflow (K-21): open it, then pick the item. */
async function chooseRowAction(code: string, item: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `Aktionen für Code ${code}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

/** The Saldosteuersätze editor's own section, for queries that must not reach the F11 panels. */
function saldoSection(): HTMLElement {
  const section = document.querySelector('.vat-saldo');
  if (section === null) throw new Error('the Saldosteuersätze section is not on screen');
  return section as HTMLElement;
}

function renderVat(canned: Canned, workspaceId: string | null = 'ws_test') {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {/* The no-workspace state links to /setup, so the surface needs a router in the tree. */}
          <MemoryRouter>
            <VatSettings />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

/**
 * THE FOUR READS THE SURFACE ACTUALLY MAKES, and why all four are now answered.
 *
 * `VatLoader` issues `vat_config`, `vat_codes`, `list_accounts` and `vat_saldo_generations` in one
 * `Promise.all`, and only the first is load-bearing: the other three degrade to empty rather than
 * blanking the panel. That degradation is correct behaviour and it was hiding this suite's own
 * blind spot. The canned transport answered `404 unknown_action` for anything it did not list, and
 * it listed neither `list_accounts` nor `vat_saldo_generations`, so the F11 panels rendered against
 * empty data and every test here stayed green whether the F11 surface worked or did not exist at
 * all. Feeding them real payloads is the difference between measuring the implementation and
 * assuming it. `noUnansweredReads` below is what stops the gap from reopening.
 */
/**
 * The measured-turnover sentence. Its figure is its own money span (t-money), so the sentence is
 * matched on the line's whole text rather than on one text node.
 */
const MEASURED_LINE = (_content: string, el: Element | null): boolean =>
  el?.classList.contains('vat-eligibility-figure') === true &&
  el.textContent === "Dein steuerbarer Umsatz 2025: CHF 312'400.00.";

/** The G17 eligibility read: measured, a real figure (never a fabricated zero). */
const ELIGIBILITY = ok({
  year: '2025',
  limits: { effectiveFrom: '2024-01-01', turnoverLimitMinor: 502_400_000, taxDueLimitMinor: 10_800_000 },
  measured: { turnoverMinor: 31_240_000, empty: false },
  unavailable: null,
});

const effektivCanned = (): Canned => ({
  vat_config: ok(effektivConfig),
  vat_codes: ok({ taxCodes: SEEDED_CODES }),
  list_accounts: ok({ accounts: ACCOUNTS }),
  vat_saldo_generations: ok({ generations: [], elections: [] }),
  vat_saldo_eligibility: ELIGIBILITY,
});

const saldoCanned = (): Canned => ({
  vat_config: ok(saldoConfig),
  vat_codes: ok({ taxCodes: SEEDED_CODES }),
  list_accounts: ok({ accounts: ACCOUNTS }),
  vat_saldo_generations: ok(SALDO_GENERATIONS),
  vat_saldo_eligibility: ELIGIBILITY,
});

/** The three fixtures of the election read model (G17 §8b): they MUST decode to three states. */
const UNDECIDED_CONFIG = ok({ timing: 'soll', registered: false, saldoRates: [] });
const NOT_LIABLE_CONFIG = ok({ method: 'none', timing: 'soll', registered: false, saldoRates: [] });

describe('VatSettings, five states', () => {
  it('shows a loading skeleton while the config resolves', async () => {
    const transport = watchReads(neverSettles);
    const client = new TillClient(transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <VatSettings />
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The skeleton is the surface's first commit, so it proves nothing on its own: wait for the
    // config read to be genuinely in flight before calling this a loading state.
    await transport.started('vat_config');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the no-workspace state with a way out, and calls no ctx verb', async () => {
    const configSpy = vi.fn<CannedHandler>(() => ok(effektivConfig));
    renderVat({ vat_config: configSpy, vat_codes: ok({ taxCodes: [] }) }, null);
    expect(
      await screen.findByText('Richte zuerst einen Arbeitsbereich ein, um die MWST zu konfigurieren.'),
    ).toBeInTheDocument();
    // Not a wall: the state carries the link that fixes the reason it is showing.
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    expect(configSpy).not.toHaveBeenCalled();
  });

  it('renders the explainer block as the empty state IFF the election is UNDECIDED, with BOTH answers (G17 §8b)', async () => {
    renderVat({
      vat_config: UNDECIDED_CONFIG,
      vat_codes: ok({ taxCodes: [] }),
    });
    expect(
      await screen.findByText('MWST ist für diesen Arbeitsbereich noch nicht aktiviert.'),
    ).toBeInTheDocument();
    // Both answers the election has, including the negative one (row 3.6).
    expect(screen.getByRole('button', { name: 'MWST aktivieren' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nicht MWST-pflichtig' })).toBeInTheDocument();
    // The block marks its three concepts, at the cap: real buttons, never hover reveals.
    expect(screen.getByRole('button', { name: 'Begriff Saldosteuersatz' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Begriff Vereinbarte Entgelte (Soll)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Begriff Vereinnahmte Entgelte (Ist)' })).toBeInTheDocument();
    // The definition layer is behind a gesture: no concept BODY string in the initial DOM (row 8.1).
    expect(screen.queryByText(/Saldosteuersatzmethode rechnest du die MWST/)).not.toBeInTheDocument();
  });

  it('a marked term opens the concept panel over the same surface; Esc returns focus to the term (rows 1.1)', async () => {
    renderVat({ vat_config: UNDECIDED_CONFIG, vat_codes: ok({ taxCodes: [] }) });
    const term = await screen.findByRole('button', { name: 'Begriff Saldosteuersatz' });
    await userEvent.click(term);
    const dialog = await screen.findByRole('dialog', { name: 'Saldosteuersatz' });
    expect(dialog).toHaveTextContent(/Saldosteuersatzmethode/);
    // Structured citations, in the panel, never inline in the body.
    expect(within(dialog).getByRole('list', { name: 'Rechtsgrundlagen' })).toHaveTextContent('MWSTG Art. 37');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(term).toHaveFocus();
  });

  it('renders the DECIDED negative state (nicht MWST-pflichtig): no explainer, no nag, reversible in place', async () => {
    renderVat({ vat_config: NOT_LIABLE_CONFIG, vat_codes: ok({ taxCodes: [] }) });
    expect(await screen.findByText('Dieser Arbeitsbereich rechnet keine MWST ab.')).toBeInTheDocument();
    // The explainer block emits nothing: the decision exists (row 3.2).
    expect(screen.queryByText('MWST ist für diesen Arbeitsbereich noch nicht aktiviert.')).not.toBeInTheDocument();
    // Reversible from the same surface (row 3.6): MWST aktivieren stays visible.
    expect(screen.getByRole('button', { name: 'MWST aktivieren' })).toBeInTheDocument();
  });

  it('guidance copy is BYTE-IDENTICAL across roles once the action slot is stripped (rows 1.4/8.2, critic F13)', async () => {
    // The DoD phrase is "byte-identical strings", so the assertion compares the RENDERED SUBTREE,
    // not two hand-picked strings: a role-branched consequence line or binding-facts line anywhere
    // on the surface would fail this, which is exactly what the two-string version could not see.
    const viewer: Capabilities = {
      whoami: { actor: 'v', provisioned: true, isMember: true, memberId: 'm', userId: 'u', role: 'viewer', capabilities: [] },
      can: () => false,
      refresh: () => undefined,
    };
    const renderedTextAs = async (caps: Capabilities): Promise<{ text: string; hadActions: boolean }> => {
      const client = new TillClient(fakeTransport({ vat_config: UNDECIDED_CONFIG, vat_codes: ok({ taxCodes: [] }) }));
      const view = render(
        <TillClientProvider client={client}>
          <I18nProvider>
            <WorkspaceProvider initialId="ws_test">
              <CapabilitiesContext.Provider value={caps}>
                <MemoryRouter>
                  <VatSettings />
                </MemoryRouter>
              </CapabilitiesContext.Provider>
            </WorkspaceProvider>
          </I18nProvider>
        </TillClientProvider>,
      );
      await within(view.container).findByText('MWST ist für diesen Arbeitsbereich noch nicht aktiviert.');
      const actions = view.container.querySelectorAll('.vat-explainer-actions');
      const hadActions = actions.length > 0;
      for (const slot of actions) slot.remove();
      const text = view.container.textContent ?? '';
      view.unmount();
      return { text, hadActions };
    };

    const asViewer = await renderedTextAs(viewer);
    const asOwner = await renderedTextAs(ALLOW_ALL);
    // Identical words, different rights: the action slot is the ONE permitted difference.
    expect(asViewer.hadActions).toBe(false);
    expect(asOwner.hadActions).toBe(true);
    expect(asViewer.text.length).toBeGreaterThan(0);
    expect(asOwner.text).toBe(asViewer.text);
  });

  it('answers the election negatively: Nicht MWST-pflichtig posts method none, registered false', async () => {
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({
      vat_config: UNDECIDED_CONFIG,
      vat_codes: ok({ taxCodes: [] }),
      vat_configure: configureSpy,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nicht MWST-pflichtig' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());
    expect(configureSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      method: 'none',
      timing: 'soll',
      registered: false,
    });
  });

  it('renders an error banner when vat_config rejects', async () => {
    renderVat({ vat_config: reject('invalid_input'), vat_codes: ok({ taxCodes: [] }) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a permission-denied padlock on permission_denied', async () => {
    renderVat({ vat_config: reject('permission_denied', 403), vat_codes: ok({ taxCodes: [] }) });
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff' })).toBeInTheDocument();
    // The write controls are hidden, not shown-then-rejected.
    expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument();
  });

  it('renders the configured success face with the method/timing badge', async () => {
    renderVat(effektivCanned());
    expect(await screen.findByText('Methode: Effektiv')).toBeInTheDocument();
    expect(screen.getByText('Abrechnungsart: Soll (vereinbart)')).toBeInTheDocument();
  });

  it('has no axe violations on the configured success render', async () => {
    const { container } = renderVat(effektivCanned());
    await screen.findByText('Methode: Effektiv');
    // Audit the SETTLED render: the eligibility read resolves after mount, and axe on a
    // mid-transition DOM is the same nondeterminism the ask-set race had.
    await screen.findByText(MEASURED_LINE);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('VatSettings, Enable MWST', () => {
  it('configures and seeds on Enable', async () => {
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    const seedSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({
      vat_config: UNDECIDED_CONFIG,
      vat_codes: ok({ taxCodes: [] }),
      vat_configure: configureSpy,
      vat_seed_defaults: seedSpy,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'MWST aktivieren' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());
    expect(configureSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', registered: true });
    await waitFor(() => expect(seedSpy).toHaveBeenCalledOnce());
  });
});

describe('VatSettings, method switch effektiv <-> saldo', () => {
  it('reveals the saldo editor only under method=saldo', async () => {
    renderVat(effektivCanned());
    await screen.findByText('Methode: Effektiv');
    // Effektiv: no saldo editor, but the tax-code register is shown.
    expect(screen.queryByRole('heading', { name: 'Saldosteuersätze' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Steuercodes' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Saldosteuersatz' }));
    expect(await screen.findByRole('heading', { name: 'Saldosteuersätze' })).toBeInTheDocument();
    // Switching to saldo hides the effektiv-only tax-code register.
    expect(screen.queryByRole('heading', { name: 'Steuercodes' })).not.toBeInTheDocument();
  });

  it('shows every existing saldo row on the SAME ESTV Ziffer, because the form has one', async () => {
    renderVat(saldoCanned());
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    // Scoped to the Saldosteuersätze section, which it was not before. Once the transport answers
    // `vat_saldo_generations` the Tätigkeiten panel renders its own Ziffern too, so the unscoped
    // query matched several nodes.
    const editor = within(saldoSection());
    // Both rates declare on 323. From 01.01.2025 the ESTV form's Steuerberechnung block has one Saldo
    // row per rate ERA and none per rate POSITION, and the split across the approved rates is carried
    // in the Beiblatt to Ziffern 322/323 (MWST-Info 12 Ziff. 18.1.4, A07 §3.1a).
    expect(editor.getAllByText('Ziffer 323')).toHaveLength(2);
    expect(editor.queryByText('Ziffer 333')).toBeNull();
    // Each rate picker carries its position aria-label.
    expect(screen.getByRole('combobox', { name: 'Saldosteuersatz 1' })).toHaveTextContent('6.2%');
    expect(screen.getByRole('combobox', { name: 'Saldosteuersatz 2' })).toHaveTextContent('3.7%');
  });
});

describe('VatSettings, N-rate saldo editing', () => {
  it('adds a 3rd rate that declares on Ziffer 323 like the others, with no special case', async () => {
    renderVat(saldoCanned());
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    await userEvent.click(screen.getByRole('button', { name: 'Satz hinzufügen' }));
    const third = await screen.findByLabelText('Saldosteuersatz 3');
    expect(third).toBeInTheDocument();

    // A 3rd rate used to show "Keine feste Ziffer", because the pre-2025 form stopped at two rows.
    // It no longer does: MWSTV Art. 87 was repealed with effect 01.01.2025 and the Beiblatt splits
    // the Entgelt across "die verschiedenen SSS", so the third rate is as ordinary as the first.
    const editor = within(saldoSection());
    expect(editor.getAllByText('Ziffer 323')).toHaveLength(3);
    expect(screen.queryByText(/Keine feste Ziffer/)).toBeNull();
  });

  it('removes a saldo row', async () => {
    renderVat(saldoCanned());
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    await userEvent.click(screen.getByRole('button', { name: 'Satz 2 entfernen' }));
    await waitFor(() => expect(screen.queryByLabelText('Saldosteuersatz 2')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Saldosteuersatz 1')).toBeInTheDocument();
  });

  it('blocks a duplicate rate client-side and disables Save', async () => {
    // Rendered with NO Tätigkeit mapped, which is the shape this test has always had and the claim
    // it has always made: the rate editor flags the duplicate and Save goes disabled. The separate
    // test below covers what happens to the Tätigkeiten panel in the same state, and it is red.
    renderVat({ ...saldoCanned(), vat_config: ok({ ...saldoConfig, saldoActivities: [] }) });
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    // Set rate 2 to the same value as rate 1 (620) -> duplicate.
    await userEvent.click(screen.getByRole('combobox', { name: 'Saldosteuersatz 2' }));
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Saldosteuersatz 2' })).getByRole('option', { name: '6.2%' }));
    expect(await screen.findByText('Dieser Satz ist bereits erfasst.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it("a duplicate rate must not collide the Tätigkeit picker's option keys", async () => {
    /*
     * FAILING ON PURPOSE, AND IT NAMES A REAL DEFECT IN THE SURFACE.
     *
     * `VatConfigured` passes `chosenRates` to `ActivityEditor` as `approvedRates`, and
     * `chosenRates` is `rates.filter((r) => r > 0)` with no de-duplication (VatSettings.tsx:386,
     * :543). `ActivityEditor` then renders one `<option key={bp}>` per approved rate inside EVERY
     * Tätigkeit's rate picker (:845). So the moment an operator sets two Saldosteuersätze to the
     * same value, which the surface itself expects, flags inline and blocks with a disabled Save,
     * React gets two children with key `620` and logs "the behavior is unsupported".
     *
     * Two consequences, and the second is the one that matters on a tax form. The picker offers
     * "6.2%" twice with nothing to tell the two apart, and `saldoZifferForPosition(
     * approvedRates.indexOf(a.rateBp) + 1)` at :826 resolves BOTH duplicates to the FIRST
     * position, so a Tätigkeit sitting on the second 6.2% row renders Ziffer 323 where the row
     * itself is flagged as position 2. The Ziffer is what the turnover is declared under.
     *
     * The fix belongs in `VatSettings.tsx`, which this wave's testing pass does not own: pass
     * DISTINCT chosen rates to `ActivityEditor` (a `[...new Set(chosenRates)]` at the call site),
     * which repairs the key collision and the `indexOf` ambiguity in one move. Keying the option
     * by index alone would silence React and leave the wrong Ziffer.
     */
    renderVat(saldoCanned());
    await screen.findByText('Tätigkeiten');
    await userEvent.click(screen.getByRole('combobox', { name: 'Saldosteuersatz 2' }));
    await userEvent.click(within(screen.getByRole('listbox', { name: 'Saldosteuersatz 2' })).getByRole('option', { name: '6.2%' }));
    expect(await screen.findByText('Dieser Satz ist bereits erfasst.')).toBeInTheDocument();
    // The console guard in `src/test-console.ts` is what fails this test: React's duplicate-key
    // error is emitted during the render above. The assertion below is the human-readable half.
    //
    // Scoped to ONE Tätigkeit row's picker. The first draft counted every `<option>` in the
    // Saldosteuersätze section and found 22 against 11 distinct, which is just the ESTV ladder
    // rendered once per rate row and says nothing at all. Check the probe before reading a number
    // as the defect. The rate picker is the shared <Select> now, so its options paint only once open
    // and portal to <body>: open THIS row's combobox and read the offered rates by data-value.
    const row = document.querySelector('.vat-activity-row');
    expect(row).not.toBeNull();
    const picker = within(row as HTMLElement).getByRole('combobox');
    await userEvent.click(picker);
    const offered = screen
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-value'))
      .filter((v) => v !== null && v !== '');
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('sends the ordered saldo rates to vat_configure on save', async () => {
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...saldoCanned(), vat_configure: configureSpy });
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());
    expect(configureSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      method: 'saldo',
      timing: 'ist',
      saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
    });
  });

  it('surfaces the engine invalid_saldo_rate inline', async () => {
    renderVat({ ...saldoCanned(), vat_configure: reject('invalid_saldo_rate') });
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Satz nicht auf der aktuellen ESTV-Liste.')).toBeInTheDocument();
  });
});

describe('VatSettings, the canned transport answers what the surface asks', () => {
  it('answers all four reads, so no panel can render empty and pass by accident', async () => {
    /*
     * THE GUARD OVER THIS FILE'S OWN BLIND SPOT, and the reason it is a test rather than a comment.
     *
     * `fakeTransport` answers `404 unknown_action` for any verb it does not list, and `VatLoader`
     * degrades three of its four reads to empty rather than blanking the surface. Those two correct
     * behaviours combined into one silent failure: this suite listed only `vat_config` and
     * `vat_codes`, so the F11 Tätigkeiten panel and the Bewilligungsverlauf rendered against empty
     * data and all 22 tests stayed green whether the F11 surface worked or did not exist at all.
     *
     * A suite that cannot fail is worse than no suite, because it is counted. This test watches the
     * calls the surface really makes and fails when the fixture does not answer one, which is the
     * only version of this that survives the next verb being added to the loader.
     */
    const asked: string[] = [];
    const canned = saldoCanned();
    const transport: Transport = async (action, input) => {
      asked.push(action);
      const entry = canned[action];
      if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof entry === 'function' ? entry(input) : entry;
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <VatSettings />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    // DETERMINISM (the landing-gate race): the heading proves only the Promise.all loader settled.
    // `vat_saldo_eligibility` is fired by SaldoEligibility's own mount effect, so under parallel
    // load the ask-set assertion could run before that fifth read went out (expected 5, saw 4,
    // green isolated, red in the full studio suite). Await the DOM evidence that the read
    // COMPLETED, the measured-figure line the ELIGIBILITY fixture produces, before reading `asked`.
    await screen.findByText(MEASURED_LINE);

    expect([...asked].sort()).toEqual([
      'list_accounts',
      'vat_codes',
      'vat_config',
      'vat_saldo_eligibility',
      'vat_saldo_generations',
    ]);
    const unanswered = asked.filter((action) => canned[action] === undefined);
    expect(unanswered).toEqual([]);
  });
});

describe('VatSettings, the F11 panels, measured rather than assumed', () => {
  it('renders each Tätigkeit with its rate, its Ziffer and its mapped Ertragskonto', async () => {
    renderVat(saldoCanned());
    await screen.findByText('Tätigkeiten');

    expect(screen.getByLabelText('Name der Tätigkeit 1')).toHaveValue('Restauration');
    expect(screen.getByLabelText('Name der Tätigkeit 2')).toHaveValue('Ablieferung');

    // Exactly one Ertragskonto is CHECKED per Tätigkeit, and it is the one the config mapped.
    const rows = [...document.querySelectorAll('.vat-activity-row')];
    expect(rows).toHaveLength(2);
    // Read off the LABEL text, not off `input.value`. The checkbox carries no value attribute (the
    // surface keys the label by `accountId` and toggles by number), so a first draft asserting on
    // `.value` compared against jsdom's default `'on'` and failed against correct code.
    const checkedIn = (row: Element) =>
      [...row.querySelectorAll('label.vat-account')]
        .filter((l) => (l.querySelector('input[type=checkbox]') as HTMLInputElement).checked)
        .map((l) => l.textContent);
    expect(checkedIn(rows[0] as Element)).toEqual(['3200 Erlöse aus Handelswaren']);
    expect(checkedIn(rows[1] as Element)).toEqual(['3000 Erlöse aus eigener Produktion']);

    // Only INCOME accounts are offered: turnover is never booked on an expense account, so mapping
    // one to a Tätigkeit could only ever mislead. Derived from the recording, not restated.
    const income = ACCOUNTS.filter((a) => a.type === 'income' && !a.archived);
    expect(income.length).toBeGreaterThan(1);
    for (const a of income) expect(screen.getAllByText(`${a.number} ${a.name}`)).toHaveLength(rows.length);
    const expense = ACCOUNTS.find((a) => a.type === 'expense');
    expect(expense).toBeTruthy();
    expect(screen.queryByText(`${expense?.number} ${expense?.name}`)).toBeNull();
  });

  it('renders the Bewilligungsverlauf with the superseded approval closed and its rate intact', async () => {
    // Under Saldo no rate is stamped on a journal line, so this list is the only thing on any screen
    // that says what a filed period was computed with. An empty render is not a thinner panel here,
    // it is the evidence gone.
    renderVat(saldoCanned());
    await screen.findByText('Bewilligungsverlauf');
    expect(screen.getByText('Ab 01.01.2026, laufend')).toBeInTheDocument();
    expect(screen.getByText('01.01.0001 bis 31.12.2025')).toBeInTheDocument();
    // The rate, without a Ziffer: see A07 §3.1a. What this panel has to preserve is WHICH RATE a
    // filed period was computed with, and that is exactly what is asserted.
    // SCOPED to the history panel: '5.3%' is also an <option> in every rate picker.
    const rates = [...document.querySelectorAll('.vat-history-rates')].map((n) => n.textContent);
    expect(rates).toContain('5.3%');
  });

  it('does not render the Bewilligungsverlauf when the engine reports no approval', async () => {
    // The falsifiability half. Without this, the assertion above passes for a panel that renders its
    // heading unconditionally, which is exactly the shape the empty-fixture bug had.
    renderVat({ ...saldoCanned(), vat_saldo_generations: ok({ generations: [], elections: [] }) });
    await screen.findByRole('heading', { name: 'Saldosteuersätze' });
    expect(screen.queryByText('Bewilligungsverlauf')).toBeNull();
    expect(document.querySelectorAll('.vat-history-rates')).toHaveLength(0);
  });

  it('sends the elected Art. 88 Abs. 6 basis for the Steuerperiode', async () => {
    const electSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...saldoCanned(), vat_saldo_declaration_basis: electSpy });
    await screen.findByText('Abrechnungsart der Steuerperiode 2026');
    await userEvent.click(screen.getByLabelText('Gesamter Umsatz zum höchsten Satz (Art. 88 Abs. 6)'));
    await waitFor(() => expect(electSpy).toHaveBeenCalledOnce());
    expect(electSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      taxPeriod: '2026',
      basis: 'highest_rate',
    });
  });

  it('sends the Tätigkeit mapping on an ordinary save, by account NUMBER', async () => {
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...saldoCanned(), vat_configure: configureSpy });
    await screen.findByText('Tätigkeiten');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());
    expect(configureSpy.mock.calls[0][0]).toMatchObject({
      saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
      saldoActivities: [
        { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
        { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
      ],
    });
  });

  it('has no axe violations on the saldo render, where the F11 panels live', async () => {
    // The effektiv render is already audited above. Every control F11 added is on the SALDO render
    // and none of it was ever reached by that audit.
    const { container } = renderVat(saldoCanned());
    await screen.findByText('Bewilligungsverlauf');
    // Audit the SETTLED render (same reason as the effektiv audit above).
    await screen.findByText(MEASURED_LINE);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('VatSettings, save confirmation (D33 defect 1)', () => {
  it('shows and KEEPS the "Gespeichert" confirmation after a config save, with no skeleton flash', async () => {
    // LOADING-PROOF-EXEMPT: A success-path test that names the skeleton only to assert its ABSENCE
    // after a save. It reads the saved config before it asserts, so a surface that never read would
    // fail earlier.
    //
    // The read still answers the ORIGINAL config (timing: soll). Under the old behaviour the save
    // ran a full surface reload that flipped to the skeleton and remounted the panel: the edited Ist
    // timing reverted and the just-set "Gespeichert" line was unmounted the instant it rendered.
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_configure: configureSpy });
    await screen.findByText('Methode: Effektiv');

    // Edit the config, then save.
    await userEvent.click(screen.getByRole('radio', { name: 'Ist (vereinnahmt)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());

    // The confirmation is actually observable.
    expect(await screen.findByText('Gespeichert')).toBeInTheDocument();

    // It SURVIVES: no reload, so a tick later the line is still there, no loading skeleton has
    // appeared (nothing carries aria-busy), and the edited Ist timing is kept rather than reverted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('Gespeichert')).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Ist (vereinnahmt)' })).toBeChecked();
  });

  it('does NOT re-read the surface on a config save (the panel stays mounted)', async () => {
    const configSpy = vi.fn<CannedHandler>(() => ok(effektivConfig));
    const configureSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({
      vat_config: configSpy,
      vat_codes: ok({ taxCodes: SEEDED_CODES }),
      vat_configure: configureSpy,
    });
    await screen.findByText('Methode: Effektiv');
    expect(configSpy).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(configureSpy).toHaveBeenCalledOnce());

    // The config read is NOT fired a second time: the save persists via vat_configure and the panel
    // keeps its own state, exactly like the Setup surface's per-panel saved line.
    expect(configSpy).toHaveBeenCalledTimes(1);
  });
});

describe('VatSettings, vat number', () => {
  it('surfaces invalid_vat_number inline on the UID field', async () => {
    renderVat({ ...effektivCanned(), vat_configure: reject('invalid_vat_number') });
    await screen.findByText('Methode: Effektiv');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Format muss CHE-###.###.### MWST sein.')).toBeInTheDocument();
  });
});

describe('VatSettings, tax-code register', () => {
  it('lists each code with its ESTV Ziffer and status', async () => {
    renderVat(effektivCanned());
    await screen.findByRole('heading', { name: 'Steuercodes' });
    const ust81Row = screen.getByText('UST81').closest('tr') as HTMLElement;
    expect(within(ust81Row).getByText('303')).toBeInTheDocument();
    expect(within(ust81Row).getByText('Umsatzsteuer')).toBeInTheDocument();
    expect(within(ust81Row).getByText('8.1%')).toBeInTheDocument();
    expect(within(ust81Row).getByText('aktiv')).toBeInTheDocument();
    // The archived legacy code coexists, marked archived, with a Reactivate control (never an
    // Archive one: it is already archived).
    const ust77Row = screen.getByText('UST77').closest('tr') as HTMLElement;
    expect(within(ust77Row).getByText('archiviert')).toBeInTheDocument();
    await userEvent.click(within(ust77Row).getByRole('button', { name: 'Aktionen für Code UST77' }));
    expect(screen.getByRole('menuitem', { name: 'Reaktivieren' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Archivieren' })).not.toBeInTheDocument();
  });

  it('seeds default codes from the empty register', async () => {
    const seedSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({
      vat_config: ok(effektivConfig),
      vat_codes: ok({ taxCodes: [] }),
      vat_seed_defaults: seedSpy,
    });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Standardcodes anlegen' }));
    await waitFor(() => expect(seedSpy).toHaveBeenCalledOnce());
    expect(seedSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test' });
  });

  it('archives an active code via vat_code_deactivate after a confirm (never deletes)', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_deactivate: archiveSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    // The row button only opens the confirm; the write happens on the dialog's confirm action.
    await chooseRowAction('UST81', 'Archivieren');
    const dialog = await screen.findByRole('alertdialog');
    expect(archiveSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archivieren' }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledOnce());
    expect(archiveSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', code: 'UST81' });
  });

  it('cancelling the archive confirm writes nothing', async () => {
    const archiveSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_deactivate: archiveSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await chooseRowAction('UST81', 'Archivieren');
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('reactivates an archived code via vat_code_reactivate with no confirm (the restorative mirror)', async () => {
    const reactivateSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_reactivate: reactivateSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    // Reactivating is the safe direction: it writes straight away, no alertdialog.
    await chooseRowAction('UST77', 'Reaktivieren');
    await waitFor(() => expect(reactivateSpy).toHaveBeenCalledOnce());
    expect(reactivateSpy.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws_test', code: 'UST77' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('upserts a new code via vat_code_upsert', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Code'), 'UST81-NEW');
    await userEvent.type(screen.getByLabelText('Satz (Basispunkte)'), '810');
    await userEvent.type(screen.getByLabelText('Ziffer'), '303');
    // The add form's own Save (the second Speichern on the page) submits the upsert.
    const forms = screen.getAllByRole('button', { name: 'Speichern' });
    await userEvent.click(forms[forms.length - 1]);
    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      code: 'UST81-NEW',
      kind: 'output',
      rateBp: 810,
      formLine: '303',
    });
  });
});

/**
 * K-58 (kaizen round 3): the Add-tax-code Rate field stores BASIS POINTS (810 = 8.1%), not percent.
 * Labelled only 'Satz' with '810' as the sole cue, a user meaning 8% typed the integer 8, which the
 * server accepts and stores as 8 basis points (0.1%): a silently wrong VAT code. The fix makes the
 * unit explicit ('Satz (Basispunkte)' + a persistent '810 = 8.1%' hint) and mirrors the server check
 * (integer 0..10000) client-side with a unit-aware inline error that blocks submit. The rateBp wire
 * contract is unchanged: 810 still sends 810.
 */
describe('K-58: the tax-code Rate field is unit-explicit and range-checked client-side', () => {
  /** The add form's own Save is the LAST Speichern button on the page. */
  function addFormSave(): HTMLElement {
    const saves = screen.getAllByRole('button', { name: 'Speichern' });
    return saves[saves.length - 1];
  }

  it('shows the basis-point unit hint whenever the add form is open', async () => {
    renderVat(effektivCanned());
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    // The label itself is unit-explicit, and the persistent hint names the conversion.
    expect(screen.getByLabelText('Satz (Basispunkte)')).toBeInTheDocument();
    expect(screen.getByText('810 = 8.1%')).toBeInTheDocument();
  });

  it('blocks a non-integer (8.1) with a unit-aware inline error and sends no upsert', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Code'), 'UST81-NEW');
    await userEvent.type(screen.getByLabelText('Satz (Basispunkte)'), '8.1');

    const err = screen.getByText('Bitte Basispunkte als ganze Zahl 0..10000 eingeben (810 = 8.1%).');
    expect(err).toBeInTheDocument();
    // The error is programmatically associated, not title-only.
    const rate = screen.getByLabelText('Satz (Basispunkte)');
    expect(rate).toHaveAttribute('aria-invalid', 'true');
    expect(rate.getAttribute('aria-describedby')).toContain(err.id);

    expect(addFormSave()).toBeDisabled();
    await userEvent.click(addFormSave());
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('blocks an out-of-range integer (10001) the same way', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Satz (Basispunkte)'), '10001');
    expect(
      screen.getByText('Bitte Basispunkte als ganze Zahl 0..10000 eingeben (810 = 8.1%).'),
    ).toBeInTheDocument();
    expect(addFormSave()).toBeDisabled();
    await userEvent.click(addFormSave());
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid integer (8) with no error, hint still present', async () => {
    renderVat(effektivCanned());
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Satz (Basispunkte)'), '8');
    // 8 is a valid integer basis-point value, so no error, but the unit hint stays on screen so the
    // user can see 8 means 8 basis points (0.1%), not 8%.
    expect(
      screen.queryByText('Bitte Basispunkte als ganze Zahl 0..10000 eingeben (810 = 8.1%).'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('810 = 8.1%')).toBeInTheDocument();
    expect(addFormSave()).not.toBeDisabled();
  });

  it('sends rateBp unchanged (810 stays 810) when valid: the wire contract is preserved', async () => {
    const upsertSpy = vi.fn<CannedHandler>(() => ok());
    renderVat({ ...effektivCanned(), vat_code_upsert: upsertSpy });
    await screen.findByRole('heading', { name: 'Steuercodes' });
    await userEvent.click(screen.getByRole('button', { name: 'Code hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Code'), 'UST81-NEW');
    await userEvent.type(screen.getByLabelText('Satz (Basispunkte)'), '810');
    await userEvent.type(screen.getByLabelText('Ziffer'), '303');
    await userEvent.click(addFormSave());
    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce());
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ rateBp: 810 });
  });
});

/**
 * K-17 (kaizen round 1): `vat.return.istNotImplemented` is ONE key with THREE render sites (the
 * standing banner on an Ist workspace, the election-time line under the Ist option on a NON-Ist
 * workspace, and A07's refusal in VatReturn). The old wording opened with a present-tense claim
 * about the workspace ("Dieser Arbeitsbereich rechnet nach vereinnahmten Entgelten (Ist) ab."),
 * true at the banner and FALSE at the election, so a Soll workspace was told it files on Ist. G17
 * mandates the single key, so the fix is a STATE-NEUTRAL rewording, not a split: the key now leads
 * with the product limitation and never asserts what the workspace currently does. The third
 * render site keeps its own assertion in VatReturn.test.tsx ("lieber keine Zahlen als falsche").
 */
describe('K-17: the shared IST limitation key is true at every render site', () => {
  it('makes no present-tense claim about the workspace timing, in either locale', () => {
    const de = (vatReturnDe as { vat: { return: { istNotImplemented: string } } }).vat.return.istNotImplemented;
    const en = (vatReturnEn as { vat: { return: { istNotImplemented: string } } }).vat.return.istNotImplemented;
    // The removed openers: a sentence that states what THIS workspace does is wrong at one site.
    expect(de).not.toMatch(/Dieser Arbeitsbereich rechnet/);
    expect(en).not.toMatch(/This workspace files/);
    // The limitation leads, state-neutral: TILL's own capability, not the workspace's election.
    expect(de).toMatch(/^TILL rechnet/);
    expect(en).toMatch(/^TILL currently calculates/);
  });

  it('renders as the standing banner on an Ist workspace (config.timing === ist)', async () => {
    renderVat(saldoCanned());
    expect(await screen.findByText(/nur nach vereinbarten Entgelten \(Soll\)/)).toBeInTheDocument();
  });

  it('renders at election time under the Ist option on a Soll workspace', async () => {
    renderVat(effektivCanned());
    expect(await screen.findByText(/nur nach vereinbarten Entgelten \(Soll\)/)).toBeInTheDocument();
  });
});
