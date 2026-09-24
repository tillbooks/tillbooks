/**
 * M03 Hosting journey component tests (spec §4 V3/V3a, §2 S3.1-S3.4, S7.5). The assertions a
 * screenshot cannot make:
 *  - the D106 model sentence renders ABOVE the rungs, and no "sync devices" affordance exists;
 *  - the managed rung is DISABLED with the "bald verfügbar" reason on the rung itself (D119
 *    posture 1: prevented at the control, not at validation), while "Mehr" still opens;
 *  - "Umzug starten" calls advance_move_step with the computed direction;
 *  - the checklist renders position and steps from the Move record; step 1 runs create_backup
 *    before advancing; steps 2/3 are manual check-offs; step 4 is an honestly-labelled MANUAL
 *    comparison (never an automated pass), and a declared mismatch re-opens steps 1/3/4;
 *  - step 5 opens the V3a confirm, which states the reversible consequence and calls
 *    archive_workspace before marking the step;
 *  - a COMPLETED move over an unarchived workspace renders the S7.5 stale-writable notice;
 *  - the exit box's four steps render on the SAME checklist component (asserted in the
 *    SyncHosting test via ExitChecklist here by class and vocabulary).
 *
 * Default locale is de-CH, so the copy asserted is the German half.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { HostingJourney, ExitChecklist } from './HostingJourney';
import de from './messages.de-CH.json';

const J = de.journey;

type CannedHandler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

function fakeTransport(canned: Canned): { transport: Transport; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  const transport: Transport = async (action, input) => {
    calls.push([action, input ?? {}]);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
  return { transport, calls };
}

const workspace = (archived = false): RestResponse =>
  ok({
    workspace: {
      workspaceId: 'ws_1',
      name: 'Echt GmbH',
      legalForm: 'gmbh',
      baseCurrency: 'CHF',
      fiscalYearStart: '01-01',
      archived,
      createdAt: '2026-01-01',
    },
  });

/** A move record: `doneThrough` steps checked, optionally completed. */
const move = (direction: string, doneThrough: number, completed = false): Record<string, unknown> => ({
  move: {
    direction,
    steps: [1, 2, 3, 4, 5].map((step) => ({
      step,
      doneAt: step <= doneThrough ? `2026-08-2${step}T10:00:00.000Z` : null,
    })),
    startedAt: '2026-08-20T09:00:00.000Z',
    completedAt: completed ? '2026-08-27T10:00:00.000Z' : null,
  },
});

