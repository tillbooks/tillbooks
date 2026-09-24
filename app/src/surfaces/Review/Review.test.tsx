/**
 * A25 Review: every GUI state and every write touch-point.
 *
 * The review list is canned to the engine's `review_status` shape; the amount column is proven to
 * come from a SEPARATE `list_journal` read joined by entry id (the design that touches no engine
 * read). Status is asserted as glyph PLUS text; the coverage bar's lock stays disabled until the
 * period is clean AND the actor holds `manage_periods`. The LOADING test proves its read started
 * (`transport.started`), per `app/src/loading-state-convention.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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
  it('approve calls approve_entry and re-reads', async () => {
    const calls: string[] = [];
    const canned = reviewCanned([entry('e1', 'open')], {
      approve_entry: (input) => {
        calls.push(String(input.entryId));
        return ok({});
      },
    });
    renderSurface(canned);
    const user = userEvent.setup();
    await screen.findByText("CHF 1'200.50");
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls).toContain('e1'));
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

describe('Review: coverage bar and the lock-until-clean rule', () => {
  it('the lock button is DISABLED while entries are open', async () => {
    renderSurface(reviewCanned([entry('e1', 'open'), entry('e2', 'approved')]));
    await screen.findByText("CHF 1'200.50");
    expect(screen.getByRole('button', { name: 'Periode sperren' })).toBeDisabled();
  });

  it('the lock button is DISABLED while an entry is flagged', async () => {
    renderSurface(reviewCanned([entry('e1', 'flagged'), entry('e2', 'approved')]));
    await screen.findByText("CHF 1'200.50");
    expect(screen.getByRole('button', { name: 'Periode sperren' })).toBeDisabled();
  });

  it('a clean period without manage_periods disables the lock and names the missing right', async () => {
    renderSurface(reviewCanned([entry('e1', 'approved')]), { held: ['review'] });
    await screen.findByText("CHF 1'200.50");
    expect(screen.getByRole('button', { name: 'Periode sperren' })).toBeDisabled();
    expect(screen.getByText(/Recht, Perioden zu verwalten/)).toBeInTheDocument();
  });

  it('a clean period with manage_periods enables the lock, confirms, and links to export', async () => {
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
    const lockBtn = screen.getByRole('button', { name: 'Periode sperren' });
    expect(lockBtn).toBeEnabled();
    await user.click(lockBtn);
    // The confirm dialog (an alertdialog for the consequential lock), then confirm.
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Periode sperren' }));
    await waitFor(() => expect(locked).not.toBeNull());
    expect((locked as unknown as { kind: string }).kind).toBe('hard');
    // The lock confirmation links straight to export (D115).
    expect(await screen.findByRole('link', { name: 'Zum Export' })).toBeInTheDocument();
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
    expect(screen.queryByText(/ist gesperrt$/)).not.toBeInTheDocument();
    const approveButtons = screen.getAllByRole('button', { name: 'Freigeben' });
    expect(approveButtons).toHaveLength(2);
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
    expect(line).toHaveTextContent('Versiegelt eine Rechnungsperiode gegen weitere Buchungen. Ein harter Abschluss lässt sich nicht wieder öffnen.');
    expect(dialog).not.toHaveTextContent(/Stornierung/);
    expect(dialog.getAttribute('aria-describedby')).toBe('rv-lock-consequence');
  });
});
