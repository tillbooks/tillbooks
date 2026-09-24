/**
 * A15, Mahnwesen: the app-level suite, every GUI state.
 *
 * The canned payloads mirror the engine's real shapes, exercised end to end by
 * `test/dunning/dunning.test.mjs`; the option reads (accounts, tax codes, saved views) are OTHER
 * capabilities' verbs, canned by hand and asserted through the filtering this surface performs on
 * them, which is the part A15 owns. The LOADING test proves its read with `transport.started(...)`
 * per `app/src/loading-state-convention.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import Dunning from './index';

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

const LEVELS = [1, 2, 3].map((level) => ({
  level,
  daysOverdue: level * 10,
  minIntervalDays: 10,
  feeMinor: 0,
  bookFee: false,
  feeIncomeAccountId: null,
  taxCode: null,
  showInterest: false,
  interestBp: 500,
  templateKey: 'standard',
}));

const CONFIG = ok({ levels: LEVELS, configured: false, interestFloorBp: 500 });

const ITEM = {
  documentId: 'doc_1',
  debtorId: 'c_1',
  debtorName: 'Säumig AG',
  number: 'R-2026-0001',
  level: 1,
  currency: 'CHF',
  overdueMinor: 108100,
  feeMinor: 2000,
  // The engine's truth for a PROPOSED run: the fee books at issue, so it is not booked yet, and
  // D73's demand has not been frozen yet either. Both flip together on an ordinary issue.
  feeBooked: false,
  demandedFeeMinor: 0,
  interestMinor: 676,
  daysOverdue: 45,
  dueDate: '2026-06-01',
  sentAt: null,
  sendError: null,
};

const GROUP = {
  debtorId: 'c_1',
  debtorName: 'Säumig AG',
  itemCount: 1,
  maxLevel: 1,
  totalsByCurrency: { CHF: 110100 },
  sent: false,
  sendError: null,
};

function runSummary(status: string, extra: Record<string, unknown> = {}) {
  return {
    runId: 'run_1',
    runDate: '2026-07-16',
    status,
    itemCount: 1,
    debtorCount: 1,
    maxLevel: 1,
    feeEntryId: null,
    feeSkippedReason: null,
    issuedAt: null,
    sentAt: null,
    ...extra,
  };
}

function runDetail(status: string, extra: Record<string, unknown> = {}) {
  return {
    runId: 'run_1',
    runDate: '2026-07-16',
    status,
    feeEntryId: null,
    feeSkippedReason: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    issuedAt: null,
    sentAt: null,
    items: [ITEM],
    debtors: [GROUP],
    ...extra,
  };
}

/**
 * The option reads. `list_accounts` is the PINNED recording of the whole shipped Kontenrahmen
 * (`test/accounts/studio-list-accounts-fixture.test.mjs` holds it to the live engine), which is
 * exactly what the income-only filter has to be judged against: it carries income rows AND asset
 * rows under their real seed names. The tax codes are canned by hand (an A05 shape asserted through
 * this surface's own output-only filtering).
 */
const OPTION_READS: Canned = {
  list_saved_views: ok({ entityKind: 'dunning_run', savedViews: [] }),
  list_accounts: ok(accountsFixture),
  vat_codes: ok({
    taxCodes: [
      { code: 'UST81', kind: 'output', label: 'Umsatzsteuer 8.1%' },
      { code: 'VST-M', kind: 'input', label: 'Vorsteuer Material' },
    ],
  }),
};