function tree(canned: Canned, calls?: { current?: [string, Record<string, unknown>][] }) {
  const made = fakeTransport({ get_workspace: workspace(), ...canned });
  if (calls) calls.current = made.calls;
  return (
    <TillClientProvider client={new TillClient(made.transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_1">
          <CapabilitiesProvider>
            <MemoryRouter>
              <HostingJourney workspaceId="ws_1" />
            </MemoryRouter>
          </CapabilitiesProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('HostingJourney (M03 V3, the ladder and the move checklist)', () => {
  it('D106 LEAD: the one-instance model sentence renders above the rungs, and no device-sync affordance exists', async () => {
    const { container } = render(tree({ get_move_state: ok({ move: null }) }));
    expect(await screen.findByText(J.hosting.model)).toBeInTheDocument();
    // The lead precedes the rung list in the DOM.
    const text = container.textContent ?? '';
    expect(text.indexOf(J.hosting.model)).toBeLessThan(text.indexOf(J.hosting.rung.local.label));
    // No surface anywhere offers a "sync devices" affordance (S3.3 acceptance).
    expect(text.toLowerCase()).not.toContain('geräte synchronisieren');
  });

  it('MANAGED RUNG: renders disabled with the bald-verfügbar reason on the rung, Mehr still opens', async () => {
    render(tree({ get_move_state: ok({ move: null }) }));
    await screen.findByText(J.hosting.model);
    const managed = screen.getByRole('radio', { name: new RegExp(J.hosting.rung.managed.label) });
    expect(managed).toBeDisabled();
    expect(screen.getByText(J.hosting.rung.managed.soon.trim())).toBeInTheDocument();
    // "Mehr" opens and names provisioning as external; no price string renders (S3.2 acceptance).
    expect(screen.getByRole('button', { name: J.hosting.rung.managed.more })).toBeInTheDocument();
    const all = (document.body.textContent ?? '').toLowerCase();
    expect(all).not.toMatch(/chf\s*\d|preis|price/);
  });

  it('START: choosing the self-host rung and pressing Umzug starten calls advance_move_step with the direction', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree(
        {
          get_move_state: ok({ move: null }),
          advance_move_step: ok(move('local_to_selfhost', 0)),
        },
        calls,
      ),
    );
    await screen.findByText(J.hosting.model);
    const start = screen.getByRole('button', { name: J.hosting.start });
    expect(start).toBeDisabled(); // no target chosen yet: prevented at the control
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(J.hosting.rung.selfhost.label) }));
    await userEvent.click(screen.getByRole('button', { name: J.hosting.start }));
    await waitFor(() => {
      const call = (calls.current ?? []).find(([a]) => a === 'advance_move_step');
      expect(call?.[1]).toMatchObject({ workspaceId: 'ws_1', direction: 'local_to_selfhost' });
    });
  });

  it('CHECKLIST: renders the five steps with the current position from the Move record', async () => {
    render(tree({ get_move_state: ok(move('local_to_selfhost', 1)) }));
    expect(await screen.findByText(J.step.position.replace('{n}', '2').replace('{total}', '5'))).toBeInTheDocument();
    // Step 1 shows its done label with the date; the manual steps name their honesty.
    expect(screen.getByText(J.step['1_done'].replace('{date}', '21.08.2026'))).toBeInTheDocument();
    expect(screen.getByText(J.step['2_selfhost'])).toBeInTheDocument();
    expect(screen.getByText(J.step['3'])).toBeInTheDocument();
    expect(screen.getByText(J.step.manual_note)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: J.abort })).toBeInTheDocument();
  });

  it('STEP 1: the backup action calls create_backup, then advances step 1', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree(
        {
          get_move_state: ok(move('local_to_selfhost', 0)),
          create_backup: ok({ backupId: 'b1' }),
          advance_move_step: ok(move('local_to_selfhost', 1)),
        },
        calls,
      ),
    );
    await screen.findByRole('button', { name: J.step['1_action'] });
    await userEvent.click(screen.getByRole('button', { name: J.step['1_action'] }));
    await waitFor(() => {
      const names = (calls.current ?? []).map(([a]) => a);
      expect(names).toContain('create_backup');
      const adv = (calls.current ?? []).find(([a]) => a === 'advance_move_step');
      expect(adv?.[1]).toMatchObject({ direction: 'local_to_selfhost', step: 1 });
    });
  });

  it('STEP 4: Prüfen renders the honest manual-comparison copy and this ledger total, never an automated pass', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree(
        {
          get_move_state: ok(move('local_to_selfhost', 3)),
          trial_balance: ok({ totals: { openingMinor: 0, debitMinor: 123456, creditMinor: 123456, closingMinor: 0 } }),
          advance_move_step: ok(move('local_to_selfhost', 4)),
        },
        calls,
      ),
    );
    await screen.findByRole('button', { name: J.compare.check });
    await userEvent.click(screen.getByRole('button', { name: J.compare.check }));
    // The copy names it a manual comparison: TILL cannot read the other instance.
    expect(await screen.findByText(J.compare.note)).toBeInTheDocument();
    expect(await screen.findByText(J.compare.total.replace('{total}', "CHF 1'234.56"))).toBeInTheDocument();
    // Confirming the match is the human's act; only then does step 4 advance.
    await userEvent.click(screen.getByRole('button', { name: J.compare.match }));
    await waitFor(() => {
      const adv = (calls.current ?? []).find(([a]) => a === 'advance_move_step');
      expect(adv?.[1]).toMatchObject({ step: 4 });
    });
  });

  it('STEP 4 MISMATCH: declaring a mismatch renders the error with its one action and re-opens steps 1/3/4', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree(
        {
          get_move_state: ok(move('local_to_selfhost', 3)),
          trial_balance: ok({ totals: { debitMinor: 100 } }),
          advance_move_step: ok(move('local_to_selfhost', 3)),
        },
        calls,
      ),
    );
    await screen.findByRole('button', { name: J.compare.check });
    await userEvent.click(screen.getByRole('button', { name: J.compare.check }));
    await userEvent.click(await screen.findByRole('button', { name: J.compare.mismatch }));
    expect(await screen.findByRole('alert')).toHaveTextContent(J.compare.mismatchBody);
    await waitFor(() => {
      const undo = (calls.current ?? [])
        .filter(([a]) => a === 'advance_move_step')
        .map(([, input]) => input as { step?: number; done?: boolean });
      expect(undo.filter((u) => u.done === false).map((u) => u.step).sort()).toEqual([1, 3, 4]);
    });
  });

  it('STEP 5 / V3a: Stilllegen opens the confirm with the reversible consequence, and confirming calls archive_workspace', async () => {
    const calls: { current?: [string, Record<string, unknown>][] } = {};
    render(
      tree(
        {
          get_move_state: ok(move('local_to_selfhost', 4)),
          archive_workspace: ok({ archived: true }),
          advance_move_step: ok(move('local_to_selfhost', 5, true)),
        },
        calls,
      ),
    );
    await screen.findByRole('button', { name: J.step['5_action'] });
    await userEvent.click(screen.getByRole('button', { name: J.step['5_action'] }));
    const dialog = await screen.findByRole('alertdialog');
    // The consequence is stated BEFORE it happens: read-only, intact, reversible over the roster.
    expect(dialog).toHaveTextContent('Wieder aktivierbar über die Mandatsliste');
    await userEvent.click(within(dialog).getByRole('button', { name: J.retire.confirm }));
    await waitFor(() => {
      const arch = (calls.current ?? []).find(([a]) => a === 'archive_workspace');
      expect(arch?.[1]).toMatchObject({ workspaceId: 'ws_1', archived: true });
      const adv = (calls.current ?? []).find(([a]) => a === 'advance_move_step');
      expect(adv?.[1]).toMatchObject({ step: 5 });
      // S3.4 ORDER: step 5 is recorded BEFORE the archive. The registry refuses every write except
      // archive_workspace on an archived workspace, so archive-first dead-ends the checklist.
      const names = (calls.current ?? []).map(([a]) => a);
      expect(names.indexOf('advance_move_step')).toBeLessThan(names.indexOf('archive_workspace'));
    });
  });

  it('S3.4 HALF-DONE: step 5 records but the archive fails; the refusal stays inline and the S7.5 notice renders behind', async () => {
    // After the (reordered) step-5 record, a failed archive leaves a COMPLETED move over a
    // writable workspace: exactly the state the S7.5 stale-writable notice owns, and its
    // Stilllegen is the retry path. The popover keeps the refusal inline (V3a error UI).
    let advanced = false;
    render(
      tree({
        get_move_state: () => ok(advanced ? move('local_to_selfhost', 5, true) : move('local_to_selfhost', 4)),
        advance_move_step: () => {
          advanced = true;
          return ok(move('local_to_selfhost', 5, true));
        },
        archive_workspace: reject('permission_denied'),
      }),
    );
    await screen.findByRole('button', { name: J.step['5_action'] });
    await userEvent.click(screen.getByRole('button', { name: J.step['5_action'] }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: J.retire.confirm }));
    // The refreshed panel shows the completed posture with the stale-writable notice behind the
    // popover (the refresh remounts the block, so the dialog handle is re-queried).
    expect(await screen.findByText(J.stale.notice)).toBeInTheDocument();
    const reopened = await screen.findByRole('alertdialog');
    expect(await within(reopened).findByRole('alert')).toHaveTextContent(J.retire.denied);
  });

  it('S7.5: a completed move over an UNARCHIVED workspace renders the stale-writable notice with Stilllegen', async () => {
    render(
      tree({
        get_move_state: ok(move('local_to_selfhost', 5, true)),
        get_workspace: workspace(false),
      }),
    );
    expect(await screen.findByText(J.stale.notice)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: J.stale.action })).toBeInTheDocument();
  });

  it('S7.5 QUIET: a completed move over an ARCHIVED workspace renders the posture, no notice', async () => {
    render(
      tree({
        get_move_state: ok(move('local_to_selfhost', 5, true)),
        get_workspace: workspace(true),
      }),
    );
    await waitFor(() => expect(screen.queryByText(J.stale.notice)).not.toBeInTheDocument());
    expect(
      screen.getByText(
        J.hosting.done.replace('{name}', 'Echt GmbH').replace('{target}', J.hosting.rung.selfhost.label),
      ),
    ).toBeInTheDocument();
  });

  it('ERROR: a failed move read renders the shared error banner with retry (V-shared)', async () => {
    render(tree({ get_move_state: reject('unexpected_error', 500) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('EXIT CHECKLIST: the exit box steps render on the SAME checklist component with the extern step named', () => {
    render(
      <I18nProvider>
        <ExitChecklist />
      </I18nProvider>,
    );
    expect(screen.getByText(J.exit.steps['1'])).toBeInTheDocument();
    expect(screen.getByText(J.exit.steps['4'])).toBeInTheDocument();
    // Same component: same position vocabulary, four steps.
    expect(screen.getByText(J.step.position.replace('{n}', '1').replace('{total}', '4'))).toBeInTheDocument();
    expect(document.querySelectorAll('.hosting-step').length).toBe(4);
  });

  it('A11Y: no axe violations on the ladder', async () => {
    const { container } = render(tree({ get_move_state: ok({ move: null }) }));
    await screen.findByText(J.hosting.model);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('A11Y: no axe violations on the active checklist', async () => {
    const { container } = render(tree({ get_move_state: ok(move('local_to_selfhost', 1)) }));
    await screen.findByText(J.step['3']);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Phase 3 landed the self-host image (D119 posture 2, M03 §10): the self-host rung and its checklist
 * step 2 now LEAD with the compose recipe ("under an hour" first, the one command named), and the
 * reverse-proxy contract is the second link. The managed rung stays disabled; no price anywhere.
 */
describe('HostingJourney: the self-host rung leads with the image (D119 posture 2)', () => {
  it('RUNG: names the one command and links under-an-hour before the reverse-proxy guide', async () => {
    render(tree({ get_move_state: ok({ move: null }) }));
    await screen.findByText(J.hosting.model);
    expect(screen.getByText(J.hosting.rung.selfhost.hint)).toBeInTheDocument();
    expect(J.hosting.rung.selfhost.hint).toContain('docker compose up -d');
    const first = screen.getByRole('link', { name: J.hosting.rung.selfhost.guide });
    const second = screen.getByRole('link', { name: J.hosting.rung.selfhost.proxyGuide });
    expect(first).toHaveAttribute('href', 'https://docs.tillbooks.ch/self-hosting/under-an-hour');
    expect(second).toHaveAttribute('href', 'https://docs.tillbooks.ch/self-hosting/served-access');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((document.body.textContent ?? '').toLowerCase()).not.toMatch(/chf\s*\d|preis|price/);
  });

  it('STEP 2: the self-host checklist step names the command and links the recipe first', async () => {
    render(tree({ get_move_state: ok(move('local_to_selfhost', 1)) }));
    expect(await screen.findByText(J.step['2_selfhost'])).toBeInTheDocument();
    expect(J.step['2_selfhost']).toContain('docker compose up -d');
    const guide = screen.getByRole('link', { name: J.step['2_guide'] });
    const proxy = screen.getByRole('link', { name: J.step['2_proxyGuide'] });
    expect(guide).toHaveAttribute('href', 'https://docs.tillbooks.ch/self-hosting/under-an-hour');
    expect(proxy).toHaveAttribute('href', 'https://docs.tillbooks.ch/self-hosting/served-access');
    expect(guide.compareDocumentPosition(proxy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
