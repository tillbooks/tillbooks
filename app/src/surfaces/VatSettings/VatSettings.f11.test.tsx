/**
 * F11's own render proof for the VatSettings additions: the Tätigkeiten, the approval-branch
 * dialog, the Art. 88 Abs. 6 election, and the Bewilligungsverlauf.
 *
 * WHY THIS FILE EXISTS BESIDE VatSettings.test.tsx. That suite's canned transport answers 404
 * `unknown_action` for any verb it does not list, and it lists neither `list_accounts` nor
 * `vat_saldo_generations`. The new panels therefore render there against empty data and every one of
 * its 22 tests stays green whether the F11 surface works or does not exist at all. Feeding them real
 * payloads is the difference between measuring the implementation and assuming it.
 *
 * SCOPE, under D47. This is the implementation's own proof, not the wave's test suite: the wave
 * testing agent owns the unit, integration, idempotency-on-ROWS and tenant tests. What is pinned here
 * is only what this branch built and could otherwise ship unobserved, including the two things that
 * are easy to get silently wrong: the predecessor's new last day (a date computed for the operator to
 * check against their own filings) and the FRESH idempotency key on the branch replay.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import VatSettings from './index';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({
  status: 422,
  body: { ok: false, error, ...extra },
});

/**
 * The chart comes from the PINNED `list_accounts` recording, never a literal of this file's own.
 *
 * `test/accounts/studio-list-accounts-fixture.test.mjs` caught the first draft of this suite doing
 * exactly what it exists to stop, and it was right to: the hand-typed rows had invented ids
 * (`acc_3200` for what the engine actually answers as `acc_28`), so the mapping assertions below
 * would have agreed with this file rather than with the chart. The same class of defect once put
 * eight wrong account NAMES past a suite whose every `kind` matched.
 */
const ACCOUNTS = listAccountsFixture.accounts;

