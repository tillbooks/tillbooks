/**
 * A25 Review: every GUI state and every write touch-point.
 *
 * The review list is canned to the engine's `review_status` shape; the amount column is proven to
 * come from a SEPARATE `list_journal` read joined by entry id (the design that touches no engine
 * read). Status is asserted as glyph PLUS text; the coverage bar's lock is ABSENT (never disabled)
 * until the period is clean AND the actor holds `manage_periods`, its condition behind an (i). The row
 * actions rest hidden and show on the hovered, focused or selected row (D152). The LOADING test proves
 * its read started (`transport.started`), per `app/src/loading-state-convention.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import Review from './index';
import { revealGuardMs } from './Review';
import deCH from './messages.de-CH.json';
import { consequenceSentence } from '../../lib/approval-tiers';

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

function entry(id: string, status: 'open' | 'flagged' | 'approved', over: Record<string, unknown> = {}) {
  return {
    entryId: id,
    date: '2026-03-15',
    ref: `R-${id}`,
    description: `Buchung ${id}`,
    source: 'manual',
    status,
    reviewer: null,
    lastEventAt: null,
    commentCount: 0,
    flagCount: 0,
    ...over,
  };
}

function statusPayload(entries: ReturnType<typeof entry>[]) {
  return ok({
    period: '2026-03',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    total: entries.length,
    approved: entries.filter((e) => e.status === 'approved').length,
    flagged: entries.filter((e) => e.status === 'flagged').length,
    open: entries.filter((e) => e.status === 'open').length,
    entries,
  });
}

const SUPPORT_READS: Canned = {
  list_journal: ok({
    entries: [
      { id: 'e1', total: 120050, currency: 'CHF' },
      { id: 'e2', total: 8000, currency: 'CHF' },
      { id: 'e3', total: 4200, currency: 'CHF' },
    ],
  }),
  get_company_profile: ok({ baseCurrency: 'CHF' }),
  list_period_locks: ok({ locks: [] }),
};

function reviewCanned(entries: ReturnType<typeof entry>[], over: Canned = {}): Canned {
  return { ...SUPPORT_READS, review_status: statusPayload(entries), ...over };
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

function renderSurface(canned: Canned = reviewCanned([entry('e1', 'open')]), options: RenderOptions = {}) {
  const { transport, held = null, workspaceId = 'ws_test' } = options;
  const client = new TillClient(transport ?? fakeTransport(canned));
  const inner = (
    <MemoryRouter initialEntries={['/review']}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <TillClientProvider client={client}>
            <Review />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  return render(
    held === null ? inner : <CapabilitiesContext.Provider value={caps(held)}>{inner}</CapabilitiesContext.Provider>,
  );
}

describe('Review: the five states', () => {
  it('loading: the skeleton is a load in progress, proven by review_status having started', async () => {
    const transport = watchReads(neverSettles);
    renderSurface(undefined, { transport });
    await transport.started('review_status');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('empty: an honest sentence, never a bare "no data"', async () => {
    renderSurface(reviewCanned([]));
    expect(await screen.findByText('Keine Bewegungen in dieser Periode')).toBeInTheDocument();
  });

  it('error: a failed review read renders the retry banner, never a stack trace', async () => {
    renderSurface(reviewCanned([], { review_status: reject({ error: 'io_error' }, 500) }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('permission-denied by capability: the padlock replaces the controls, never shown-then-rejected', async () => {
    renderSurface(reviewCanned([entry('e1', 'open')]), { held: [] });
    expect(await screen.findByText(/Treuhänder-Rolle/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('permission-denied from the engine renders the padlock too', async () => {
    renderSurface(reviewCanned([], { review_status: reject({ error: 'permission_denied' }, 403) }));
    expect(await screen.findByText(/Treuhänder-Rolle/)).toBeInTheDocument();
  });

  it('success: rows render with the amount JOINED from list_journal', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'approved')]));
    // e1's amount comes from list_journal (120050 Rappen), not from review_status.
    expect(await screen.findByText("CHF 1'200.50")).toBeInTheDocument();
    expect(screen.getByText('CHF 80.00')).toBeInTheDocument();
  });
});

describe('Review: status is glyph plus text on one accent', () => {
  it('renders each status as text (never colour alone)', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'flagged'), entry('e3', 'approved')]));
    await screen.findByText("CHF 1'200.50");
    const table = screen.getByRole('table');
    expect(within(table).getByText('offen')).toBeInTheDocument();
    expect(within(table).getByText('markiert')).toBeInTheDocument();
    // "freigegeben" appears in the row tag and the coverage bar; both carry the word.
    expect(within(table).getAllByText('freigegeben').length).toBeGreaterThan(0);
  });
});

describe('Review: the write touch-points', () => {
  it('approve calls approve_entry with a per-act key and re-reads', async () => {
    const calls: Record<string, unknown>[] = [];
    const canned = reviewCanned([entry('e1', 'open')], {
      approve_entry: (input) => {
        calls.push(input);
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['entryId', 'idempotencyKey', 'workspaceId']);
    expect(calls[0]).toMatchObject({ workspaceId: 'ws_test', entryId: 'e1' });
    expect(String(calls[0]?.idempotencyKey)).toMatch(/^approve:ws_test:e1:\d+-[a-z0-9]+$/);
    // The Commit moment (D122 D-I): the row the approval was made on lands, once the re-read drew it.
    await waitFor(() => expect(screen.getByText("CHF 1'200.50").closest('tr')).toHaveAttribute('data-just-committed'));
  });

  it('approve, flag, approve again sends a DIFFERENT approve key (a fixed key replayed the first, stale ok)', async () => {
    const approveKeys: string[] = [];
    let state: 'open' | 'flagged' | 'approved' = 'open';
    const canned = reviewCanned([entry('e1', 'open')], {
      review_status: () => statusPayload([entry('e1', state)]),
      approve_entry: (input) => {
        approveKeys.push(String(input.idempotencyKey));
        state = 'approved';
        return ok({});
      },
      flag_entry: () => {
        state = 'flagged';
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(screen.getByText('Buchung e1').closest('tr')).toHaveTextContent('freigegeben'));
    await user.click(screen.getByRole('button', { name: 'Markieren' }));
    await user.type(screen.getByLabelText('Grund für die Markierung'), 'Beleg fehlt');
    await user.click(screen.getByRole('button', { name: 'Buchung markieren' }));
    await waitFor(() => expect(screen.getByText('Buchung e1').closest('tr')).toHaveTextContent('markiert'));
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(approveKeys).toHaveLength(2));
    expect(approveKeys[0]).not.toBe(approveKeys[1]);
    for (const key of approveKeys) expect(key).toMatch(/^approve:ws_test:e1:/);
  });

  it('a double click on Freigeben sends ONE request (the in-flight guard)', async () => {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const transport: Transport = async (action, input) => {
      if (action === 'approve_entry') {
        calls.push(String(input.idempotencyKey));
        await new Promise<void>((r) => {
          release = r;
        });
        return ok({});
      }
      return fakeTransport(reviewCanned([entry('e1', 'open')]))(action, input);
    };
    renderSurface(undefined, { transport });
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.dblClick(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(release).not.toBeNull());
    expect(calls).toHaveLength(1);
    await act(async () => {
      release?.();
    });
  });

  it('flag opens the reason composer and calls flag_entry', async () => {
    let flagged: Record<string, unknown> | null = null;
    const canned = reviewCanned([entry('e1', 'open')], {
      flag_entry: (input) => {
        flagged = input;
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Markieren' }));
    await user.type(screen.getByLabelText('Grund für die Markierung'), 'Beleg fehlt');
    await user.click(screen.getByRole('button', { name: 'Buchung markieren' }));
    await waitFor(() => expect(flagged).not.toBeNull());
    expect((flagged as unknown as { reason: string }).reason).toBe('Beleg fehlt');
  });

  it('comment opens the composer and calls comment_entry', async () => {
    let commented: Record<string, unknown> | null = null;
    const canned = reviewCanned([entry('e1', 'open')], {
      comment_entry: (input) => {
        commented = input;
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Kommentieren' }));
    await user.type(screen.getByLabelText('Dein Kommentar'), 'Bitte prüfen');
    await user.click(screen.getByRole('button', { name: 'Kommentar hinzufügen' }));
    await waitFor(() => expect(commented).not.toBeNull());
    expect((commented as unknown as { text: string }).text).toBe('Bitte prüfen');
  });
});

/** The (i) on the counts line and the sentence its tooltip carries, via `aria-describedby`. */
function lockInfo(): { trigger: HTMLElement; sentence: string } {
  const trigger = screen.getByRole('button', { name: 'Wann du sperren kannst' });
  const id = trigger.getAttribute('aria-describedby');
  expect(id).not.toBeNull();
  const tip = document.getElementById(id as string);
  expect(tip).not.toBeNull();
  expect(tip).toHaveAttribute('role', 'tooltip');
  return { trigger, sentence: tip?.textContent ?? '' };
}

