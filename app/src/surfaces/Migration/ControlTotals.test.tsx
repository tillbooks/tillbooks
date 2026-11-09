/**
 * The G11 control-total declaration form. The claims worth the most:
 *
 *   A FRANC AMOUNT REACHES THE ENGINE AS INTEGER RAPPEN, never a float: `12'345.60` must land as
 *   1234560, because the engine compares declared against computed by integer subtraction (P2) and a
 *   float would poison the difference on a filing-grade figure.
 *
 *   A MALFORMED AMOUNT IS REFUSED BEFORE THE CALL, so a typo never reaches the money path.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ControlTotals, francsToMinor, minorToFrancs } from './ControlTotals';
import de from './messages.de-CH.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

function tree(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
      <I18nProvider>
        <ControlTotals workspaceId="ws_1" planId="migplan_1" />
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('francsToMinor', () => {
  it('converts a franc amount to integer Rappen', () => {
    expect(francsToMinor("12'345.60")).toBe(1234560);
    expect(francsToMinor('80')).toBe(8000);
    expect(francsToMinor('1234,5')).toBe(123450);
    expect(francsToMinor('-80')).toBe(-8000);
    expect(francsToMinor('0.05')).toBe(5);
  });

  it('refuses a malformed amount', () => {
    expect(francsToMinor('')).toBeNull();
    expect(francsToMinor('abc')).toBeNull();
    expect(francsToMinor('1.234')).toBeNull();
  });
});

describe('ControlTotals form', () => {
  it('declares a total as integer Rappen', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ migration_declare_control_total: ok({ controlId: 'migctl_1' }) }, calls));

    fireEvent.change(screen.getByLabelText(de.migration.controlTotals.amount), { target: { value: "12'345.60" } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.controlTotals.declare }));

    await waitFor(() => {
      const declared = calls.find((c) => c.action === 'migration_declare_control_total');
      expect(declared).toBeTruthy();
      expect(declared?.input.declaredMinor).toBe(1234560);
      // The default kind's scope defaults to the account, which empties to 'workspace' when left blank.
      expect(declared?.input.kind).toBe('trial_balance_matches_source');
    });
  });

  it('refuses a malformed amount before any call', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ migration_declare_control_total: ok({ controlId: 'migctl_1' }) }, calls));

    fireEvent.change(screen.getByLabelText(de.migration.controlTotals.amount), { target: { value: '1.234' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.controlTotals.declare }));

    expect(await screen.findByText(de.migration.controlTotals.amountInvalid)).toBeTruthy();
    expect(calls.find((c) => c.action === 'migration_declare_control_total')).toBeUndefined();
  });
});

describe('minorToFrancs', () => {
  it('is the inverse of francsToMinor for the declared figures', () => {
    expect(minorToFrancs(1234560)).toBe('12345.60');
    expect(minorToFrancs(8000)).toBe('80.00');
    expect(minorToFrancs(-8000)).toBe('-80.00');
    expect(minorToFrancs(5)).toBe('0.05');
  });
});

describe('ControlTotals persistence (f8)', () => {
  it('shows the already-declared figures on mount, so the list is not empty after a reload', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_checks: ok({ checks: [{ checkId: 'migcheck_1' }] }),
          migration_get_check: ok({
            controls: [
              { kind: 'ar_control', scope: 'workspace', declaredMinor: 500000 },
              { kind: 'trial_balance_balanced', scope: 'workspace', declaredMinor: null },
            ],
          }),
        },
        calls,
      ),
    );
    // The persisted AR figure renders from the fetched check, not from anything typed this session.
    expect(await screen.findByText(new RegExp(de.check.kind.arControl))).toBeTruthy();
    // The structural control with no declared figure is not shown as a declared row.
    expect(screen.queryByText(new RegExp(de.check.kind.trialBalanceBalanced))).toBeNull();
  });

  it('a FIRST declare of a new figure does NOT confirm; a RE-declare of an existing one DOES', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_checks: ok({ checks: [{ checkId: 'migcheck_1' }] }),
          migration_get_check: ok({ controls: [{ kind: 'trial_balance_matches_source', scope: 'workspace', declaredMinor: 100000 }] }),
          migration_declare_control_total: ok({ controlId: 'migctl_1' }),
        },
        calls,
      ),
    );
    // Wait for the mount fetch to seat the existing figure.
    await screen.findByText(new RegExp(de.check.kind.trialBalanceMatchesSource));

    // Re-declaring the SAME (kind, scope) asks first and does NOT call the verb yet.
    fireEvent.change(screen.getByLabelText(de.migration.controlTotals.amount), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.controlTotals.declare }));
    expect(await screen.findByText(de.migration.controlTotals.redeclare.body)).toBeTruthy();
    expect(calls.find((c) => c.action === 'migration_declare_control_total')).toBeUndefined();

    // Accepting the confirm commits the re-declare.
    fireEvent.click(screen.getByRole('button', { name: de.migration.controlTotals.redeclare.confirm }));
    await waitFor(() => {
      expect(calls.find((c) => c.action === 'migration_declare_control_total')).toBeTruthy();
    });
  });

  it('a first declare of a brand-new (kind, scope) commits without a confirm', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_checks: ok({ checks: [] }),
          migration_declare_control_total: ok({ controlId: 'migctl_1' }),
        },
        calls,
      ),
    );
    fireEvent.change(screen.getByLabelText(de.migration.controlTotals.amount), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.controlTotals.declare }));
    await waitFor(() => {
      expect(calls.find((c) => c.action === 'migration_declare_control_total')).toBeTruthy();
    });
    expect(screen.queryByText(de.migration.controlTotals.redeclare.body)).toBeNull();
  });
});