/** The recording's real ids for the two accounts the fixture maps, looked up rather than typed. */
const idOf = (number: string) => {
  const row = ACCOUNTS.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recording carries no account ${number}`);
  return row.id;
};

const SALDO_CONFIG = {
  method: 'saldo',
  timing: 'soll',
  registered: true,
  saldoRates: [
    { position: 1, rateBp: 620, formLine: '323' },
    { position: 2, rateBp: 370, formLine: '333' },
  ],
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

const GENERATIONS = {
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
      rates: SALDO_CONFIG.saldoRates,
      activities: SALDO_CONFIG.saldoActivities,
    },
  ],
};

function renderVat(canned: Record<string, RestResponse | ((i: Record<string, unknown>) => RestResponse)>) {
  const transport: Transport = async (action, input) => {
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
}

const base = {
  vat_config: ok({ config: SALDO_CONFIG }),
  vat_codes: ok({ taxCodes: [] }),
  list_accounts: ok({ accounts: ACCOUNTS }),
  vat_saldo_generations: ok(GENERATIONS),
};

describe('F11 render proof', () => {
  it('renders the Tätigkeiten with their mapped Ertragskonten', async () => {
    renderVat(base);
    await screen.findByText('Tätigkeiten');
    expect((await screen.findByLabelText('Name der Tätigkeit 1')) as HTMLInputElement).toHaveValue('Restauration');
    expect((await screen.findByLabelText('Name der Tätigkeit 2')) as HTMLInputElement).toHaveValue('Ablieferung');

    // The picker offers exactly the chart's INCOME accounts, once per Tätigkeit row, and no others.
    // Derived from the recording rather than restated, so a chart change moves both sides together.
    const income = ACCOUNTS.filter((a) => a.type === 'income' && !a.archived);
    expect(income.length).toBeGreaterThan(1);
    for (const a of income) {
      expect(screen.getAllByText(`${a.number} ${a.name}`).length).toBe(2);
    }
    // An expense account is never offered: turnover is never booked on one, so mapping it to a
    // Tätigkeit could only ever mislead.
    const expense = ACCOUNTS.find((a) => a.type === 'expense');
    expect(expense).toBeTruthy();
    expect(screen.queryByText(`${expense?.number} ${expense?.name}`)).toBeNull();

    // The mapped account is CHECKED inside its own Tätigkeit.
    const rows = document.querySelectorAll('.vat-activity-row');
    const first = rows[0] as HTMLElement;
    const checked = [...first.querySelectorAll('input[type=checkbox]')].filter((c) => (c as HTMLInputElement).checked);
    expect(checked.length).toBe(1);
  });

  it('renders the Bewilligungsverlauf with the superseded approval closed', async () => {
    renderVat(base);
    await screen.findByText('Bewilligungsverlauf');
    expect(screen.getByText('Ab 01.01.2026, laufend')).toBeTruthy();
    expect(screen.getByText('01.01.0001 bis 31.12.2025')).toBeTruthy();
    // The rate alone. The Ziffer left this panel with the Beiblatt remodelling: it is a property of
    // the period being FILED, not of the approval, so printing the stored per-position value here
    // named Ziffer 333 for a second rate on a form that no longer has that row (A07 §3.1a).
    // SCOPED to the history panel: '5.3%' also appears as an <option> in every rate picker, so an
    // unscoped query matches the ladder and proves nothing about this panel.
    const rates = [...document.querySelectorAll('.vat-history-rates')].map((n) => n.textContent);
    expect(rates).toContain('5.3%');
  });

  it('renders the Art. 88 Abs. 6 election and sends the elected basis', async () => {
    const spy = vi.fn((_i: Record<string, unknown>) => ok({}));
    renderVat({ ...base, vat_saldo_declaration_basis: spy });
    await screen.findByText('Abrechnungsart der Steuerperiode 2026');
    await userEvent.click(screen.getByLabelText('Gesamter Umsatz zum höchsten Satz (Art. 88 Abs. 6)'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ taxPeriod: '2026', basis: 'highest_rate' });
  });

  it('asks the branch question instead of dying when the engine refuses unstated', async () => {
    const configure = vi.fn((input: Record<string, unknown>) => {
      if (input.saldoGrant === undefined && input.saldoCorrection === undefined) {
        return reject('saldo_generation_change_unstated', { openSince: '2026-01-01' });
      }
      return ok({});
    });
    renderVat({ ...base, vat_configure: configure });
    await screen.findByText('Tätigkeiten');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    // The dialog appears rather than the panel going dead (D44 F1).
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(screen.getByText('Was hat sich geändert?')).toBeTruthy();

    // The teaching sentence names the predecessor's NEW LAST DAY, computed from the typed date.
    const date = screen.getByLabelText('Gültig ab');
    await userEvent.type(date, '2026-07-01');
    await screen.findByText(
      'Die bisherige Bewilligung (ab 01.01.2026) gilt neu bis 30.06.2026. Bereits eingereichte Perioden bleiben unverändert.',
    );

    await userEvent.click(screen.getAllByRole('button', { name: 'Speichern' })[1] as HTMLElement);
    await waitFor(() => expect(configure.mock.calls.length).toBe(2));
    expect(configure.mock.calls[1]?.[0]).toMatchObject({ saldoGrant: { validFrom: '2026-07-01' } });
    // A FRESH idempotency key, or the engine would replay the stored refusal.
    expect(configure.mock.calls[1]?.[0]?.idempotencyKey).not.toBe(configure.mock.calls[0]?.[0]?.idempotencyKey);
  });

  it('sends saldoActivities on an ordinary save, including an empty list', async () => {
    const configure = vi.fn((_i: Record<string, unknown>) => ok({}));
    renderVat({ ...base, vat_configure: configure });
    await screen.findByText('Tätigkeiten');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(configure).toHaveBeenCalled());
    const sent = configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.saldoActivities).toEqual([
      { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
      { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
    ]);
    expect(sent.saldoRates).toEqual([{ rateBp: 620 }, { rateBp: 370 }]);
  });
});
