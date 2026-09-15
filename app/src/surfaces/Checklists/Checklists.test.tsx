/**
 * G22 Checklisten, the Studio half (spec §6): the five states on the list and the detail, the journey
 * in order with the current position marked and done rows compact, the words per item kind, the
 * Start / Attest / Skip dialogs (a validation error keeps the typed value), the undeletable items
 * without a skip control, item 8 disabled with the padlock reason for an actor without `vat_file`,
 * and the JourneyStrip run prop ("exportiert am" from recorded evidence only, "bestätigt am" never a
 * done tick).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { WorkspaceProvider } from '../../app/workspace';
import { installMemoryStorage } from '../../lib/test-support';
import { Checklists } from './Checklists';
import { JourneyStrip } from '../VatReturn/JourneyStrip';
import de from './messages.de-CH.json';
import vatDe from '../VatReturn/messages.de-CH.json';
import agentDe from '../Agent/messages.de-CH.json';
import i18nDe from '../../i18n/de-CH.json';

installMemoryStorage();

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const errRes = (error: string, extra: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: false, error, ...extra } });

type Canned = Record<string, RestResponse | ((input: Record<string, unknown>) => RestResponse)>;

function fakeTransport(canned: Canned, calls: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const hit = canned[action];
    if (hit === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof hit === 'function' ? hit((input ?? {}) as Record<string, unknown>) : hit;
  };
}

function caps(held: string[]): Capabilities {
  return { whoami: null, can: (c) => held.includes(c), refresh: () => undefined };
}

const ALL = ['read_books', 'manage_checklists', 'vat_file'];

function tree(canned: Canned, opts: { held?: string[]; path?: string; calls?: Array<{ action: string; input: Record<string, unknown> }> } = {}) {
  const calls = opts.calls ?? [];
  return (
    <MemoryRouter initialEntries={[opts.path ?? '/checklisten']}>
      <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
        <I18nProvider>
          <CapabilitiesContext.Provider value={caps(opts.held ?? ALL)}>
            <WorkspaceProvider initialId="ws_1">
              <Checklists />
            </WorkspaceProvider>
          </CapabilitiesContext.Provider>
        </I18nProvider>
      </TillClientProvider>
    </MemoryRouter>
  );
}

function item(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runItemId: `ri_${String(overrides.itemId)}`,
    title: String(overrides.itemId),
    ownerKind: 'human',
    evidenceKind: 'signoff',
    check: null,
    precondition: null,
    verb: null,
    deepLink: null,
    signoffKind: null,
    requiresEvidenceRef: false,
    prerequisiteItemIds: [],
    dueAt: '2026-08-29',
    undeletable: false,
    status: 'open',
    storedStatus: 'open',
    stale: false,
    blockedBy: null,
    checkResult: null,
    preconditionResult: null,
    completedBy: null,
    completedByKind: null,
    completedByName: null,
    completedAt: null,
    evidence: null,
    signoff: null,
    skipReason: null,
    skippedBy: null,
    skippedAt: null,
    ...overrides,
  };
}

/** A run mid-journey: 1 to 3 fulfilled, 4 done by the agent, 5 signed, 6 exported, 7 next (attest). */
const RUN = {
  runId: 'r1',
  templateId: 'vat_period',
  templateLabel: 'MWST-Periode',
  kind: 'vat_period',
  periodLabel: '2026-Q2',
  periodStart: '2026-04-01',
  periodEnd: '2026-06-30',
  status: 'open',
  abandonReason: null,
  nextItemId: 'eportal_filed',
  openCount: 3,
  doneCount: 6,
  skippedCount: 0,
  itemCount: 9,
  items: [
    item({ itemId: 'no_drafts', position: 1, ownerKind: 'system', evidenceKind: 'check', check: 'no_drafts', status: 'done', dueAt: '2026-07-30', checkResult: { key: 'no_drafts', passed: true, count: 0 }, deepLink: '/journal' }),
    item({ itemId: 'bank_reconciled', position: 2, ownerKind: 'system', evidenceKind: 'check', check: 'bank_reconciled', status: 'done', dueAt: '2026-07-30', checkResult: { key: 'bank_reconciled', passed: true, count: 0 } }),
    item({ itemId: 'tax_codes_complete', position: 3, ownerKind: 'system', evidenceKind: 'check', check: 'no_missing_tax_codes', status: 'done', dueAt: '2026-07-30', checkResult: { key: 'no_missing_tax_codes', passed: true, count: 0 } }),
    item({ itemId: 'vat_return_computed', position: 4, ownerKind: 'agent', evidenceKind: 'verb_result', verb: 'vat_return', status: 'done', storedStatus: 'done', dueAt: '2026-07-30', undeletable: true, completedBy: 'agent', completedByKind: 'agent', completedAt: '2026-07-10T10:00:00.000Z', evidence: { kind: 'verb_result', ref: 'vat_return:abc' } }),
    item({ itemId: 'abstimmung_reviewed', position: 5, evidenceKind: 'signoff', signoffKind: 'abstimmung_reviewed', precondition: 'abstimmung_resolved', status: 'done', storedStatus: 'done', dueAt: '2026-08-14', preconditionResult: { key: 'abstimmung_resolved', passed: true, count: 0 }, signoff: { signoffId: 's1', kind: 'abstimmung_reviewed', actor: 'studio', actorKind: 'studio', actorName: null, evidenceRef: 'vat_return:abc', hash: 'abc', createdAt: '2026-07-11T10:00:00.000Z', stale: false } }),
    item({ itemId: 'ech0217_exported', position: 6, ownerKind: 'agent', evidenceKind: 'verb_result', verb: 'vat_export_ech0217', status: 'done', storedStatus: 'done', dueAt: '2026-08-24', completedBy: 'agent', completedByKind: 'agent', completedAt: '2026-07-12T10:00:00.000Z', evidence: { kind: 'verb_result', ref: 'ech0217:file.xml:abc' } }),
    item({ itemId: 'eportal_filed', position: 7, evidenceKind: 'filed_attestation', signoffKind: 'filed_attestation', prerequisiteItemIds: ['ech0217_exported'], deepLink: '/mwst' }),
    item({ itemId: 'period_locked', position: 8, evidenceKind: 'check', check: 'period_locked_vat_filed', verb: 'vat_mark_filed', prerequisiteItemIds: ['eportal_filed'], blockedBy: 'eportal_filed', undeletable: true, checkResult: { key: 'period_locked_vat_filed', passed: false, count: null } }),
    item({ itemId: 'settlement_booked', position: 9, evidenceKind: 'signoff', signoffKind: 'settlement_booked', requiresEvidenceRef: true, prerequisiteItemIds: ['period_locked'], blockedBy: 'period_locked', undeletable: true, deepLink: '/reconciliation' }),
  ],
};