function happy(status = 'proposed'): Canned {
  return {
    ...OPTION_READS,
    get_dunning_config: CONFIG,
    list_dunning_runs: ok({ runs: [runSummary(status)], truncated: false }),
    get_dunning_run: ok(runDetail(status)),
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: {
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm1',
      userId: 'u1',
      role: 'custom',
      capabilities: [...held],
    },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

interface RenderOptions {
  transport?: Transport;
  held?: readonly string[] | null;
  workspaceId?: string | null;
}

function renderDunning(canned: Canned = happy(), options: RenderOptions = {}) {
  const { transport, held = null, workspaceId = 'ws_test' } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  const inner = (
    <MemoryRouter initialEntries={['/dunning']}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <TillClientProvider client={client}>
            <Dunning />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(
    held === null ? (
      inner
    ) : (
      <CapabilitiesContext.Provider value={caps(held)}>{inner}</CapabilitiesContext.Provider>
    ),
  );
}

describe('Dunning: the five states', () => {
  it('loading: the skeleton is a load in progress, proven by the read having started', async () => {
    const transport = watchReads(neverSettles);
    renderDunning(undefined, { transport });
    await transport.started('list_dunning_runs');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('empty: no runs states what the surface is for and offers the propose', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: ok({ runs: [], truncated: false }),
    });
    expect(await screen.findByText('Noch keine Mahnläufe.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mahnlauf vorschlagen' }).length).toBeGreaterThan(0);
  });

  it('error: a transport failure renders the banner with a retry, never a blank table', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: { status: 0, body: { ok: false, error: 'transport_error' } },
    });
    expect(await screen.findByText('Die Mahnläufe konnten nicht geladen werden.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('permission-denied: a denied read is its own state, not an error banner', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: reject({ error: 'permission_denied', missing: 'read_sales' }, 403),
      list_dunning_runs: reject({ error: 'permission_denied', missing: 'read_sales' }, 403),
    });
    expect(
      await screen.findByText('Dir fehlt die Berechtigung, das Mahnwesen zu lesen.'),
    ).toBeInTheDocument();
  });

  it('no workspace: the shared no-workspace state', () => {
    renderDunning(undefined, { workspaceId: null });
    expect(screen.queryByText('Mahnwesen')).not.toBeInTheDocument();
  });
});

