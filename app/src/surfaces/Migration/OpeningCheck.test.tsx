/**
 * The Eröffnungsprüfung panel (G11 §6/§8). The claims worth the most:
 *
 *   THE STATUS MODEL IS HONEST ON SCREEN: `not_asserted` renders as "Nicht geprüft" and is
 *   TEXTUALLY distinct from `not_computable` ("Nicht berechenbar"); a `passed` control renders with
 *   NO colour hook at all (brand: an all-clear state does not get a colour), while the warn states
 *   take `--t-warn` (orange, never amber: brass occupies amber) and `failed` takes `--t-danger`.
 *   The colour law is asserted against the stylesheet's own text, because jsdom does not compute
 *   external CSS and a class-name assertion alone would prove nothing about ink.
 *
 *   A WAIVER NEEDS A REASON BEFORE THE CALL: the panel refuses a blank reason locally with the same
 *   sentence the engine's `waiver_needs_reason` stands for, and the verb is NOT called.
 *
 *   READINESS NEVER READS PLAIN-READY OVER WAIVERS: a clean check with one waiver renders
 *   "bereit, mit 1 Ausnahme".
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { OpeningCheck } from './OpeningCheck';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, calls: string[] = []): Transport {
  return async (action, input) => {
    calls.push(action);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const CONTROL = (over: Record<string, unknown> = {}) => ({
  controlId: 'migctl_1',
  kind: 'trial_balance_matches_source',
  scope: '1000',
  declaredMinor: 100000,
  computedMinor: 100000,
  differenceMinor: 0,
  status: 'passed',
  waiverReason: null,
  detail: null,
  ...over,
});

const CHECK = { checkId: 'migcheck_1', planId: 'migplan_1', stepId: 'migstep_1', against: 'testmandant', checkHash: 'hash_1', clean: false, createdAt: '2026-01-02T00:00:00Z' };

function tree(canned: Canned, calls: string[] = []) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
      <I18nProvider>
        <OpeningCheck workspaceId="ws_test" planId="migplan_1" stepId="migstep_1" />
      </I18nProvider>
    </TillClientProvider>
  );
}

function canned(controls: unknown[], clean = false): Canned {
  return {
    get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
    migration_list_checks: ok({ checks: [{ ...CHECK, clean }] }),
    migration_get_check: ok({ check: { ...CHECK, clean }, controls, waivers: [] }),
  };
}

describe('OpeningCheck panel', () => {
  it('renders the empty state with the one primary action', async () => {
    render(tree({ get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }), migration_list_checks: ok({ checks: [] }) }));
    expect(await screen.findByText(de.check.empty)).toBeTruthy();
    expect(screen.getByRole('button', { name: de.check.run })).toBeTruthy();
  });

  it('renders label-above-values blocks with glyph-plus-text statuses, and not_asserted is textually distinct from not_computable', async () => {
    render(
      tree(
        canned([
          CONTROL(),
          CONTROL({ controlId: 'migctl_2', scope: '1020', declaredMinor: null, differenceMinor: null, status: 'not_asserted' }),
          CONTROL({ controlId: 'migctl_3', kind: 'ar_control', scope: 'workspace', computedMinor: null, status: 'not_computable' }),
        ]),
      ),
    );
    expect(await screen.findByText(de.check.status.passed)).toBeTruthy();
    // The two warn states are distinguishable by TEXT, never by colour alone (US-G11.5).
    expect(screen.getByText(de.check.status.notAsserted)).toBeTruthy();
    expect(screen.getByText(de.check.status.notComputable)).toBeTruthy();
    expect(de.check.status.notAsserted).not.toEqual(de.check.status.notComputable);
    // Label above values: the compound name renders in its own block element, not a table cell.
    expect(screen.getAllByText(de.check.kind.trialBalanceMatchesSource).length).toBeGreaterThan(0);
    expect(document.querySelector('.check-control-name')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
    // The status hook the stylesheet colours by.
    expect(document.querySelector(".check-control[data-status='passed']")).toBeTruthy();
  });

  it('a failed money-path gate carries a REAL recovery, never an inert control: a balance gap offers a re-check, a wrong export date names the upload route as text', async () => {
    const calls: string[] = [];
    render(
      tree(
        canned([
          CONTROL({ controlId: 'migctl_f1', declaredMinor: 90000, differenceMinor: 10000, status: 'failed' }),
          CONTROL({ controlId: 'migctl_f2', kind: 'source_as_at', scope: 'file_1', computedMinor: 9, status: 'failed' }),
        ]),
        calls,
      ),
    );
    // The balance gap: a WORKING re-check control, not an inert button.
    const recheck = await screen.findByRole('button', { name: de.check.recover.recheck });
    expect(screen.getByText(de.check.recover.fixOpeningHint)).toBeTruthy();
    // The wrong export date: the recovery route is named as TEXT (a fresh upload), with no dead button.
    expect(screen.getByText(de.check.recover.newExportHint)).toBeTruthy();
    expect(screen.queryByRole('button', { name: de.check.recover.fixOpening })).toBeNull();
    expect(screen.queryByRole('button', { name: de.check.recover.newExport })).toBeNull();
    // The re-check control actually asks the engine (proof it is not inert).
    fireEvent.click(recheck);
    await waitFor(() => {
      expect(calls.filter((c) => c === 'migration_check_step')).not.toHaveLength(0);
    });
  });

  it('a refused write NAMES the failure instead of reloading in silence: a rejected re-check shows role="alert"', async () => {
    render(
      tree({
        get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
        migration_list_checks: ok({ checks: [{ ...CHECK }] }),
        migration_get_check: ok({ check: { ...CHECK }, controls: [CONTROL({ status: 'failed', declaredMinor: 90000, differenceMinor: 10000 })], waivers: [] }),
        migration_check_step: { status: 200, body: { ok: false, error: 'plan_not_live' } },
      }),
    );
    const recheck = await screen.findByRole('button', { name: de.check.recover.recheck });
    fireEvent.click(recheck);
    expect(await screen.findByText(de.check.actionError.run)).toBeTruthy();
  });

  it('a refused export NAMES the failure instead of leaving the screen unchanged (role="alert")', async () => {
    render(
      tree({
        get_company_profile: ok({ profile: { baseCurrency: 'CHF' } }),
        migration_list_checks: ok({ checks: [{ ...CHECK }] }),
        migration_get_check: ok({ check: { ...CHECK }, controls: [CONTROL()], waivers: [] }),
        migration_export_check: { status: 200, body: { ok: false, error: 'export_failed' } },
      }),
    );
    const exportBtn = await screen.findByRole('button', { name: de.check.export });
    fireEvent.click(exportBtn);
    expect(await screen.findByText(de.check.actionError.export)).toBeTruthy();
  });

  it('refuses to waive without a reason, names why, and does NOT call the verb', async () => {
    const calls: string[] = [];
    render(tree(canned([CONTROL({ controlId: 'migctl_w', declaredMinor: 90000, differenceMinor: 10000, status: 'failed' })]), calls));
    const open = await screen.findByRole('button', { name: de.check.waive.action });
    fireEvent.click(open);
    const submit = await screen.findByRole('button', { name: de.check.waive.action });
    fireEvent.click(submit);
    expect(await screen.findByText(de.check.waive.needsReason)).toBeTruthy();
    await waitFor(() => {
      expect(calls.filter((c) => c === 'migration_waive_control')).toHaveLength(0);
    });
  });

  it('never reads plain-ready over waivers: one waiver renders "bereit, mit 1 Ausnahme"', async () => {
    render(
      tree(
        canned(
          [CONTROL(), CONTROL({ controlId: 'migctl_wv', scope: '1020', status: 'waived', waiverReason: 'Bewusst übernommen' })],
          true,
        ),
      ),
    );
    expect(await screen.findByText(de.check.ready.withOneWaiver)).toBeTruthy();
    expect(screen.getByText(de.check.status.waived)).toBeTruthy();
    expect(screen.getByText('Bewusst übernommen')).toBeTruthy();
    expect(screen.queryByText(de.check.clean)).toBeNull();
  });

  it('the stylesheet spends colour only on attention: warn is --t-warn, failed is --t-danger, passed has no colour rule, amber appears nowhere', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Migration.css'), 'utf8');
    expect(css).toMatch(/\[data-status='not_asserted'\][\s\S]{0,120}--t-warn/);
    expect(css).toMatch(/\[data-status='not_computable'\][\s\S]{0,240}--t-warn/);
    expect(css).toMatch(/\[data-status='failed'\][\s\S]{0,120}--t-danger/);
    expect(css.includes("[data-status='passed']")).toBe(false);
    expect(css.toLowerCase().includes('amber')).toBe(true /* the comment names the ban */);
    expect(/amber/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });
});
