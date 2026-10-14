/**
 * A40 `PaymentPlanning`, the Zahlungsplanung tab: the five states, the padlock, the proposal and the
 * draft step. Every figure on screen comes from the (mocked) engine verbs; the tab adds none.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { watchReads, neverSettles } from '../../test-transport';
import { PaymentPlanning } from './PaymentPlanning';
import { LiquidityChart } from './LiquidityChart';
import { chartGeometry, parseAmountToMinor, percentToBp, bpToPercent } from './planning-model';

const DAYS = [
  { date: '2026-07-16', inMinor: 0, outMinor: 0, balanceMinor: 5_000_000 },
  { date: '2026-07-17', inMinor: 0, outMinor: 105_938, balanceMinor: 4_894_062 },
  { date: '2026-07-20', inMinor: 108_100, outMinor: 0, balanceMinor: 5_002_162 },
];

const FORECAST = {
  asOf: '2026-07-16',
  horizonEnd: '2026-10-13',
  currency: 'CHF',
  openingBalanceMinor: 5_000_000,
  days: DAYS,
  flows: [],
  lowest: { date: '2026-07-17', balanceMinor: 4_894_062 },
  lowestWithPlan: null,
  excluded: [],
  assumptions: {
    noHistory: { count: 2, amountMinor: 216_200 },
    pooledHistory: { count: 0, amountMinor: 0 },
    openingSource: 'ledger',
    accountCount: 1,
    vatPartial: { count: 0, amountMinor: 0 },
    lastPossibleDay: true,
  },
};

const LINES = [
  {
    vendorBillId: 'vbill_1',
    vendorId: 'contact_1',
    vendorName: 'Papier Lieferant GmbH',
    vendorReference: 'RE-1',
    action: 'pay',
    option: 'skonto',
    payDate: '2026-07-23',
    arrivalDate: '2026-07-24',
    openMinor: 108_100,
    cashMinor: 105_938,
    skontoMinor: 2_162,
    interestMinor: 0,
    daysLate: 0,
    reason: 'skonto_captured',
    detail: { dueDate: '2026-08-13', skontoUntil: '2026-07-24', skontoRateBp: 200 },
    batchId: null,
  },
  {
    vendorBillId: 'vbill_2',
    vendorId: 'contact_2',
    vendorName: 'Server Hosting AG',
    vendorReference: 'RE-2',
    action: 'pay',
    option: 'on_time',
    payDate: '2026-08-04',
    arrivalDate: '2026-08-05',
    openMinor: 500_000,
    cashMinor: 500_000,
    skontoMinor: 0,
    interestMinor: 0,
    daysLate: 0,
    reason: 'on_time_latest',
    detail: { dueDate: '2026-08-05', skontoUntil: null, skontoRateBp: 0 },
    batchId: null,
  },
];

const PLAN = {
  id: 'pplan_1',
  status: 'proposed',
  asOf: '2026-07-16',
  horizonEnd: '2026-10-13',
  currency: 'CHF',
  floorMinor: 2_000_000,
  objectiveMinor: 2_162,
  skontoCapturedMinor: 2_162,
  lateInterestMinor: 0,
  optimality: 'proven',
  upperBoundMinor: 2_162,
  gapMinor: 0,
  minBalanceMinor: 4_394_062,
  minBalanceDate: '2026-08-04',
  floorBreachedByBase: null,
  draft: null,
  lines: LINES,
};

const DRAFTED = {
  ...PLAN,
  status: 'drafted',
  draft: {
    batches: [{ batchId: 'pbatch_1', executionDate: '2026-08-04', itemCount: 1, totalMinor: 500_000 }],
    notDrafted: [{ vendorBillId: 'vbill_1', payDate: '2026-07-23', reason: 'skonto_needs_reduced_amount' }],
  },
};

const BANK = { id: 'ba_1', currency: 'CHF', name: 'Kantonalbank Kontokorrent', iban: 'CH93 0076 2011 6238 5295 7', receiveOnly: false, archived: false };

function ok(body: Record<string, unknown>): RestResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function transportFor(overrides: Record<string, RestResponse | undefined>, calls: string[] = []): Transport {
  return async (action) => {
    calls.push(action);
    if (overrides[action] !== undefined) return overrides[action] as RestResponse;
    if (action === 'liquidity_forecast') return ok(FORECAST);
    if (action === 'list_bank_accounts') return ok({ bankAccounts: [BANK] });
    if (action === 'liquidity_skonto_list') return ok({ terms: [], total: 0 });
    if (action === 'liquidity_flow_list') return ok({ flows: [], total: 0 });
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
}

function caps(held: readonly string[]): Capabilities {
  return {
    whoami: { actor: 'studio', provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'viewer', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

function renderWith(transport: Transport, held: readonly string[] = [CAP.pay, CAP.manageMasterData, CAP.manageSettings]) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <TillClientProvider client={new TillClient(transport)}>
            <CapabilitiesContext.Provider value={caps(held)}>
              <PaymentPlanning />
            </CapabilitiesContext.Provider>
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installMemoryStorage();
});

describe('PaymentPlanning, the five states', () => {
  it('LOADING: a skeleton once the first read (the debit accounts) has genuinely started', async () => {
    const transport = watchReads(neverSettles);
    renderWith(transport);
    await transport.started('list_bank_accounts');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('EMPTY: no bank account in the currency offers the way to add one', async () => {
    renderWith(transportFor({ liquidity_forecast: { status: 422, body: { ok: false, error: 'needs_bank_account', currency: 'CHF' } } }));
    expect(await screen.findByText('Kein Bankkonto in dieser Währung.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bankkonto erfassen' }).getAttribute('href')).toBe('/bank-accounts');
  });

  it('ERROR: a failed forecast read shows the banner with a retry', async () => {
    renderWith(transportFor({ liquidity_forecast: { status: 500, body: { ok: false, error: 'transport_error' } } }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /erneut|retry/i })).toBeTruthy();
  });

  it('PERMISSION-DENIED: a denied read shows the padlock', async () => {
    renderWith(transportFor({ liquidity_forecast: { status: 403, body: { ok: false, error: 'permission_denied' } } }));
    expect(await screen.findByText(/keine Berechtigung, die Liquiditätsplanung/)).toBeTruthy();
  });

  it('SUCCESS: the chart names its lowest point, the proposal explains each bill, drafting lists runs and refusals', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    renderWith(
      transportFor(
        {
          liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }),
          liquidity_plan_draft_batches: ok({ planId: 'pplan_1', status: 'drafted', ...DRAFTED.draft, plan: DRAFTED }),
        },
        calls,
      ),
    );
    // The chart is an image with a one-sentence summary naming the lowest balance and its day.
    const chart = await screen.findByRole('img');
    expect(chart.getAttribute('aria-label')).toMatch(/tiefster Stand CHF 48.940,62|tiefster Stand .*48.?940\.62/);

    const propose = screen.getByRole('button', { name: 'Vorschlag berechnen' });
    expect(propose).toBeDisabled(); // no floor typed yet
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    expect(propose).toBeEnabled();
    await user.click(propose);

    expect(await screen.findByRole('heading', { name: 'Zahlungsvorschlag' })).toBeTruthy();
    expect(screen.getByText(/Skonto möglich: CHF 21.62, letzter Tag/)).toBeTruthy();
    expect(screen.getByText('Letzter Tag vor Fälligkeit')).toBeTruthy();
    expect(screen.getByText(/nachgewiesen/)).toBeTruthy();
    // The forecast is reloaded with the plan overlaid.
    await waitFor(() => expect(calls.filter((c) => c === 'liquidity_forecast').length).toBeGreaterThanOrEqual(2));

    await user.click(screen.getByRole('button', { name: 'Zahlungsläufe entwerfen' }));
    expect(await screen.findByText(/Diese Zahlungsläufe sind Entwürfe/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'pain.001 erzeugen' })).toBeTruthy();
    // M3: the Skonto line is stated plainly, never as an instruction to pay with a deduction TILL cannot book.
    expect(screen.getByText(/Skonto möglich: CHF 21.62 bis 24.07.2026; TILL kann den Abzug noch nicht verbuchen/)).toBeTruthy();
    expect(screen.queryByText(/mit Abzug/)).toBeNull();
    // R2-L3: the summary says the Skonto is possible, never that it was taken, and no copy promises a roadmap.
    const summary = screen.getByRole('region', { name: 'Zahlungsvorschlag' });
    expect(within(summary).getByText('Skonto möglich')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/genutzt|kommt als Nächstes/);
    // Drafted: the draft action is gone, so it cannot be pressed twice.
    expect(screen.queryByRole('button', { name: 'Zahlungsläufe entwerfen' })).toBeNull();
  });

  it('a stale proposal is refused in words, with the way to recompute', async () => {
    const user = userEvent.setup();
    renderWith(
      transportFor({
        liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }),
        liquidity_plan_draft_batches: { status: 422, body: { ok: false, error: 'stale_plan', planId: 'pplan_1' } },
      }),
    );
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await user.click(await screen.findByRole('button', { name: 'Zahlungsläufe entwerfen' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Berechne den Vorschlag neu/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neu berechnen' })).toBeTruthy();
  });

  it('recomputing sends a FRESH key, so a changed book is never answered by the memoised old proposal', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    const inner = transportFor({
      liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }),
      liquidity_plan_draft_batches: { status: 422, body: { ok: false, error: 'stale_plan', planId: 'pplan_1' } },
    });
    const transport: Transport = async (action, input) => {
      if (action === 'liquidity_plan_propose') keys.push(String((input as { idempotencyKey?: unknown }).idempotencyKey));
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await user.click(await screen.findByRole('button', { name: 'Zahlungsläufe entwerfen' }));
    await user.click(await screen.findByRole('button', { name: 'Neu berechnen' }));
    await waitFor(() => expect(keys.length).toBe(2));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('M4: the plan is solved on the one debit account the person picks, and that account is the one drafted', async () => {
    const user = userEvent.setup();
    const seen: { action: string; input: Record<string, unknown> }[] = [];
    const inner = transportFor({
      liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }),
      liquidity_plan_draft_batches: ok({ planId: 'pplan_1', status: 'drafted', ...DRAFTED.draft, plan: DRAFTED }),
    });
    const transport: Transport = async (action, input) => {
      seen.push({ action, input: (input ?? {}) as Record<string, unknown> });
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    expect(screen.getByRole('combobox', { name: 'Belastungskonto' })).toBeTruthy();
    const forecastCall = seen.find((c) => c.action === 'liquidity_forecast');
    expect(forecastCall?.input.bankAccountIds).toEqual(['ba_1']);
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await user.click(await screen.findByRole('button', { name: 'Zahlungsläufe entwerfen' }));
    await screen.findByText(/Diese Zahlungsläufe sind Entwürfe/);
    expect(seen.find((c) => c.action === 'liquidity_plan_propose')?.input.bankAccountIds).toEqual(['ba_1']);
    expect(seen.find((c) => c.action === 'liquidity_plan_draft_batches')?.input.bankAccountId).toBe('ba_1');
  });

  it('M8 (owner decision): a schedule that breaches the floor stops the plan and offers both ways out', async () => {
    const user = userEvent.setup();
    const proposals: Record<string, unknown>[] = [];
    const inner = transportFor({});
    const transport: Transport = async (action, input) => {
      if (action === 'liquidity_plan_propose') {
        const i = (input ?? {}) as Record<string, unknown>;
        proposals.push(i);
        if (i.acceptLatePayments === true || i.floorMinor === 4_532_400) return ok({ planId: 'pplan_1', replayed: false, plan: PLAN });
        return {
          status: 422,
          body: { ok: false, error: 'floor_breached_by_schedule', date: '2026-10-01', currency: 'CHF', balanceMinor: 4_532_400, shortfallMinor: 767_600, suggestedFloorMinor: 4_532_400 },
        };
      }
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '53000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Dein Mindestbestand wird am 01.10.2026 durch geplante Zahlungen um CHF 7.676,00|Dein Mindestbestand wird am 01\.10\.2026 durch geplante Zahlungen um CHF 7.?676\.00 unterschritten/)).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Verspätungen in Kauf nehmen' }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    expect(proposals[1]?.acceptLatePayments).toBe(true);
    expect(proposals[1]?.floorMinor).toBe(5_300_000);
  });

  it('M8: lowering the floor to the suggested one proposes again with it', async () => {
    const user = userEvent.setup();
    const proposals: Record<string, unknown>[] = [];
    const inner = transportFor({});
    const transport: Transport = async (action, input) => {
      if (action === 'liquidity_plan_propose') {
        const i = (input ?? {}) as Record<string, unknown>;
        proposals.push(i);
        if (i.floorMinor === 4_532_400) return ok({ planId: 'pplan_1', replayed: false, plan: PLAN });
        return {
          status: 422,
          body: { ok: false, error: 'floor_breached_by_schedule', date: '2026-10-01', currency: 'CHF', balanceMinor: 4_532_400, shortfallMinor: 767_600, suggestedFloorMinor: 4_532_400 },
        };
      }
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '53000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: /Mindestbestand auf .* senken/ }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    expect(proposals[1]?.floorMinor).toBe(4_532_400);
    expect((screen.getByLabelText(/Mindestbestand/) as HTMLInputElement).value).toBe('45324.00');
  });

  it('R2-H1: the lower action promises on-time payment, and an account that overdraws even at no floor offers only the delays', async () => {
    const user = userEvent.setup();
    let overdraws = false;
    const proposals: Record<string, unknown>[] = [];
    const inner = transportFor({});
    const transport: Transport = async (action, input) => {
      if (action === 'liquidity_plan_propose') {
        const i = (input ?? {}) as Record<string, unknown>;
        proposals.push(i);
        if (i.acceptLatePayments === true) return ok({ planId: 'pplan_1', replayed: false, plan: PLAN });
        return {
          status: 422,
          body: overdraws
            ? { ok: false, error: 'floor_breached_by_schedule', date: '2026-07-24', currency: 'CHF', balanceMinor: -1_000_000, shortfallMinor: 6_300_000, suggestedFloorMinor: null, overdraws: true }
            : { ok: false, error: 'floor_breached_by_schedule', date: '2026-10-01', currency: 'CHF', balanceMinor: 4_532_400, shortfallMinor: 767_600, suggestedFloorMinor: 4_532_400, overdraws: false },
        };
      }
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '53000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    let alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/wird jede Rechnung bis zu ihrer Fälligkeit bezahlt/)).toBeTruthy();
    overdraws = true;
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await screen.findByText(/Das reicht auch ohne Mindestbestand nicht/);
    alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button', { name: /Mindestbestand auf .* senken/ })).toBeNull();
    expect(within(alert).queryByText(/wird jede Rechnung bis zu ihrer Fälligkeit bezahlt/)).toBeNull();
    expect(within(alert).getByText(/fällt dein Kontostand am 24.07.2026 auf/)).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Verspätungen in Kauf nehmen' }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    expect(proposals.at(-1)?.acceptLatePayments).toBe(true);
  });

  it('R4-L1: a refusal whose no-late search was only cut by its budget says so, never that only late payments help', async () => {
    const user = userEvent.setup();
    const transport: Transport = async (action, input) =>
      action === 'liquidity_plan_propose'
        ? {
            status: 422,
            body: { ok: false, error: 'floor_breached_by_schedule', date: '2026-07-24', currency: 'CHF', balanceMinor: -1_000_000, shortfallMinor: 1_000_000, suggestedFloorMinor: null, overdraws: true, noLateSearch: 'not_found' },
          }
        : transportFor({})(action, input);
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '0');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/keinen Plan ohne Verspätung gefunden; ausgeschlossen ist er damit nicht/)).toBeTruthy();
    expect(within(alert).queryByText(/Es geht nur, wenn einige Rechnungen später bezahlt werden/)).toBeNull();
  });

  it('R5: when the scheduled flows alone overdraw, it says no payment date helps, never that late payments would', async () => {
    const user = userEvent.setup();
    const transport: Transport = async (action, input) =>
      action === 'liquidity_plan_propose'
        ? {
            status: 422,
            body: {
              ok: false,
              error: 'floor_breached_by_schedule',
              date: '2026-07-20',
              currency: 'CHF',
              balanceMinor: -1_100_000,
              shortfallMinor: 1_100_000,
              suggestedFloorMinor: null,
              overdraws: true,
              noLateSearch: 'proven',
              scheduleAloneOverdraws: { date: '2026-07-20', balanceMinor: -1_000_000 },
            },
          }
        : transportFor({})(action, input);
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '0');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Das ändert kein Zahlungsdatum, auch kein späteres/)).toBeTruthy();
    expect(within(alert).queryByText(/wenn einige Rechnungen später bezahlt werden/)).toBeNull();
    expect(within(alert).queryByRole('button', { name: 'Verspätungen in Kauf nehmen' })).toBeNull();
  });

  it('R2-M2: "für dieses Konto allein" only when nothing of unknown account is counted on it, and the rest is named', async () => {
    const user = userEvent.setup();
    const shared = {
      ...FORECAST,
      assumptions: { ...FORECAST.assumptions, accountUnknown: { count: 2, inMinor: 2_162_000, outMinor: 100_000, kinds: ['vat', 'receivable'] } },
    };
    const { unmount } = renderWith(
      transportFor({ liquidity_forecast: ok(shared), liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }) }),
    );
    await screen.findByRole('img');
    const block = screen.getByRole('region', { name: 'Annahmen' });
    expect(within(block).getByText(/2 Zahlungen ohne bekanntes Konto sind Kantonalbank Kontokorrent zugerechnet \(Kundenrechnungen, MWST\)/)).toBeTruthy();
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    expect(screen.getByText(/zusammen mit den Zahlungen ohne bekanntes Konto/)).toBeTruthy();
    expect(screen.queryByText(/für dieses Konto allein/)).toBeNull();
    unmount();

    renderWith(transportFor({ liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }) }));
    await screen.findByRole('img');
    expect(screen.queryByText(/ohne bekanntes Konto/)).toBeNull();
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    expect(screen.getByText(/Der Mindestbestand gilt für dieses Konto allein/)).toBeTruthy();
  });

  it('R2-M2: a planned flow names its account, the debit account by default, or none when the person says so', async () => {
    const user = userEvent.setup();
    const sets: Record<string, unknown>[] = [];
    const inner = transportFor({});
    const transport: Transport = async (action, input) => {
      if (action === 'liquidity_flow_set') {
        sets.push((input ?? {}) as Record<string, unknown>);
        return ok({ flow: { id: 'pflow_1' }, created: true });
      }
      return inner(action, input);
    };
    renderWith(transport);
    await screen.findByRole('img');
    const addOne = async (label: string, none: boolean) => {
      await user.click(screen.getByRole('button', { name: 'Geplante Zahlung erfassen' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Bezeichnung'), label);
      await user.type(within(dialog).getByLabelText(/Betrag/), '3000');
      fireEvent.change(within(dialog).getByLabelText('Erstes Datum'), { target: { value: '2026-08-01' } });
      expect(within(dialog).getByRole('combobox', { name: 'Konto' }).textContent).toContain('Kantonalbank Kontokorrent');
      if (none) {
        await user.click(within(dialog).getByRole('combobox', { name: 'Konto' }));
        const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-value') === '');
        if (option === undefined) throw new Error('no "Kein bestimmtes Konto" option');
        await user.click(option);
      }
      await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await addOne('Miete', false);
    await addOne('Darlehen', true);
    expect(sets.map((s) => `${String(s.label)}:${'bankAccountId' in s ? String(s.bankAccountId) : '-'}`)).toEqual(['Miete:ba_1', 'Darlehen:-']);
  });

  it('R2-L4: a heuristic plan says it is not proven optimal and states its lateness gap next to its worth gap; a proven one says nothing more', async () => {
    const user = userEvent.setup();
    const bounded = { ...PLAN, optimality: 'heuristic', upperBoundMinor: 2_662, gapMinor: 500, daysLateTotal: 9, lateDaysLowerBound: 7, lateGapDays: 2 };
    let answer: Record<string, unknown> = bounded;
    const inner = transportFor({});
    const transport: Transport = async (action, input) =>
      action === 'liquidity_plan_propose' ? ok({ planId: 'pplan_1', replayed: false, plan: answer }) : inner(action, input);
    renderWith(transport);
    await screen.findByRole('img');
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    const propose = screen.getByRole('button', { name: 'Vorschlag berechnen' });
    await user.click(propose);
    expect(await screen.findByText('Verspätung insgesamt 9 Tage; Untergrenze für jeden Vorschlag: 7 Tage.')).toBeTruthy();
    expect(screen.getByText(/nicht als optimal nachgewiesen/)).toBeTruthy();
    expect(screen.queryByText(/\(nachgewiesen\)/)).toBeNull();
    answer = { ...bounded, daysLateTotal: 1, lateDaysLowerBound: 0, lateGapDays: 1 };
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    expect(await screen.findByText('Verspätung insgesamt 1 Tag; ob es mit weniger geht, ist nicht nachgewiesen.')).toBeTruthy();
    answer = { ...PLAN, daysLateTotal: 0, lateDaysLowerBound: 0, lateGapDays: 0 };
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await waitFor(() => expect(screen.queryByText(/Verspätung insgesamt/)).toBeNull());
  });

  it('M9: the assumptions that can break the floor are shown briefly, with their sums, and the upload deadline after drafting', async () => {
    const user = userEvent.setup();
    renderWith(
      transportFor({
        liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: PLAN }),
        liquidity_plan_draft_batches: ok({ planId: 'pplan_1', status: 'drafted', ...DRAFTED.draft, plan: DRAFTED }),
      }),
    );
    await screen.findByRole('img');
    const block = screen.getByRole('region', { name: 'Annahmen' });
    expect(within(block).getByText(/2 Zahlungseingänge \(CHF 2.162,00\)|2 Zahlungseingänge \(CHF 2.?162\.00\) von Kunden ohne Zahlungsgeschichte/)).toBeTruthy();
    expect(within(block).getByText(/laut Buchhaltung, nicht laut Bank/)).toBeTruthy();
    expect(within(block).getByText(/letzten Tag, an dem die Zahlung noch rechtzeitig ankommt/)).toBeTruthy();
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await user.click(await screen.findByRole('button', { name: 'Zahlungsläufe entwerfen' }));
    expect(await screen.findByText(/Lade die Datei spätestens am 04.08.2026 hoch/)).toBeTruthy();
  });

  it('PADLOCK: without `pay` the proposal is pre-disabled with a visible reason', async () => {
    renderWith(transportFor({}), [CAP.manageMasterData]);
    await screen.findByRole('img');
    const propose = screen.getByRole('button', { name: 'Vorschlag berechnen' });
    expect(propose).toBeDisabled();
    expect(propose.getAttribute('aria-describedby')).toBe('pay-plan-pay-denied');
    expect(screen.getByText('Erfordert die Berechtigung Zahlungen')).toBeTruthy();
    // And without `manage_settings` the planned-flow editor is disabled with its own reason.
    expect(screen.getByRole('button', { name: 'Geplante Zahlung erfassen' })).toBeDisabled();
    expect(screen.getByText('Erfordert die Berechtigung Einstellungen')).toBeTruthy();
  });
});

describe('PaymentPlanning conservative MWST (R4-M1, owner decision 01.10.2026)', () => {
  it('shows every conservatively debited amount as its own line, beside the forecast and beside the proposal', async () => {
    const user = userEvent.setup();
    const lines = [
      { kind: 'vat', reason: 'vat_unattributed', ref: '2026-Q2', amountMinor: 810_000, date: '2026-08-27', dueDate: '2026-08-29', refusal: null },
      { kind: 'vat', reason: 'vat_return_refused', ref: '2026-Q3', amountMinor: 16_200, date: '2026-11-27', dueDate: '2026-11-29', refusal: 'unsupported' },
      { kind: 'vat', reason: 'vat_input_not_settled', ref: '2026-Q1', amountMinor: 40_500, date: '2026-07-16', dueDate: '2026-05-30', refusal: null },
    ];
    renderWith(
      transportFor({
        liquidity_forecast: ok({ ...FORECAST, conservative: lines }),
        liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: { ...PLAN, conservative: [lines[0]], excluded: [] } }),
      }),
    );
    expect(await screen.findByText(/MWST nicht periodengenau zuordenbar: CHF 8.100.00, vorsichtshalber am 27.08.2026 abgezogen/)).toBeTruthy();
    expect(screen.getByText(/MWST 2026-Q3: Die Abrechnung kann TILL noch nicht berechnen/)).toBeTruthy();
    expect(screen.getByText(/Vorsteuer nicht abgerechnet \(2026-Q1\): CHF 405.00 vorsichtshalber am 16.07.2026 abgezogen. Schliesse die MWST-Periode ab/)).toBeTruthy();
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    await screen.findByRole('heading', { name: 'Zahlungsvorschlag' });
    const notes = screen.getAllByRole('note').filter((n) => /vorsichtshalber/.test(n.textContent ?? ''));
    expect(notes.length).toBe(1);
    expect(notes[0]?.textContent).toMatch(/vorsichtshalber am 27.08.2026 abgezogen/);
  });
});

describe('PaymentPlanning copy (L4)', () => {
  it('names every excluded reason in words and says "1 Tag", never "1 Tage"', async () => {
    const user = userEvent.setup();
    const oneDayLate = {
      ...PLAN,
      lines: [{ ...LINES[1], option: 'late', daysLate: 1, interestMinor: 0, reason: 'late_floor' }],
    };
    renderWith(
      transportFor({
        liquidity_forecast: ok({
          ...FORECAST,
          excluded: [
            { kind: 'payable', reason: 'other_currency', ref: 'vbill_9', currency: 'EUR', amountMinor: 1000 },
            { kind: 'vat', reason: 'vat_period_not_started', ref: '2026-Q4', currency: 'CHF', amountMinor: 0 },
            { kind: 'receivable', reason: 'customer_credit', ref: 'pay_1', currency: 'CHF', amountMinor: -500 },
            { kind: 'vat', reason: 'vat_due_beyond_horizon', ref: '2026-Q3', currency: 'CHF', amountMinor: 81_000 },
          ],
        }),
        liquidity_plan_propose: ok({ planId: 'pplan_1', replayed: false, plan: oneDayLate }),
      }),
    );
    expect(
      await screen.findByText(
        /4 Posten sind nicht eingerechnet: andere Währung, Kundenguthaben, MWST einer noch nicht begonnenen Periode \(nur Serienrechnungen gezählt\), MWST einer Periode, die erst nach dem Zeitraum fällig wird/,
      ),
    ).toBeTruthy();
    await user.type(screen.getByLabelText(/Mindestbestand/), '20000');
    await user.click(screen.getByRole('button', { name: 'Vorschlag berechnen' }));
    expect(await screen.findByText(/^1 Tag zu spät wegen Mindestbestand/)).toBeTruthy();
    expect(screen.queryByText(/1 Tage/)).toBeNull();
  });
});

describe('LiquidityChart, the table twin (L3)', () => {
  it('lists a day only the proposal pays on, with the proposal\'s own Ein/Aus', () => {
    const days = [
      { date: '2026-07-16', inMinor: 0, outMinor: 0, balanceMinor: 5_000_000, balanceWithPlanMinor: 5_000_000, inWithPlanMinor: 0, outWithPlanMinor: 0 },
      // Only the proposal pays on 23.7. (a Skonto day): the baseline shows nothing that day.
      { date: '2026-07-23', inMinor: 0, outMinor: 0, balanceMinor: 5_000_000, balanceWithPlanMinor: 4_894_062, inWithPlanMinor: 0, outWithPlanMinor: 105_938 },
      { date: '2026-08-13', inMinor: 0, outMinor: 108_100, balanceMinor: 4_891_900, balanceWithPlanMinor: 4_894_062, inWithPlanMinor: 0, outWithPlanMinor: 0 },
    ];
    render(
      <I18nProvider>
        <LiquidityChart days={days} currency="CHF" floorMinor={2_000_000} lowest={{ date: '2026-08-13', balanceMinor: 4_891_900 }} />
      </I18nProvider>,
    );
    const rows = screen.getAllByRole('row');
    const planDay = rows.find((r) => within(r).queryByText('23.07.2026') !== null);
    expect(planDay).toBeTruthy();
    expect(within(planDay as HTMLElement).getByText(/1.?059\.38/)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Ausgang (mit Vorschlag)' })).toBeTruthy();
  });
});

describe('planning-model helpers', () => {
  it('parses money and percentages exactly, never through a float', () => {
    expect(parseAmountToMinor("20'000.50")).toBe(2_000_050);
    expect(parseAmountToMinor('-500')).toBe(-50_000);
    expect(parseAmountToMinor('1.234')).toBeNull();
    expect(percentToBp('2')).toBe(200);
    expect(percentToBp('2,5')).toBe(250);
    expect(percentToBp('11')).toBeNull();
    expect(bpToPercent(250)).toBe('2.5');
    expect(bpToPercent(200)).toBe('2');
  });

  it('draws the lowest point where the series is lowest', () => {
    const g = chartGeometry(DAYS, 2_000_000);
    expect(g).not.toBeNull();
    const low = (g as NonNullable<typeof g>).lowest;
    // Day index 1 is the lowest balance; its marker sits inside that day's slot.
    expect(low.x).toBeGreaterThan(8 + (1 / 3) * (720 - 16));
    expect(low.x).toBeLessThan(8 + (2 / 3) * (720 - 16));
  });
});