describe('Dunning: the proposed run', () => {
  it('renders the review table from the engine figures, formatted and never recomputed', async () => {
    renderDunning();
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).getByText('Säumig AG')).toBeInTheDocument();
    expect(within(current).getByText('R-2026-0001')).toBeInTheDocument();
    expect(within(current).getByText("CHF 1'081.00")).toBeInTheDocument();
    expect(within(current).getByText('CHF 20.00')).toBeInTheDocument();
    expect(within(current).getByText('CHF 6.76')).toBeInTheDocument();
    expect(within(current).getByText('45')).toBeInTheDocument();
    expect(within(current).getByText('01.06.2026')).toBeInTheDocument();
    expect(within(current).getByLabelText('1. Mahnung')).toBeInTheDocument();
    expect(within(current).getByText('Vorgeschlagen')).toBeInTheDocument();
  });

  it('Ausstellen carries the human confirmation and the run id', async () => {
    const issue = vi.fn((_input: Record<string, unknown>) => ok(runDetail('issued', { issuedAt: '2026-07-16T00:00:00.000Z' })));
    renderDunning({ ...happy(), issue_dunning_run: issue as unknown as Canned[string] });
    const button = await screen.findByRole('button', { name: 'Ausstellen' });
    await userEvent.click(button);
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    expect(issue.mock.calls[0]?.[0]).toMatchObject({ runId: 'run_1', confirmed: true });
  });

  it('Ausstellen is the money tint only when the issue books a fee (K-08)', async () => {
    // The fixture's item carries an unbooked fee: issuing it posts the Mahngebühr.
    renderDunning();
    const booking = await screen.findByRole('button', { name: 'Ausstellen' });
    expect(booking).toHaveClass('btn--accent');
    expect(booking).toHaveAttribute('data-money-commit', 'issue_dunning_run');
    cleanup();

    // No fee to book: the issue writes letters and posts nothing, so it is secondary beside the
    // header's one primary, and it claims no money commit.
    renderDunning({ ...happy(), get_dunning_run: ok(runDetail('proposed', { items: [{ ...ITEM, feeMinor: 0 }] })) });
    const plain = await screen.findByRole('button', { name: 'Ausstellen' });
    expect(plain).toHaveClass('btn--secondary');
    expect(plain).not.toHaveClass('btn--accent');
    expect(plain).not.toHaveAttribute('data-money-commit');
  });

  it('a period-locked fee comes back as the named note, not a silent success', async () => {
    const issue = vi.fn((_input: Record<string, unknown>) =>
      ok(runDetail('issued', { feeSkippedReason: 'period_locked', issuedAt: '2026-07-16T00:00:00.000Z' })),
    );
    renderDunning({ ...happy(), issue_dunning_run: issue as unknown as Canned[string] });
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    expect(
      await screen.findByText(
        'Der Mahnlauf wurde ausgestellt, die Mahngebühr aber nicht verbucht: die Periode ist gesperrt.',
      ),
    ).toBeInTheDocument();
  });

  it('the fee recovery carries its OWN idempotency key, or it books nothing at all', async () => {
    // C8's recovery reaches `issue_dunning_run`, the same verb the issue used, and it used to reuse
    // the ISSUE's key. `rememberIdempotent` keys on `(workspace, verb, key)` and fingerprints no
    // input, so the second call was answered from the memo: the surface reported success, the
    // control vanished on the next read, and not one Rappen of the deferred Mahngebühr was booked.
    // The browser flow caught it (the run stayed period-locked); this pins the key itself.
    let issued = false;
    const issue = vi.fn((_input: Record<string, unknown>) => {
      issued = true;
      return ok(runDetail('issued', { feeSkippedReason: 'period_locked', issuedAt: '2026-07-16T00:00:00.000Z' }));
    });
    const readRuns = vi.fn(() =>
      ok({
        runs: [issued ? runSummary('issued', { feeSkippedReason: 'period_locked' }) : runSummary('proposed')],
        truncated: false,
      }),
    );
    const readRun = vi.fn(() =>
      ok(
        issued
          ? runDetail('issued', { feeSkippedReason: 'period_locked', issuedAt: '2026-07-16T00:00:00.000Z' })
          : runDetail('proposed'),
      ),
    );
    renderDunning(
      {
        ...happy(),
        list_dunning_runs: readRuns as unknown as Canned[string],
        get_dunning_run: readRun as unknown as Canned[string],
        issue_dunning_run: issue as unknown as Canned[string],
      },
      { held: ['read_sales', 'dun', 'post'] },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Gebühr nachbuchen' }));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(2));
    const issueKey = (issue.mock.calls[0]?.[0] as Record<string, unknown>).idempotencyKey;
    const recoverKey = (issue.mock.calls[1]?.[0] as Record<string, unknown>).idempotencyKey;
    expect(typeof issueKey).toBe('string');
    expect(recoverKey).not.toBe(issueKey);
  });

  it('the ambiguous-key refusal is told in words, with the control it points at brought on screen', async () => {
    // Reachable from here through the lost-response window: the issue landed, its response did not,
    // `Ausstellen` still renders because the surface believes the run is proposed, and the next
    // click arrives under the same issue key on a run that is already issued with a deferred fee.
    // The engine refuses to guess whether that is a retry or a recovery. "Versuche es noch einmal"
    // would be false advice, because the key is stable per question and the retry repeats the
    // refusal for ever, so the surface names the state and reloads into it.
    let issued = false;
    const issue = vi.fn(() => {
      issued = true;
      return reject({
        error: 'recovery_needs_its_own_key',
        runId: 'run_1',
        reason: 'idempotency_key_already_names_the_issue',
        remedy: 'call_again_with_a_new_idempotency_key',
      });
    });
    const readRuns = vi.fn(() =>
      ok({
        runs: [issued ? runSummary('issued', { feeSkippedReason: 'period_locked' }) : runSummary('proposed')],
        truncated: false,
      }),
    );
    const readRun = vi.fn(() =>
      ok(
        issued
          ? runDetail('issued', { feeSkippedReason: 'period_locked', issuedAt: '2026-07-16T00:00:00.000Z' })
          : runDetail('proposed'),
      ),
    );
    renderDunning(
      {
        ...happy(),
        list_dunning_runs: readRuns as unknown as Canned[string],
        get_dunning_run: readRun as unknown as Canned[string],
        issue_dunning_run: issue as unknown as Canned[string],
      },
      { held: ['read_sales', 'dun', 'post'] },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ausstellen' }));
    expect(
      await screen.findByText(
        'Dieser Mahnlauf ist bereits ausgestellt. Die Mahngebühr ist noch offen: buche sie mit «Gebühr nachbuchen» nach.',
      ),
    ).toBeInTheDocument();
    // The reload puts the run's real state on screen, so the remedy the copy names is now a control.
    expect(await screen.findByRole('button', { name: 'Gebühr nachbuchen' })).toBeInTheDocument();
    expect(screen.queryByText('Die Aktion ist fehlgeschlagen. Versuche es noch einmal.')).toBeNull();
  });

  it('a propose that finds an existing run for the date says so and selects it (kaizen K-9)', async () => {
    // The engine dedupes on the asOf date and replies with the EXISTING run, flagged
    // `existing: true`. The surface used to discard that flag and clear the note, so the click was
    // a silent no-op. Now it must say so, and it must not mint a second run.
    const propose = vi.fn((_input: Record<string, unknown>) => ok({ ...runDetail('proposed'), existing: true }));
    renderDunning({ ...happy(), propose_dunning_run: propose as unknown as Canned[string] });
    await userEvent.click(await screen.findByRole('button', { name: 'Mahnlauf vorschlagen' }));
    expect(
      await screen.findByText('Der Mahnlauf für dieses Datum existiert bereits: er wird unten angezeigt.'),
    ).toBeInTheDocument();
    // The existing run is the working set: its detail panel is on screen, and exactly one propose
    // went over the wire (nothing retried, nothing created).
    expect(await screen.findByTestId('dunning-current')).toBeInTheDocument();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Die Aktion ist fehlgeschlagen. Versuche es noch einmal.')).toBeNull();
  });

  it('nothing overdue after a propose is the empty note, never an error', async () => {
    const propose = vi.fn((_input: Record<string, unknown>) => ok({ runId: null, proposed: false, items: [], reason: 'nothing_overdue' }));
    renderDunning({ ...happy(), propose_dunning_run: propose as unknown as Canned[string] });
    await userEvent.click(await screen.findByRole('button', { name: 'Mahnlauf vorschlagen' }));
    expect(
      await screen.findByText('Keine überfälligen Rechnungen: es gibt nichts zu mahnen.'),
    ).toBeInTheDocument();
  });
});