describe('Review: coverage bar and the lock-until-clean rule (D152: absent, never disabled)', () => {
  it('while entries are open, Periode sperren is ABSENT and the (i) on the counts line says why', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'approved')]), { held: ['review', 'manage_periods'] });
    await screen.findByText("CHF 1'200.50");
    expect(screen.queryByRole('button', { name: 'Periode sperren' })).not.toBeInTheDocument();
    const { trigger, sentence } = lockInfo();
    expect(sentence).toBe('Sperren kannst du, sobald jede Buchung freigegeben und keine markiert ist.');
    // The (i) sits on the counts line, and the sentence lives only in its card: no resting paragraph.
    expect(trigger.closest('.rv-coverage-counts')).not.toBeNull();
    expect(screen.getByText(sentence).closest('[role="tooltip"]')).not.toBeNull();
  });

  it('while an entry is flagged, Periode sperren is ABSENT too', async () => {
    renderSurface(reviewCanned([entry('e1', 'flagged'), entry('e2', 'approved')]), { held: ['review', 'manage_periods'] });
    await screen.findByText("CHF 1'200.50");
    expect(screen.queryByRole('button', { name: 'Periode sperren' })).not.toBeInTheDocument();
    expect(lockInfo().sentence).toMatch(/keine markiert/);
  });

  it('a clean period without manage_periods: the lock is absent and the (i) names the missing right', async () => {
    renderSurface(reviewCanned([entry('e1', 'approved')]), { held: ['review'] });
    await screen.findByText("CHF 1'200.50");
    expect(screen.queryByRole('button', { name: 'Periode sperren' })).not.toBeInTheDocument();
    expect(lockInfo().sentence).toBe('Zum Sperren brauchst du das Recht, Perioden zu verwalten.');
  });

  it('neither clean nor the right: the (i) names both, the period first', async () => {
    renderSurface(reviewCanned([entry('e1', 'open')]), { held: ['review'] });
    await screen.findByText("CHF 1'200.50");
    expect(lockInfo().sentence).toBe(
      'Sperren kannst du, sobald jede Buchung freigegeben und keine markiert ist. Zum Sperren brauchst du das Recht, Perioden zu verwalten.',
    );
  });

  it('no control on the surface rests disabled (one action, one place)', async () => {
    const { container } = renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'flagged'), entry('e3', 'approved')]), {
      held: ['review'],
    });
    await screen.findByText("CHF 1'200.50");
    expect(container.querySelectorAll('button:disabled, [aria-disabled="true"]')).toHaveLength(0);
  });

  it('a clean period with manage_periods offers the lock (and no (i)), confirms, and links to export', async () => {
    let locked: Record<string, unknown> | null = null;
    const canned = reviewCanned([entry('e1', 'approved')], {
      lock_period: (input) => {
        locked = input;
        return ok({});
      },
    });
    renderSurface(canned, { held: ['review', 'manage_periods'] });
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    expect(screen.queryByRole('button', { name: 'Wann du sperren kannst' })).not.toBeInTheDocument();
    const lockBtn = screen.getByRole('button', { name: 'Periode sperren' });
    expect(lockBtn).toBeEnabled();
    await user.click(lockBtn);
    // The confirm dialog (an alertdialog for the consequential lock), then confirm.
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Periode sperren' }));
    await waitFor(() => expect(locked).not.toBeNull());
    // A hard lock with the Treuhänder reason, and a PER-ACT key: a key fixed to the period replayed a
    // first lock's ok after an unlock and showed a lock that was never written (critic, 91e0b750).
    // The period is the picker's, today's month by default.
    const sent = locked as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['idempotencyKey', 'kind', 'period', 'reason', 'workspaceId']);
    expect(sent.period).toMatch(/^\d{4}-\d{2}$/);
    expect(sent).toEqual({
      workspaceId: 'ws_test',
      period: sent.period,
      kind: 'hard',
      reason: 'treuhaender_review',
      idempotencyKey: sent.idempotencyKey,
    });
    expect(String(sent.idempotencyKey)).toMatch(new RegExp(`^lock:ws_test:${String(sent.period)}:\\d+-[a-z0-9]+$`));
    // The lock confirmation links straight to export (D115), and the bar offers no lock any more.
    const toExport = await screen.findByRole('link', { name: 'Zum Export' });
    expect(toExport).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Periode sperren' })).not.toBeInTheDocument();
    // A lock produces no row: the locked note it brings up is what lands (D122 D-I).
    await waitFor(() => expect(toExport.closest('.rv-locked')).toHaveAttribute('data-just-committed'));
  });
});