const LIST = {
  runs: [
    { runId: 'r1', templateId: 'vat_period', templateLabel: 'MWST-Periode', kind: 'vat_period', periodLabel: '2026-Q2', periodStart: '2026-04-01', periodEnd: '2026-06-30', status: 'open', nextItemId: 'eportal_filed', openCount: 3, doneCount: 6, skippedCount: 0, itemCount: 9, createdAt: '2026-07-01T00:00:00.000Z', abandonedAt: null },
    { runId: 'r0', templateId: 'vat_period', templateLabel: 'MWST-Periode', kind: 'vat_period', periodLabel: '2026-Q1', periodStart: '2026-01-01', periodEnd: '2026-03-31', status: 'done', nextItemId: null, openCount: 0, doneCount: 9, skippedCount: 0, itemCount: 9, createdAt: '2026-04-01T00:00:00.000Z', abandonedAt: null },
  ],
};

const PERIODS = (year: string): RestResponse =>
  ok({
    method: 'effektiv',
    year,
    periods: [1, 2, 3, 4].map((n) => ({
      label: `${year}-Q${n}`,
      periodStart: `${year}-${String((n - 1) * 3 + 1).padStart(2, '0')}-01`,
      periodEnd: `${year}-${String(n * 3).padStart(2, '0')}-${n === 1 || n === 4 ? '31' : '30'}`,
      months: [],
      filed: false,
    })),
  });