describe('Dunning: the fee column is the letter, not the policy (critic N6)', () => {
  it('an ISSUED run shows the frozen demand, not the configured fee', async () => {
    // The ordinary issue: the fee booked, so the demand equals it and the column reads the amount.
    renderDunning({
      ...happy('issued'),
      get_dunning_run: ok(
        runDetail('issued', {
          issuedAt: '2026-07-16T00:00:00.000Z',
          items: [{ ...ITEM, feeBooked: true, demandedFeeMinor: 2000 }],
        }),
      ),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).getByText('CHF 20.00')).toBeInTheDocument();
  });

  it('a fee a period lock deferred is reported as NOT DEMANDED, never as the policy amount', async () => {
    // The whole reason `demandedFeeMinor` exists. The letter that went out asked for no Mahngebühr,
    // so printing the policy's CHF 20.00 here would claim the debtor was charged something the
    // letter never mentions, and a bare blank would read as "no fee configured", which is the
    // opposite of the truth. The row states the fee, and states that this letter did not ask for it.
    renderDunning({
      ...happy('issued'),
      get_dunning_run: ok(
        runDetail('issued', {
          feeSkippedReason: 'period_locked',
          issuedAt: '2026-07-16T00:00:00.000Z',
          items: [{ ...ITEM, feeBooked: false, demandedFeeMinor: 0 }],
        }),
      ),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).queryByText('CHF 20.00')).not.toBeInTheDocument();
    expect(within(current).getByText('nicht gefordert')).toBeInTheDocument();
  });

  it('stays honest after the C8 recovery: booking the fee does not rewrite the letter', async () => {
    // `feeBooked` flips on the recovery and `feeSkippedReason` clears, so the run-level note is
    // gone. The demand is what never moves, and it is what this column has to keep saying.
    renderDunning({
      ...happy('issued'),
      get_dunning_run: ok(
        runDetail('issued', {
          issuedAt: '2026-07-16T00:00:00.000Z',
          items: [{ ...ITEM, feeBooked: true, demandedFeeMinor: 0 }],
        }),
      ),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).queryByText('CHF 20.00')).not.toBeInTheDocument();
    expect(within(current).getByText('nicht gefordert')).toBeInTheDocument();
  });

  it('a PROPOSED run still shows the planned fee, because that is the only fee there is yet', async () => {
    renderDunning();
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).getByText('CHF 20.00')).toBeInTheDocument();
  });
});