describe('Review: words on demand (D152 rule 4)', () => {
  it('the header carries no subtitle; the sentence lives in the help card', async () => {
    const { container } = renderSurface(reviewCanned([entry('e1', 'open')]));
    await screen.findByText("CHF 1'200.50");
    expect(container.querySelector('.surface-header-subtitle')).toBeNull();
    expect(screen.queryByText(/Kommentiere, markiere und gib/)).not.toBeInTheDocument();
    const body = deCH.help.Review.body;
    expect(body).toMatch(/kommentiere, was du hinterfragen willst, markiere, was falsch aussieht, und gib frei/);
    expect(body).toMatch(/Periode sperren erscheint dort, sobald alles freigegeben und nichts markiert ist/);
    // The help (?) beside the title is the one door to it: open, it shows the sentence.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hilfe zu Prüfung' }));
    expect(await screen.findByText(/kommentiere, was du hinterfragen willst/)).toBeInTheDocument();
  });

  it('the Aktionen column header is read by assistive tech but not shown', async () => {
    renderSurface(reviewCanned([entry('e1', 'open')]));
    await screen.findByText("CHF 1'200.50");
    const head = screen.getByRole('columnheader', { name: 'Aktionen' });
    expect(head.querySelector('.visually-hidden')).not.toBeNull();
  });
});