describe('Checklists list', () => {
  it('loading: a skeleton with a live status, then the open and done groups', async () => {
    // The request counter is the proof the read went in flight (loading-state-convention, form 2).
    let listRequests = 0;
    render(
      tree({
        checklist_list: () => {
          listRequests += 1;
          return ok(LIST);
        },
      }),
    );
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    await waitFor(() => expect(listRequests).toBe(1));
    expect(await screen.findByText('MWST-Periode Q2/2026')).toBeTruthy();
    expect(screen.getByText(de.checklists.group.open.replace('{count}', '1'))).toBeTruthy();
    // Done runs collapse into one group.
    const done = screen.getByText(de.checklists.group.done.replace('{count}', '1'));
    expect(done.closest('details')).toBeTruthy();
    expect(screen.getByText('6 von 9 Schritten')).toBeTruthy();
  });

  it('empty: names the period kind, never the literal Quartal, and offers the start', async () => {
    render(tree({ checklist_list: ok({ runs: [] }) }));
    expect(await screen.findByText(de.checklists.empty.title)).toBeTruthy();
    expect(screen.getByText(/Starte die MWST-Periode oder den Monatsabschluss/)).toBeTruthy();
    expect(de.checklists.empty.hint).not.toMatch(/Quartal/);
    expect(screen.getAllByRole('button', { name: de.checklists.start.action }).length).toBeGreaterThan(0);
  });

  it('permission-denied: the padlock names read_books', async () => {
    render(tree({ checklist_list: errRes('permission_denied') }));
    expect(await screen.findByText(de.checklists.denied.read)).toBeTruthy();
  });

  it('error: the banner with a retry that re-reads', async () => {
    let n = 0;
    render(tree({ checklist_list: () => (n++ === 0 ? { status: 500, body: { ok: false, error: 'boom' } } : ok(LIST)) }));
    expect(await screen.findByText(de.checklists.error.transport)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(await screen.findByText('MWST-Periode Q2/2026')).toBeTruthy();
  });

  it('without manage_checklists the start button is absent (hide, never show-then-reject)', async () => {
    render(tree({ checklist_list: ok(LIST) }, { held: ['read_books'] }));
    await screen.findByText('MWST-Periode Q2/2026');
    expect(screen.queryByRole('button', { name: de.checklists.start.action })).toBeNull();
  });

  it('start: the dialog proposes the last ended period, calls checklist_start and lands on the run; a refusal stays inline', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let started = false;
    render(
      tree(
        {
          checklist_list: ok({ runs: [] }),
          vat_periods: (input) => PERIODS(String(input.year)),
          checklist_start: (input) => {
            if (input.period === '2026-Q9') return errRes('period_not_filable', { periods: ['2026-Q1', '2026-Q2'] });
            started = true;
            return ok(RUN);
          },
          checklist_get: ok(RUN),
        },
        { calls },
      ),
    );
    // The header primary and the empty state's first step both start; the header one is the surface's.
    fireEvent.click((await screen.findAllByRole('button', { name: de.checklists.start.action }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(de.checklists.start.consequence.vat_period)).toBeTruthy();
    // The template radio: the MWST-Periode is pre-selected, the two close templates beside it.
    expect((within(dialog).getByRole('radio', { name: new RegExp(de.checklists.template.vat_period) }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole('radio', { name: new RegExp(de.checklists.template.year_close) })).toBeTruthy();
    const select = within(dialog).getByLabelText(de.checklists.start.period.vat_period) as HTMLSelectElement;
    // The last ENDED period is pre-filled: with today far past 2026, that is the latest option.
    expect(select.value).toMatch(/^\d{4}-Q[1-4]$/);
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.start.action }));
    await waitFor(() => expect(started).toBe(true));
    const start = calls.find((c) => c.action === 'checklist_start');
    expect(start?.input.templateId).toBe('vat_period');
    expect(typeof start?.input.idempotencyKey).toBe('string');
    // Landed on the run detail.
    expect(await screen.findByText(/Q2\/2026, /)).toBeTruthy();
  });
});

describe('Checklists detail', () => {
  it('renders the whole journey in order, the current position marked, done rows compact with the words per kind', async () => {
    render(tree({ checklist_get: ok(RUN) }, { path: '/checklisten?run=r1' }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const rows = within(journey).getAllByRole('listitem');
    expect(rows.length).toBe(9);
    expect(rows.map((r) => r.getAttribute('data-item'))).toEqual(RUN.items.map((i) => i.itemId));
    const current = rows.find((r) => r.getAttribute('aria-current') === 'step');
    expect(current?.getAttribute('data-item')).toBe('eportal_filed');
    // Done rows are compact, one line each, never collapsed away.
    expect(rows[0]?.className).toContain('runbook-item--compact');
    expect(within(rows[0] as HTMLElement).getByText(de.checklists.state.fulfilled)).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText(/erledigt am .* durch den Agenten/)).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText(/freigegeben am .* durch dich/)).toBeTruthy();
    // The check key is a tooltip, never on-screen text.
    expect(within(rows[0] as HTMLElement).queryByText('no_drafts')).toBeNull();
    // The next item carries the single primary action.
    const primary = within(current as HTMLElement).getByRole('button', { name: de.checklists.act.attest });
    expect(primary.className).toContain('btn--primary');
    expect(within(journey).getAllByRole('button', { name: de.checklists.act.attest }).length).toBe(1);
  });

  it('undeletable items carry no skip control; item 8 is disabled with the padlock reason without vat_file', async () => {
    render(tree({ checklist_get: ok(RUN) }, { path: '/checklisten?run=r1', held: ['read_books', 'manage_checklists'] }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const rows = within(journey).getAllByRole('listitem');
    const lock = rows[7] as HTMLElement;
    const mark = within(lock).getByRole('button', { name: de.checklists.act.markFiled }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    expect(within(lock).getByText(de.checklists.needsFile)).toBeTruthy();
    expect(within(lock).queryByRole('button', { name: de.checklists.act.skip })).toBeNull();
    const payment = rows[8] as HTMLElement;
    expect(within(payment).queryByRole('button', { name: de.checklists.act.skip })).toBeNull();
    // A deletable open item has one.
    const attest = rows[6] as HTMLElement;
    expect(within(attest).getByRole('button', { name: de.checklists.act.skip })).toBeTruthy();
  });

  it('item 8 is disabled while item 7 is open, the "Wartet auf" note as its reason; once attested it links to /mwst', async () => {
    render(tree({ checklist_get: ok(RUN) }, { path: '/checklisten?run=r1' }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const lock = within(journey).getAllByRole('listitem')[7] as HTMLElement;
    const mark = within(lock).getByRole('button', { name: de.checklists.act.markFiled }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    const reasonId = mark.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId as string);
    expect(reason?.textContent).toBe(de.checklists.note.blockedBy.replace('{item}', de.checklists.item.eportal_filed));
    expect(within(lock).queryByRole('link', { name: de.checklists.act.markFiled })).toBeNull();
    cleanup();

    // Item 7 attested: the prerequisite is met and item 8 carries the live link.
    const attested = {
      ...RUN,
      nextItemId: 'period_locked',
      items: RUN.items.map((i) =>
        i.itemId === 'eportal_filed'
          ? { ...i, status: 'done', storedStatus: 'done', signoff: { signoffId: 's7', kind: 'filed_attestation', actor: 'studio', actorKind: 'studio', actorName: null, evidenceRef: '2026-07-20', hash: null, createdAt: '2026-07-20T10:00:00.000Z', stale: false } }
          : i.itemId === 'period_locked'
            ? { ...i, blockedBy: null }
            : i,
      ),
    };
    render(tree({ checklist_get: ok(attested) }, { path: '/checklisten?run=r1' }));
    const journey2 = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const lock2 = within(journey2).getAllByRole('listitem')[7] as HTMLElement;
    expect(within(lock2).getByRole('link', { name: de.checklists.act.markFiled }).getAttribute('href')).toBe('/mwst');
    expect(within(lock2).queryByRole('button', { name: de.checklists.act.markFiled })).toBeNull();
  });

  it('attest: a date before the export keeps the typed value and refuses; a valid date calls checklist_item_complete with the attestation', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ checklist_get: ok(RUN), checklist_item_complete: ok({ runId: 'r1', itemId: 'eportal_filed', alreadyDone: false, item: RUN.items[6] }) }, { path: '/checklisten?run=r1', calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    fireEvent.click(within(journey).getByRole('button', { name: de.checklists.act.attest }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(de.checklists.attest.consequence)).toBeTruthy();
    const date = within(dialog).getByLabelText(de.checklists.attest.date) as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-07-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.attest.action }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(date.value).toBe('2026-07-01');
    expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(false);
    fireEvent.change(date, { target: { value: '2026-07-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.attest.action }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(true));
    const call = calls.find((c) => c.action === 'checklist_item_complete');
    expect(call?.input.itemId).toBe('eportal_filed');
    expect(call?.input.evidence).toEqual({ kind: 'filed_attestation', ref: '2026-07-20' });
  });

  it('skip: needs a reason, then calls checklist_item_skip with it', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ checklist_get: ok(RUN), checklist_item_skip: ok({ runId: 'r1', itemId: 'eportal_filed', item: RUN.items[6] }) }, { path: '/checklisten?run=r1', calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const attest = within(journey).getAllByRole('listitem')[6] as HTMLElement;
    fireEvent.click(within(attest).getByRole('button', { name: de.checklists.act.skip }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(de.checklists.skip.consequence)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.skip.action }));
    expect(await within(dialog).findByText(de.checklists.reason.needed)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(de.checklists.skip.reason), { target: { value: 'Von Hand erfasst.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.skip.action }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_skip')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_item_skip')?.input.reason).toBe('Von Hand erfasst.');
  });

  it('detail states: denied, error with retry, and a missing run', async () => {
    render(tree({ checklist_get: errRes('permission_denied') }, { path: '/checklisten?run=r1' }));
    expect(await screen.findByText(de.checklists.denied.read)).toBeTruthy();
    render(tree({ checklist_get: errRes('not_found') }, { path: '/checklisten?run=nope' }));
    expect(await screen.findByText(de.checklists.missing.title)).toBeTruthy();
    render(tree({ checklist_get: { status: 500, body: { ok: false, error: 'boom' } } }, { path: '/checklisten?run=r1' }));
    expect(await screen.findByText(de.checklists.error.transport)).toBeTruthy();
  });

  it('a stale sign-off reads "Freigabe hinfällig" and the row says why', async () => {
    const stale = {
      ...RUN,
      nextItemId: 'abstimmung_reviewed',
      items: RUN.items.map((i) => (i.itemId === 'abstimmung_reviewed' ? { ...i, status: 'open', stale: true, signoff: { ...(i.signoff as Record<string, unknown>), stale: true } } : i)),
    };
    render(tree({ checklist_get: ok(stale) }, { path: '/checklisten?run=r1' }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[4] as HTMLElement;
    expect(within(row).getByText(de.checklists.state.stale)).toBeTruthy();
    expect(within(row).getByText(de.checklists.note.stale)).toBeTruthy();
    expect(row.getAttribute('data-stale')).toBe('true');
  });
});

describe('JourneyStrip with a run', () => {
  const strip = (run: { runId: string; exportedAt: string | null; attestedAt: string | null; attestedBy: { kind: string; name: string | null } | null } | null) =>
    render(
      <MemoryRouter>
        <I18nProvider>
          <JourneyStrip computed checked marked={false} run={run} />
        </I18nProvider>
      </MemoryRouter>,
    );

  it('step 3 reads "exportiert am" only from recorded evidence, step 4 "bestätigt am ... durch <actor>" and never the done word', () => {
    strip({ runId: 'r1', exportedAt: '2026-07-12', attestedAt: '2026-07-20', attestedBy: { kind: 'agent', name: null } });
    const items = screen.getAllByRole('listitem');
    expect(items[2]?.textContent).toContain('exportiert am');
    expect(items[2]?.className).toContain('vr-step--done');
    // Spec §6: the strip names the actor the way the run detail does (finding 5).
    expect(items[3]?.textContent).toContain('bestätigt am 20.07.2026 durch den Agenten');
    expect(items[3]?.textContent).not.toContain(vatDe.vat.return.journey.done);
    expect(items[3]?.className).not.toContain('vr-step--done');
    expect(screen.getByRole('link', { name: vatDe.vat.return.journey.openRun }).getAttribute('href')).toBe('/checklisten?run=r1');
  });

  it('the attesting actor resolves like the run detail: a member by name, the studio seat as "dich", an unknown seat as "jemanden"', () => {
    strip({ runId: 'r1', exportedAt: '2026-07-12', attestedAt: '2026-07-20', attestedBy: { kind: 'member', name: 'Nina Meier' } });
    expect(screen.getAllByRole('listitem')[3]?.textContent).toContain('bestätigt am 20.07.2026 durch Nina Meier');
    cleanup();
    strip({ runId: 'r1', exportedAt: '2026-07-12', attestedAt: '2026-07-20', attestedBy: { kind: 'studio', name: null } });
    expect(screen.getAllByRole('listitem')[3]?.textContent).toContain('bestätigt am 20.07.2026 durch dich');
    cleanup();
    strip({ runId: 'r1', exportedAt: '2026-07-12', attestedAt: '2026-07-20', attestedBy: null });
    expect(screen.getAllByRole('listitem')[3]?.textContent).toContain('bestätigt am 20.07.2026 durch jemanden');
  });

  it('without a run, steps 3 and 4 stay undone and no checklist link renders (the pre-G22 strip)', () => {
    strip(null);
    const items = screen.getAllByRole('listitem');
    expect(items[2]?.className).not.toContain('vr-step--done');
    expect(items[3]?.textContent).not.toContain('bestätigt am');
    expect(screen.queryByRole('link', { name: vatDe.vat.return.journey.openRun })).toBeNull();
  });
});

// --- Leg 2 (D129, design A): the guided close rows -------------------------------------------------

/** A year_close run mid-journey: the choices derived, the accruals pair open, the seal held by a block. */
function yearRun(overrides: Record<string, unknown> = {}) {
  const choice = (itemId: string, position: number, answer: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    item({
      itemId,
      position,
      ownerKind: 'system',
      evidenceKind: 'choice',
      status: answer === null ? 'open' : 'done',
      dueAt: null,
      options: [
        { id: 'yes', labelKey: 'checklists.choice.yes', consequenceKey: 'checklists.choice.yes.consequence' },
        { id: 'no', labelKey: 'checklists.choice.no', consequenceKey: 'checklists.choice.no.consequence' },
      ],
      choice: answer,
      ...extra,
    });
  return {
    runId: 'y1',
    templateId: 'year_close',
    templateLabel: 'Jahresabschluss',
    kind: 'year_close',
    periodKind: 'year',
    periodLabel: '2026',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    status: 'open',
    createdBy: 'studio',
    createdAt: '2027-02-15T09:00:00.000Z',
    abandonReason: null,
    nextItemId: 'accruals_needed',
    openCount: 6,
    doneCount: 2,
    skippedCount: 0,
    excludedCount: 0,
    itemCount: 8,
    anchorHash: 'abcdef0123456789',
    items: [
      choice('legal_form', 1, { optionId: 'gmbh', source: 'derived' }, {
        options: [
          { id: 'einzelfirma', labelKey: 'checklists.choice.legalForm.einzelfirma', consequenceKey: 'checklists.choice.legalForm.einzelfirma.consequence' },
          { id: 'gmbh', labelKey: 'checklists.choice.legalForm.gmbh', consequenceKey: 'checklists.choice.legalForm.gmbh.consequence' },
          { id: 'ag', labelKey: 'checklists.choice.legalForm.ag', consequenceKey: 'checklists.choice.legalForm.ag.consequence' },
        ],
      }),
      choice('has_fc_positions', 2, { optionId: 'no', source: 'derived' }),
      item({ itemId: 'fx_preview', position: 3, evidenceKind: 'preview', verb: 'fx_revaluation', status: 'excluded', excludedBy: { itemId: 'has_fc_positions', optionId: 'no' }, dueAt: null }),
      choice('accruals_needed', 4, null, { ownerKind: 'human', defaultOptionId: 'no' }),
      item({
        itemId: 'accruals_preview',
        position: 5,
        evidenceKind: 'preview',
        verb: 'accrual_list',
        verbInput: 'periodEnd',
        verbInputValue: '2026-12-31',
        previewOf: null,
        deepLink: '/periods',
        prerequisiteItemIds: ['accruals_needed'],
        previewResult: {
          ok: true,
          hash: 'feedface',
          error: null,
          empty: false,
          postedBelow: false,
          payload: { accruals: [{ id: 'acc_1', kind: 'accrued_expense', description: 'Strom Dezember', contraAccountNumber: '6500', balanceAccountNumber: '2300', amountMinor: 180000, reversalDate: '2027-01-01', status: 'draft' }], totalMinor: 180000, baseCurrency: 'CHF' },
        },
      }),
      item({
        itemId: 'accruals_posted',
        position: 6,
        evidenceKind: 'posting',
        verb: 'accrual_post',
        reverseVerb: 'accrual_reverse',
        verbInput: 'periodEnd',
        verbInputValue: '2026-12-31',
        probe: 'accruals_posted',
        previewOf: 'accruals_preview',
        prerequisiteItemIds: ['accruals_preview'],
        deepLink: '/periods',
        probeResult: { key: 'accruals_posted', found: false, entryIds: [], reversalDate: null, detail: { periodEnd: '2026-12-31', draftIds: ['acc_1'], postedIds: [], reversedIds: [] } },
      }),
      item({
        itemId: 'prior_year_comparison',
        position: 7,
        ownerKind: 'system',
        evidenceKind: 'validation',
        validation: 'prior_year_comparison',
        severity: 'warn',
        fixLink: '/reports',
        validationResult: { key: 'prior_year_comparison', result: 'fail', formula: 'checklists.validation.prior_year_comparison.formula', figures: { flagged: ['6500'], differenceMinor: 700000 }, explanation: '1 account moved beyond both bands: 6500', reason: null, hash: 'h-prior' },
      }),
      item({
        itemId: 'year_sealed',
        position: 8,
        evidenceKind: 'posting',
        verb: 'close_year',
        verbInput: 'year',
        verbInputValue: '2026',
        probe: 'seal_on_year',
        undeletable: true,
        deepLink: '/periods',
        prerequisiteItemIds: ['statements_signed', 'accruals_posted'],
        blockedBy: 'accruals_posted',
        probeResult: { key: 'seal_on_year', found: false, entryIds: [], reversalDate: null, detail: {} },
      }),
    ],
    ...overrides,
  };
}

const ALL_RIGHTS = ['read_books', 'manage_checklists', 'vat_file', 'post', 'manage_periods'];

describe('Checklists, the guided close (leg 2)', () => {
  it('the choice row: options with their consequence, the derived answer named, "Antwort speichern" sends the choice evidence', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ checklist_get: ok(yearRun()), checklist_item_complete: ok({ runId: 'y1', itemId: 'legal_form' }) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const rows = within(journey).getAllByRole('listitem');
    // The next item (accruals_needed) opens by itself and carries the single primary action.
    const next = rows[3] as HTMLElement;
    expect(next.getAttribute('aria-current')).toBe('step');
    expect(next.getAttribute('data-expanded')).toBe('true');
    expect(within(next).getByText(de.checklists.choice.preselected)).toBeTruthy();
    expect(within(next).getByText(de.checklists.choiceConsequence.yes)).toBeTruthy();
    const save = within(next).getByRole('button', { name: de.checklists.act.answer }) as HTMLButtonElement;
    expect(save.className).toContain('btn--primary');
    expect((within(next).getByRole('radio', { name: new RegExp(`^${de.checklists.choice.no}`) }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(true));
    const sent = calls.find((c) => c.action === 'checklist_item_complete');
    expect(sent?.input).toMatchObject({ runId: 'y1', itemId: 'accruals_needed', evidence: { kind: 'choice', ref: 'no' } });
    // An excluded row folds under its choice with the reason, and is never collapsed away.
    const excluded = rows[2] as HTMLElement;
    expect(excluded.getAttribute('data-status')).toBe('excluded');
    expect(within(excluded).getByText(de.checklists.state.excluded)).toBeTruthy();
    expect(within(excluded).getByText(/Entfällt wegen der Antwort bei/)).toBeTruthy();
    // The derived choice on a done row can be re-answered: it opens on "Details".
    const legal = rows[0] as HTMLElement;
    expect(within(legal).getByText(de.checklists.state.derived)).toBeTruthy();
  });

  it('the preview row: the draft table with a total, the provenance line, and "Vorschau geprüft" completes without evidence', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const run = yearRun({ nextItemId: 'accruals_preview' });
    render(tree({ checklist_get: ok(run), checklist_item_complete: ok({}) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[4] as HTMLElement;
    expect(within(row).getByText('Strom Dezember')).toBeTruthy();
    expect(within(row).getAllByText(/CHF 1'800\.00/).length).toBeGreaterThan(0);
    expect(within(row).getByText(/Prüfsumme feedface/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: de.checklists.act.seen }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_item_complete')?.input).toMatchObject({ itemId: 'accruals_preview' });
    expect(calls.find((c) => c.action === 'checklist_item_complete')?.input.evidence).toBeUndefined();
  });

  it('the posting row: the domain verb behind an alert confirm with the dial sentence, one call per draft, the re-read afterwards; a refusal lands on the row', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let posted = false;
    const run = yearRun({ nextItemId: 'accruals_posted' });
    render(
      tree(
        {
          checklist_get: () => ok(posted ? { ...run, items: run.items.map((i) => (i.itemId === 'accruals_posted' ? { ...i, status: 'done', probeResult: { key: 'accruals_posted', found: true, entryIds: ['je_1', 'je_2'], reversalDate: '2027-01-01', detail: { postedIds: ['acc_1'], draftIds: [] } } } : i)) } : run),
          accrual_post: () => {
            posted = true;
            return ok({ entryId: 'je_1', reversalEntryId: 'je_2' });
          },
          accrual_reverse: errRes('period_locked', { period: '2026-12' }),
        },
        { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls },
      ),
    );
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[5] as HTMLElement;
    expect(within(row).getByText(/Zu buchen: CHF 1'800\.00/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Abgrenzungen buchen (1)' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/Bucht 1 Entwürfe mit total CHF 1'800\.00/)).toBeTruthy();
    // The consequence is the ENGINE's dial sentence for the post family (D118 C4), never authored here.
    expect(within(confirm).getByText(agentDe.agent.consequence.post)).toBeTruthy();
    expect(calls.some((c) => c.action === 'accrual_post')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: i18nDe.agent.verb.accrual_post }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'accrual_post').length).toBe(1));
    expect(calls.find((c) => c.action === 'accrual_post')?.input).toMatchObject({ workspaceId: 'ws_1', accrualId: 'acc_1' });
    // The re-read shows the row posted with its entries and the reversal date, and offers the undo through the owner verb.
    const rows2 = await within(await screen.findByRole('list', { name: de.checklists.detail.journey })).findAllByRole('listitem');
    const done = rows2[5] as HTMLElement;
    await waitFor(() => expect(within(done).getByText(de.checklists.state.posted)).toBeTruthy());
    expect(within(done).getByText(/Belege: je_1, je_2/)).toBeTruthy();
    fireEvent.click(within(done).getByRole('button', { name: de.checklists.act.undo }));
    const undo = await screen.findByRole('alertdialog');
    fireEvent.click(within(undo).getByRole('button', { name: i18nDe.agent.verb.accrual_reverse }));
    await waitFor(() => expect(calls.some((c) => c.action === 'accrual_reverse')).toBe(true));
    expect(await screen.findByText(de.checklists.error.refused.replace('{code}', 'period_locked'))).toBeTruthy();
  });

  it('the validation warn row: the result word, the figures, the formula behind a disclosure, and "Zur Kenntnis nehmen" records a hash-bound sign-off with a reason', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const run = yearRun({ nextItemId: 'prior_year_comparison' });
    render(tree({ checklist_get: ok(run), checklist_item_complete: ok({}) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[6] as HTMLElement;
    expect(row.querySelector('.runbook-item-status')?.textContent).toBe(de.checklists.state.warn);
    expect(row.querySelector('.chk-validation-word')?.textContent).toContain(de.checklists.validation.warnHint);
    expect(within(row).getByText(/Auffällig: 6500/)).toBeTruthy();
    expect(within(row).getByText(de.checklists.formula.prior_year_comparison)).toBeTruthy();
    expect(within(row).getByRole('link', { name: de.checklists.act.fix }).getAttribute('href')).toBe('/reports');
    fireEvent.click(within(row).getByRole('button', { name: de.checklists.act.acknowledge }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(de.checklists.acknowledge.consequence)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(de.checklists.acknowledge.reason), { target: { value: 'Umsatzsprung durch neuen Kunden.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.act.acknowledge }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_item_complete')?.input).toMatchObject({ itemId: 'prior_year_comparison', evidence: { kind: 'signoff', ref: 'Umsatzsprung durch neuen Kunden.' } });
    // The header counts the note apart from the blockers.
    expect(screen.getByText(/Blocker: 0, Hinweise: 1/)).toBeTruthy();
  });

  it('the seal row: the consequence sentence is the Vorschlag card\'s, the button is disabled with the blocking row as its reason, and the confirm repeats the sentence once unblocked', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const blocked = yearRun({ nextItemId: 'accruals_posted' });
    render(tree({ checklist_get: ok(blocked) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const seal = within(journey).getAllByRole('listitem')[7] as HTMLElement;
    expect(within(seal).getByText(de.checklists.note.blockedBy.replace('{item}', de.checklists.item.accruals_posted))).toBeTruthy();
    // Deadline word: the seal's date is a statutory rule (Art. 699 Abs. 2 OR), so the row says Frist.
    expect(within(seal).queryByRole('button', { name: de.checklists.act.skip })).toBeNull();
    fireEvent.click(within(seal).getByRole('button', { name: de.checklists.act.details }));
    expect(within(seal).getByText(agentDe.agent.consequenceVerb.close_year)).toBeTruthy();
    const button = within(seal).getByRole('button', { name: de.checklists.act.seal }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby') as string)?.textContent).toContain(de.checklists.item.accruals_posted);
    cleanup();

    const free = yearRun({ nextItemId: 'year_sealed', items: yearRun().items.map((i) => (i.itemId === 'year_sealed' ? { ...i, blockedBy: null } : i)) });
    render(tree({ checklist_get: ok(free), close_year: ok({ closingEntryId: 'je_close' }) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls }));
    const journey2 = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const seal2 = within(journey2).getAllByRole('listitem')[7] as HTMLElement;
    const live = within(seal2).getByRole('button', { name: de.checklists.act.seal }) as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    expect(live.className).toContain('btn--primary');
    fireEvent.click(live);
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(agentDe.agent.consequenceVerb.close_year)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: i18nDe.agent.verb.close_year }));
    await waitFor(() => expect(calls.some((c) => c.action === 'close_year')).toBe(true));
    expect(calls.find((c) => c.action === 'close_year')?.input).toMatchObject({ workspaceId: 'ws_1', year: '2026' });
  });

  it('without post the posting verb is disabled with the padlock reason, never hidden', async () => {
    const run = yearRun({ nextItemId: 'accruals_posted' });
    render(tree({ checklist_get: ok(run) }, { path: '/checklisten?run=y1', held: ['read_books', 'manage_checklists'] }));
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[5] as HTMLElement;
    const button = within(row).getByRole('button', { name: 'Abgrenzungen buchen (1)' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(row).getByText(de.checklists.needsPost)).toBeTruthy();
  });

  it('the statements sign-off row loads the A08 totals, names the hash it binds, and releases with the statements_signoff evidence kind', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const run = yearRun({
      nextItemId: 'statements_signed',
      items: [
        ...yearRun().items.filter((i) => i.itemId !== 'year_sealed'),
        item({ itemId: 'statements_signed', position: 8, evidenceKind: 'signoff', signoffKind: 'statements_signoff', undeletable: true, deepLink: '/reports' }),
      ],
    });
    render(
      tree(
        {
          checklist_get: ok(run),
          balance_sheet: ok({ asOf: '2026-12-31', baseCurrency: 'CHF', sections: [], aktivenMinor: 12345600, passivenMinor: 12345600 }),
          income_statement: ok({ period: { start: '2026-01-01', end: '2026-12-31' }, baseCurrency: 'CHF', sections: [], reingewinnMinor: 250000 }),
          checklist_item_complete: ok({}),
        },
        { path: '/checklisten?run=y1', held: ALL_RIGHTS, calls },
      ),
    );
    const journey = await screen.findByRole('list', { name: de.checklists.detail.journey });
    const row = within(journey).getAllByRole('listitem')[7] as HTMLElement;
    expect((await within(row).findAllByText(/CHF 123'456\.00/)).length).toBe(2);
    expect(within(row).getByText(/CHF 2'500\.00/)).toBeTruthy();
    expect(within(row).getByText(/Stand abcdef01\./)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: de.checklists.act.release }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(de.checklists.release.consequence)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.signoff.action }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_item_complete')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_item_complete')?.input).toMatchObject({ itemId: 'statements_signed', evidence: { kind: 'statements_signoff' } });
  });

  it('an auto-started run says so in its provenance line with the rule and links to /automations; the list row carries the word', async () => {
    const auto = yearRun({ templateId: 'month_close', templateLabel: 'Monatsabschluss', periodKind: 'month', periodLabel: '2026-06', createdBy: 'builtin:checklist_autostart:month_close:ws_1', createdAt: '2026-07-01T03:00:00.000Z' });
    render(tree({ checklist_get: ok(auto) }, { path: '/checklisten?run=y1', held: ALL_RIGHTS }));
    const line = await screen.findByTestId('chk-provenance');
    expect(line.textContent).toContain('Automatisch gestartet durch die Regel «Monatsabschluss automatisch starten» am 01.07.2026.');
    expect(within(line).getByRole('link', { name: de.checklists.detail.automations }).getAttribute('href')).toBe('/automations');
    expect(screen.getByText(/06\/2026, /)).toBeTruthy();
    cleanup();
    render(tree({ checklist_list: ok({ runs: [{ ...LIST.runs[0], createdBy: 'builtin:checklist_autostart:vat_period:ws_1' }] }) }, { held: ALL_RIGHTS }));
    expect(await screen.findByText(de.checklists.run.auto)).toBeTruthy();
  });

  it('the Start dialog offers the month and the year with locally derived ended periods and sends the picked template', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(tree({ checklist_list: ok({ runs: [] }), vat_periods: (input) => PERIODS(String(input.year)), checklist_start: errRes('year_close_in_progress', { yearRunId: 'y9' }) }, { held: ALL_RIGHTS, calls }));
    fireEvent.click((await screen.findAllByRole('button', { name: de.checklists.start.action }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(de.checklists.template.month_close) }));
    const months = within(dialog).getByLabelText(de.checklists.start.period.month_close) as HTMLSelectElement;
    expect(months.options.length).toBe(6);
    expect(months.value).toMatch(/^\d{4}-\d{2}$/);
    expect(within(dialog).getByText(de.checklists.start.consequence.month_close)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: de.checklists.start.action }));
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_start')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_start')?.input.templateId).toBe('month_close');
    // The December rule's refusal stays inline and links to the year run.
    expect(await within(dialog).findByText(de.checklists.start.yearInProgress)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: de.checklists.start.yearInProgressCta }).getAttribute('href')).toBe('/checklisten?run=y9');
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(de.checklists.template.year_close) }));
    const years = within(dialog).getByLabelText(de.checklists.start.period.year_close) as HTMLSelectElement;
    expect(years.options.length).toBe(3);
    expect(years.value).toMatch(/^\d{4}$/);
  });
});