describe('Dunning: a named invoice changed since issue is warned (K-31)', () => {
  it('marks a settled/changed invoice on the review table and holds the letter, before any manual send', async () => {
    // The read model (get_dunning_run) carries the settlement re-check, so the warning is reachable
    // on the MANUAL/DOWNLOAD path even with no email transport wired at all. A partial payment is
    // named distinctly (K-31 f2), never a settled invoice silently shown as chased.
    renderDunning({
      ...happy('issued'),
      get_dunning_run: ok(
        runDetail('issued', {
          issuedAt: '2026-07-16T00:00:00.000Z',
          items: [{ ...ITEM, changeSinceIssue: 'partially_paid' }],
          debtors: [
            {
              ...GROUP,
              changedSinceIssue: true,
              changeReason: 'partially_paid',
              changedDocumentIds: ['doc_1'],
            },
          ],
        }),
      ),
    });
    const current = await screen.findByTestId('dunning-current');
    // The distinct cause is rendered (de-CH default): once beside the invoice, once on the held letter.
    const warnings = within(current).getAllByText(/teilweise bezahlt/i);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // The held-letter note steers the operator away from mailing the frozen letter as issued.
    expect(within(current).getByText(/nicht wie ausgestellt versenden/i)).toBeInTheDocument();
  });

  it('an unchanged issued run shows no warning', async () => {
    renderDunning({
      ...happy('issued'),
      get_dunning_run: ok(runDetail('issued', { issuedAt: '2026-07-16T00:00:00.000Z' })),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).queryByText(/nicht wie ausgestellt versenden/i)).not.toBeInTheDocument();
  });
});