describe('Review: row actions rest hidden, shown on the hovered, focused or selected row (D152 rule 3)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/surfaces/Review/Review.css'), 'utf8');

  it('the stylesheet hides the row actions VISUALLY at rest and shows them on the selected or focused row', () => {
    expect(css).toMatch(/\.rv-rowactions\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none;/);
    expect(css).toMatch(
      /\.rv \.data-table-row\[data-selected\] \.rv-rowactions,\s*\.rv \.data-table-row:focus-within \.rv-rowactions\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/,
    );
  });

  it('nothing takes the actions out of the accessibility tree or the Tab order (no visibility, no display)', () => {
    const rules = [...css.matchAll(/([^{}]*\.rv-rowactions[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/visibility\s*:|display\s*:\s*none|\bhidden\b/);
  });

  it('the hover reveal is for a real hover only, so a touch screen reveals by selecting', () => {
    expect(css).toMatch(/@media \(hover: hover\)\s*\{\s*\.rv \.data-table-row:hover \.rv-rowactions\s*\{\s*opacity:\s*1;/);
    // No unconditional hover reveal outside that media query.
    const outside = css.replace(/@media \(hover: hover\)\s*\{[\s\S]*?\}\s*\}/, '');
    expect(outside).not.toMatch(/:hover \.rv-rowactions/);
  });

  it('nothing is selected on load; a click selects a row and a second click lets it go', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'open')]));
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    const rows = screen.getAllByRole('row').filter((r) => r.closest('tbody') !== null);
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(0);
    expect(rows.filter((r) => r.hasAttribute('data-selected'))).toHaveLength(0);
    await user.click(screen.getByText('Buchung e2'));
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).toHaveAttribute('data-selected');
    expect(rows[0]).not.toHaveAttribute('data-selected');
    await user.click(screen.getByText('Buchung e2'));
    expect(rows[1]).not.toHaveAttribute('data-selected');
  });

  it('acting on a row selects it and keeps it selected (it never toggles the row off)', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'open')]));
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    await user.click(row.querySelector('td') as HTMLElement);
    expect(row).toHaveAttribute('data-selected');
    await user.click(within(row).getByRole('button', { name: 'Kommentieren' }));
    expect(row).toHaveAttribute('data-selected');
  });

  it('keyboard: a row is a Tab stop and its three actions are the next Tab stops', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'open')]));
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAccessibleName('15.03.2026, Buchung e1, offen');
    row.focus();
    await user.tab();
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Kommentieren' }));
    await user.tab();
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Markieren' }));
    await user.tab();
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Freigeben' }));
    // Enter on the focused row selects it, the way a tap does on a touch screen.
    const second = screen.getByText('Buchung e2').closest('tr') as HTMLTableRowElement;
    second.focus();
    await user.keyboard('{Enter}');
    expect(second).toHaveAttribute('data-selected');
  });

  it('after an approve re-reads the list, focus is back on the row it was made on', async () => {
    let approved = false;
    const canned = reviewCanned([entry('e1', 'open')], {
      review_status: () => statusPayload([entry('e1', approved ? 'approved' : 'open'), entry('e2', 'open')]),
      approve_entry: () => {
        approved = true;
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    row.focus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: 'Freigeben' }));
    await user.keyboard('{Enter}');
    // The approve control is gone from the now-approved row; focus lands on its row, not the page.
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Buchung e1').closest('tr')));
  });

  it('a screen reader finds every row\'s actions at rest, and Shift+Tab reaches the previous row\'s', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'open')]));
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    // In the accessibility tree on every row, with nothing selected or hovered.
    for (const name of ['Kommentieren', 'Markieren', 'Freigeben']) {
      expect(screen.getAllByRole('button', { name })).toHaveLength(2);
    }
    for (const el of document.querySelectorAll('.rv-rowactions')) {
      expect(el.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull();
    }
    const first = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    const second = screen.getByText('Buchung e2').closest('tr') as HTMLTableRowElement;
    second.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: 'Freigeben' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(first).getByRole('button', { name: 'Markieren' }));
  });

  it('a new period clears the selection', async () => {
    renderSurface(reviewCanned([entry('e1', 'open')]));
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByText('Buchung e1'));
    expect(screen.getByText('Buchung e1').closest('tr')).toHaveAttribute('data-selected');
    fireEvent.change(screen.getByLabelText('Monat', { selector: 'input' }), { target: { value: '2025-01' } });
    // The canned read answers every period with the same row, so only the cleared selection differs.
    await waitFor(() => expect(screen.getByText('Buchung e1').closest('tr')).not.toHaveAttribute('data-selected'));
  });

  it('an approved row offers no approve control at all, never a disabled check', async () => {
    renderSurface(reviewCanned([entry('e1', 'approved')]));
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    expect(within(row).queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Kommentieren' })).toBeEnabled();
  });

  it('what a row already HAS stays at rest, outside the hidden actions: the comment count and the flag', async () => {
    renderSurface(reviewCanned([entry('e1', 'flagged', { commentCount: 2, flagCount: 1 })]));
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    const count = row.querySelector('.rv-comment-count') as HTMLElement;
    expect(count).toHaveTextContent('2');
    expect(count.querySelector('svg')).not.toBeNull();
    expect(count.closest('.rv-rowactions')).toBeNull();
    const flagged = within(row).getByText('markiert');
    expect(flagged.closest('.rv-rowactions')).toBeNull();
  });

  it('a hard-locked period has no row actions, so its rows are not selectable', async () => {
    const canned = reviewCanned([entry('e1', 'approved')], {
      list_period_locks: ok({ locks: [{ period: '2026-03', kind: 'hard', lockedAt: '2026-04-01', lockedBy: 'th', reason: 'treuhaender_review' }] }),
    });
    renderSurface(canned);
    await screen.findByText(/ist gesperrt/);
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    expect(row).not.toHaveAttribute('tabindex');
    expect(row.querySelector('.rv-rowactions')).toBeNull();
    // Already locked: the banner says so; the bar offers neither the lock nor its (i).
    expect(screen.queryByRole('button', { name: 'Periode sperren' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wann du sperren kannst' })).not.toBeInTheDocument();
  });
});

describe('Review: the all-approved note promises a lock only to someone who can lock', () => {
  it('with manage_periods it names the lock', async () => {
    renderSurface(reviewCanned([entry('e1', 'approved')]), { held: ['review', 'manage_periods'] });
    expect(await screen.findByText(/Du kannst die Periode sperren/)).toBeInTheDocument();
  });

  it('without manage_periods it names only the export', async () => {
    renderSurface(reviewCanned([entry('e1', 'approved')]), { held: ['review'] });
    expect(await screen.findByText('Nichts zu prüfen, alles freigegeben. Du kannst zum Export gehen.')).toBeInTheDocument();
    expect(screen.queryByText(/Periode sperren/)).not.toBeInTheDocument();
  });
});

describe('Review: locked state and accessibility', () => {
  it('an already-locked period shows the read-only banner and the export path', async () => {
    const canned = reviewCanned([entry('e1', 'approved')], {
      list_period_locks: ok({ locks: [{ period: '2026-03', kind: 'hard', lockedAt: '2026-04-01', lockedBy: 'th', reason: 'treuhaender_review' }] }),
    });
    renderSurface(canned);
    expect(await screen.findByText(/ist gesperrt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zum Export' })).toHaveAttribute('href', '/export?period=2026-03');
    // Locked: the per-row action controls are gone (read-only after lock).
    expect(screen.queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument();
  });

  it('has no axe violations in the success state', async () => {
    const { container } = renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'approved')]));
    await screen.findByText("CHF 1'200.50");
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * F-07 (J4.3): a SOFT-closed month stays reviewable (the story's order is close, then review, then
 * lock), only a hard lock hides the controls, and "Alle freigeben" is ONE act with ONE confirm that
 * sweeps the open rest and never a flagged entry.
 */
describe('Review: a soft-closed month stays reviewable, and Alle freigeben is one act (F-07)', () => {
  it('a soft lock keeps every control and says the review is still open', async () => {
    const canned = reviewCanned([entry('e1', 'open'), entry('e2', 'approved')], {
      list_period_locks: ok({ locks: [{ period: '2026-03', kind: 'soft', lockedAt: '2026-04-01', lockedBy: 'owner', reason: null }] }),
    });
    renderSurface(canned);
    expect(await screen.findByText(/ist weich abgeschlossen/)).toBeInTheDocument();
    // The note can land before the table's skeleton hold lets the rows in (seen under gate load):
    // wait for the rows themselves before counting their controls.
    await screen.findByText("CHF 1'200.50");
    expect(screen.queryByText(/ist gesperrt$/)).not.toBeInTheDocument();
    // One approve per OPEN row: the approved row offers none (D152, absent rather than disabled).
    const approveButtons = screen.getAllByRole('button', { name: 'Freigeben' });
    expect(approveButtons).toHaveLength(1);
    expect(approveButtons[0]).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Markieren' })[0]).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Alle freigeben (1)' })).toBeEnabled();
  });

  it('a year seal over the month is a hard lock: read-only, as before', async () => {
    const canned = reviewCanned([entry('e1', 'approved')], {
      list_period_locks: ok({ locks: [{ period: '2026', kind: 'hard', lockedAt: '2027-01-05', lockedBy: 'owner', reason: 'year_close' }] }),
    });
    renderSurface(canned);
    expect(await screen.findByText(/ist gesperrt/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Alle freigeben/ })).not.toBeInTheDocument();
  });

  it('Alle freigeben confirms ONCE, approves every open entry, and skips the flagged one', async () => {
    const approved: string[] = [];
    const canned = reviewCanned([entry('e1', 'open'), entry('e2', 'flagged'), entry('e3', 'open')], {
      approve_entry: (input) => {
        approved.push(String(input.entryId));
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Alle freigeben (2)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('2 offene Buchungen freigeben?');
    expect(dialog).toHaveTextContent('Markierte Buchungen (1) bleiben markiert');
    // Staging the confirm calls nothing.
    expect(approved).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: '2 freigeben' }));
    await waitFor(() => expect(approved).toEqual(['e1', 'e3']));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});

describe('Review: one lock sentence (F-07, D118 C4)', () => {
  it('the lock dialog renders the engine close-period sentence and no surface-authored twin', async () => {
    const canned = reviewCanned([entry('e1', 'approved')]);
    renderSurface(canned, { held: ['review', 'manage_periods'] });
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Periode sperren' }));
    const dialog = await screen.findByRole('alertdialog');
    const line = dialog.querySelector('.consequence-line') as HTMLElement;
    expect(line.getAttribute('data-verb')).toBe('lock_period');
    expect(line).toHaveTextContent(consequenceSentence('lock_period', 'de-CH') as string);
    expect(dialog).not.toHaveTextContent(/Stornierung/);
    expect(dialog.getAttribute('aria-describedby')).toBe('rv-lock-consequence');
  });
});

/**
 * Critic r2 (PASS with one LOW and three test gaps): the double-tap guard, the sweep's key shape, and
 * the in-flight guards proven with the `disabled` attribute bypassed.
 */
describe('Review: a quick double tap never approves (critic r2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--t-motion-pill');
    Reflect.deleteProperty(window, 'matchMedia');
  });

  function approveSpy() {
    const calls: string[] = [];
    const canned = reviewCanned([entry('e1', 'open')], {
      approve_entry: (input) => {
        calls.push(String(input.entryId));
        return ok({});
      },
    });
    return { calls, canned };
  }

  it('the tap that reveals a row\'s actions arms a guard: a second tap inside it does not approve', async () => {
    const { calls, canned } = approveSpy();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    renderSurface(canned);
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    // A TAP on the row body selects it (a touch press, then a click carrying detail 1).
    const cell = row.querySelector('td') as HTMLElement;
    fireEvent.pointerDown(cell, { pointerType: 'touch' });
    fireEvent.click(cell, { detail: 1 });
    expect(row).toHaveAttribute('data-selected');
    // The second tap of the double tap lands on Freigeben 100ms later: held back.
    now += 100;
    fireEvent.click(within(row).getByRole('button', { name: 'Freigeben' }), { detail: 1 });
    expect(calls).toEqual([]);
    // Once the reveal and the margin have passed, the same tap approves.
    now += revealGuardMs();
    fireEvent.click(within(row).getByRole('button', { name: 'Freigeben' }), { detail: 1 });
    await waitFor(() => expect(calls).toEqual(['e1']));
  });

  it('a keyboard press (detail 0) is never held back, even right after the reveal', async () => {
    const { calls, canned } = approveSpy();
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    renderSurface(canned);
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    const cell = row.querySelector('td') as HTMLElement;
    fireEvent.pointerDown(cell, { pointerType: 'touch' });
    fireEvent.click(cell, { detail: 1 });
    fireEvent.click(within(row).getByRole('button', { name: 'Freigeben' }), { detail: 0 });
    await waitFor(() => expect(calls).toEqual(['e1']));
  });

  it('a mouse on a hover-capable screen already saw the actions: its click right after selecting approves', async () => {
    const { calls, canned } = approveSpy();
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(hover: hover)' }),
    });
    renderSurface(canned);
    await screen.findByText("CHF 1'200.50");
    const row = screen.getByText('Buchung e1').closest('tr') as HTMLTableRowElement;
    const cell = row.querySelector('td') as HTMLElement;
    fireEvent.pointerDown(cell, { pointerType: 'mouse' });
    fireEvent.click(cell, { detail: 1 });
    fireEvent.click(within(row).getByRole('button', { name: 'Freigeben' }), { detail: 1 });
    await waitFor(() => expect(calls).toEqual(['e1']));
  });

  it('the guard spans the motion token plus a margin, and under reduced motion keeps the margin alone', () => {
    document.documentElement.style.setProperty('--t-motion-pill', '120ms');
    const motion = revealGuardMs();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
    });
    const reduced = revealGuardMs();
    expect(reduced).toBe(250);
    // jsdom may not resolve a custom property through getComputedStyle; where it does, the token adds.
    expect([250, 370]).toContain(motion);
    expect(motion).toBeGreaterThanOrEqual(reduced);
  });
});