describe('Dunning: the run history opens', () => {
  it('an earlier run can be opened from the history, and its letters come back with it', async () => {
    // The history used to be a list of dates that opened nothing, so once a newer Mahnlauf existed
    // the earlier one was unreachable: no review, and no way to reprint a letter that a debtor or a
    // Betreibungsamt may ask about. Every row is now a control that puts that run in the panel.
    const older = runSummary('sent', { runId: 'run_0', runDate: '2026-06-16' });
    const newer = runSummary('proposed');
    const readRun = vi.fn((input: Record<string, unknown>) =>
      input.runId === 'run_0'
        ? ok(
            runDetail('sent', {
              runId: 'run_0',
              runDate: '2026-06-16',
              sentAt: '2026-06-16T08:00:00.000Z',
              items: [{ ...ITEM, demandedFeeMinor: 2000, feeBooked: true }],
              debtors: [{ ...GROUP, sent: true }],
            }),
          )
        : ok(runDetail('proposed')),
    );
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: ok({ runs: [newer, older], truncated: false }),
      get_dunning_run: readRun as unknown as Canned[string],
    });
    // The newest run is what a fresh visit opens on.
    const panel = await screen.findByTestId('dunning-current');
    expect(within(panel).getByText('Mahnlauf vom 16.07.2026')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('dunning-current')).getByText('Mahnlauf vom 16.06.2026')).toBeInTheDocument(),
    );
    // The letters of the run that was actually sent, not the newest one's.
    expect(screen.getByRole('button', { name: 'Mahnbrief für Säumig AG herunterladen' })).toBeInTheDocument();
    // Which row is open is stated on the control, never by the row tint alone.
    expect(screen.getByRole('row', { name: 'Mahnlauf vom 16.06.2026 öffnen' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('Dunning: the issued run and the send', () => {
  it('an issued run offers Versenden and the per-debtor letters', async () => {
    renderDunning(happy('issued'));
    expect(await screen.findByRole('button', { name: 'Versenden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mahnbrief für Säumig AG herunterladen' })).toBeInTheDocument();
  });

  it('Versenden carries the human confirmation, and a missing transport names the manual path', async () => {
    const send = vi.fn((_input: Record<string, unknown>) => reject({ error: 'needs_email_config', transmitted: 0 }));
    renderDunning({ ...happy('issued'), send_dunning_run: send as unknown as Canned[string] });
    await userEvent.click(await screen.findByRole('button', { name: 'Versenden' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ runId: 'run_1', confirmed: true });
    expect(
      await screen.findByText(
        'Kein E-Mail-Versand eingerichtet: lade die Briefe herunter und versende sie manuell.',
      ),
    ).toBeInTheDocument();
  });

  it('a sent run shows the sent marker per debtor', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: ok({ runs: [runSummary('sent')], truncated: false }),
      get_dunning_run: ok(
        runDetail('sent', {
          sentAt: '2026-07-16T08:00:00.000Z',
          items: [{ ...ITEM, sentAt: '2026-07-16T08:00:00.000Z' }],
          debtors: [{ ...GROUP, sent: true }],
        }),
      ),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).getByText('Versendet')).toBeInTheDocument();
    expect(within(current).getByText('versendet')).toBeInTheDocument();
  });
});

describe('Dunning: the A24 courtesy gates', () => {
  it('propose and issue are pre-disabled without dun, named as denied', async () => {
    renderDunning(undefined, { held: ['read_sales', 'read_books'] });
    const propose = await screen.findByRole('button', { name: 'Mahnlauf vorschlagen (keine Berechtigung)' });
    expect(propose).toBeDisabled();
    const issue = await screen.findByRole('button', { name: 'Ausstellen (keine Berechtigung)' });
    expect(issue).toBeDisabled();
  });

  it('send needs dun AND send, mirroring the engine ALL-OF', async () => {
    renderDunning(happy('issued'), { held: ['read_sales', 'dun'] });
    const send = await screen.findByRole('button', { name: 'Versenden (keine Berechtigung)' });
    expect(send).toBeDisabled();
  });

  it('a fee-bearing issue needs post as well as dun, told before the click (N2)', async () => {
    // The proposed run's item carries an unbooked fee, so issuing it will post: `dun` alone is not
    // enough, exactly as the engine asserts.
    renderDunning(undefined, { held: ['read_sales', 'dun'] });
    const issue = await screen.findByRole('button', { name: 'Ausstellen (Buchen-Berechtigung fehlt)' });
    expect(issue).toBeDisabled();
  });

  it('a period-skipped fee offers the in-place recovery on the issued run (C8)', async () => {
    const issue = vi.fn((_input: Record<string, unknown>) =>
      ok(runDetail('issued', { feeRecovered: true, issuedAt: '2026-07-16T00:00:00.000Z' })),
    );
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      issue_dunning_run: issue as unknown as Canned[string],
      list_dunning_runs: ok({ runs: [runSummary('issued', { feeSkippedReason: 'period_locked' })], truncated: false }),
      get_dunning_run: ok(
        runDetail('issued', { feeSkippedReason: 'period_locked', issuedAt: '2026-07-16T00:00:00.000Z' }),
      ),
    });
    const recover = await screen.findByRole('button', { name: 'Gebühr nachbuchen' });
    await userEvent.click(recover);
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    expect(issue.mock.calls[0]?.[0]).toMatchObject({ runId: 'run_1', confirmed: true });
  });

  it('the config save is pre-disabled without manage_settings', async () => {
    renderDunning(undefined, { held: ['read_sales', 'dun'] });
    await screen.findByTestId('dunning-current');
    expect(screen.getByRole('button', { name: 'Einstellungen speichern (keine Berechtigung)' })).toBeDisabled();
  });
});

describe('Dunning: the policy editor', () => {
  it('renders the three levels and saves them in one write with an idempotency key', async () => {
    const save = vi.fn((_input: Record<string, unknown>) => ok({ levels: LEVELS }));
    renderDunning(
      { ...happy(), set_dunning_config: save as unknown as Canned[string] },
      { held: ['read_sales', 'dun', CAP.manageSettings] },
    );
    await screen.findByTestId('dunning-current');
    expect(screen.getByText('1. Mahnung')).toBeInTheDocument();
    expect(screen.getByText('2. Mahnung')).toBeInTheDocument();
    expect(screen.getByText('3. Mahnung')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Array.isArray(input.levels)).toBe(true);
    expect((input.levels as unknown[]).length).toBe(3);
    expect(typeof input.idempotencyKey).toBe('string');
    expect(await screen.findByText('Gespeichert.')).toBeInTheDocument();
  });

  it('K-60: the minimum-interval field shows for levels 2 and 3 only and rides the save payload', async () => {
    const save = vi.fn((_input: Record<string, unknown>) => ok({ levels: LEVELS }));
    renderDunning(
      { ...happy(), set_dunning_config: save as unknown as Canned[string] },
      { held: ['read_sales', 'dun', CAP.manageSettings] },
    );
    await screen.findByTestId('dunning-current');

    // Level 1 has no previous letter, so it carries no spacing control: exactly two inputs, for
    // levels 2 and 3.
    const intervalInputs = screen.getAllByLabelText('Min. Tage seit letzter Mahnung');
    expect(intervalInputs).toHaveLength(2);

    // Widen the level-2 spacing and confirm the write carries minIntervalDays on every level.
    await userEvent.clear(intervalInputs[0]!);
    await userEvent.type(intervalInputs[0]!, '15');
    await userEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0]?.[0] as Record<string, unknown>;
    const levels = input.levels as { level: number; minIntervalDays: number }[];
    expect(levels.every((l) => typeof l.minIntervalDays === 'number')).toBe(true);
    expect(levels.find((l) => l.level === 2)?.minIntervalDays).toBe(15);
  });

  it('a positive fee reveals the income-only account picker, and no tax-code picker exists (D69)', async () => {
    renderDunning(undefined, { held: ['read_sales', 'dun', CAP.manageSettings] });
    await screen.findByTestId('dunning-current');
    // A positive fee implies booking (C6), so typing one reveals the account picker.
    const feeInput = screen.getAllByLabelText('Mahngebühr (CHF)')[0];
    await userEvent.clear(feeInput!);
    await userEvent.type(feeInput!, '20.00');
    // findBy*, not getBy*: the picker APPEARS as a consequence of the typing, so a synchronous
    // lookup races the render that reveals it. Same class as the axe drain, different test: it went
    // red about one run in ten, on a picker that was simply not there yet.
    const accountSelect = (await screen.findAllByLabelText('Ertragskonto'))[0];
    await userEvent.click(accountSelect as HTMLElement);
    expect(screen.getByRole('option', { name: '3600 Übrige betriebliche Erlöse' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Kassenbestand/ })).not.toBeInTheDocument();
    // D69: the fee's VAT follows the chased invoice, so there is nothing to pick.
    expect(screen.queryByLabelText('Steuercode')).not.toBeInTheDocument();
  });

  it('stays OPEN when the save makes the policy configured, so its own confirmation is visible', async () => {
    // The panel used to bind `open` straight to `!config.configured`. A successful save flips that
    // flag, the disclosure collapsed on the very next render, and the "Gespeichert." it had just
    // earned went down with it: the operator saw the whole form vanish and was told nothing. The
    // browser flow found it; this pins it, by answering `configured` the way the engine really does.
    let reads = 0;
    const readConfig = vi.fn(() => {
      reads += 1;
      return ok({ levels: LEVELS, configured: reads > 1, interestFloorBp: 500 });
    });
    renderDunning(
      {
        ...happy(),
        get_dunning_config: readConfig as unknown as Canned[string],
        set_dunning_config: ok({ levels: LEVELS }),
      },
      { held: ['read_sales', 'dun', CAP.manageSettings] },
    );
    await screen.findByTestId('dunning-current');
    await userEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    const saved = await screen.findByText('Gespeichert.');
    expect(saved).toBeVisible();
    expect(screen.getByTestId('dunning-config')).toBeVisible();
  });

  it('the statutory floor rejection renders the Art. 104 message', async () => {
    const save = vi.fn((_input: Record<string, unknown>) => reject({ error: 'interest_below_statutory_floor', floorBp: 500 }));
    renderDunning(
      { ...happy(), set_dunning_config: save as unknown as Canned[string] },
      { held: ['read_sales', 'dun', CAP.manageSettings] },
    );
    await screen.findByTestId('dunning-current');
    await userEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    expect(
      await screen.findByText('Der Zinssatz liegt unter dem gesetzlichen Satz von 5% (Art. 104 OR).'),
    ).toBeInTheDocument();
  });
});