describe('Review: the sweep key and the in-flight guards (critic r2)', () => {
  it('Alle freigeben keys each call per entry with ONE nonce for the whole sweep', async () => {
    const keys: string[] = [];
    const canned = reviewCanned([entry('e1', 'open'), entry('e2', 'flagged'), entry('e3', 'open')], {
      approve_entry: (input) => {
        keys.push(String(input.idempotencyKey));
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Alle freigeben (2)' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '2 freigeben' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    const shape = /^approve:ws_test:(e\d):(\d+-[a-z0-9]+)$/;
    const [first, second] = keys.map((k) => shape.exec(k));
    expect(first?.[1]).toBe('e1');
    expect(second?.[1]).toBe('e3');
    expect(first?.[2]).toBeDefined();
    expect(first?.[2]).toBe(second?.[2]);
  });

  it('two programmatic clicks on Freigeben, past the disabled attribute, still send ONE approve', async () => {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const transport: Transport = async (action, input) => {
      if (action === 'approve_entry') {
        calls.push(String(input.idempotencyKey));
        await new Promise<void>((r) => {
          release = r;
        });
        return ok({});
      }
      return fakeTransport(reviewCanned([entry('e1', 'open')]))(action, input);
    };
    renderSurface(undefined, { transport });
    await screen.findByText("CHF 1'200.50");
    const button = screen.getByRole('button', { name: 'Freigeben' });
    // Both clicks dispatch inside one act, before the busy state renders `disabled`: only the
    // in-flight guard (approvingRef) stands between them and a second request.
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(release).not.toBeNull());
    expect(calls).toHaveLength(1);
    await act(async () => {
      release?.();
    });
  });

  it('two programmatic confirms of the lock, past the disabled attribute, still send ONE lock', async () => {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const transport: Transport = async (action, input) => {
      if (action === 'lock_period') {
        calls.push(String(input.idempotencyKey));
        await new Promise<void>((r) => {
          release = r;
        });
        return ok({});
      }
      return fakeTransport(reviewCanned([entry('e1', 'approved')]))(action, input);
    };
    renderSurface(undefined, { transport, held: ['review', 'manage_periods'] });
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Periode sperren' }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Periode sperren' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(release).not.toBeNull());
    expect(calls).toHaveLength(1);
    await act(async () => {
      release?.();
    });
  });
});