describe('Dunning: accessibility', () => {
  it('the happy state has no axe violations', async () => {
    const { container } = renderDunning();
    await screen.findByTestId('dunning-current');
    // The anchor above proves the settled COMMIT, not the flushed EFFECT CASCADE: a passive effect
    // that lands INSIDE the axe pass is a long await no act() covers, the console guard fails the
    // test on the act warning, and the failure is a flake rather than a violation (the node-20
    // failure of 31.07.2026, twice, and 2 of 6 pristine runs again after the disclosure change).
    //
    // TWO effects fire after the load, and the drain has to cover BOTH or it only moves the window:
    //
    //   1. `Dunning` seeds the policy disclosure once, from `configured`, so an unconfigured policy
    //      shows itself. Its output is the panel being OPEN, and nothing about the panel's CONTENT
    //      says whether that has flushed: a closed `<details>` keeps its children in the DOM, so a
    //      content assertion alone was satisfied a render too early. This is the one the second
    //      round of flakes came from.
    //   2. `ConfigPanel` re-syncs its drafts from the loaded config. Its output is the figure.
    //
    // One awaited settle asserting both, so the whole cascade drains inside act before axe holds
    // the window open, and each clause is the state its own effect exists to produce.
    await waitFor(() => {
      expect(screen.getByTestId('dunning-config')).toBeVisible();
      expect(
        within(screen.getByTestId('dunning-config')).getAllByLabelText('Tage überfällig')[0],
      ).toHaveValue(10);
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Dunning: C3 provenance', () => {
  it('names the actor that proposed the run, verbatim from the run header', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: ok({ runs: [runSummary('proposed')], truncated: false }),
      get_dunning_run: ok(runDetail('proposed', { createdBy: 'm.keller' })),
    });
    const current = await screen.findByTestId('dunning-current');
    expect(within(current).getByText(/Erfasst durch m\.keller/)).toBeInTheDocument();
  });

  it('shows the neutral form and no fabricated name when the run has no actor', async () => {
    renderDunning({
      ...OPTION_READS,
      get_dunning_config: CONFIG,
      list_dunning_runs: ok({ runs: [runSummary('proposed')], truncated: false }),
      get_dunning_run: ok(runDetail('proposed', { createdBy: null })),
    });
    const current = await screen.findByTestId('dunning-current');
    // The quiet "Erfasst, <date>" line renders; no "durch <name>" is invented for a null actor.
    expect(within(current).getByText(/^Erfasst,/)).toBeInTheDocument();
    expect(within(current).queryByText(/Erfasst durch/)).not.toBeInTheDocument();
  });
});
