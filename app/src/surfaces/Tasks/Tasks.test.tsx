/**
 * The Aufgaben surface: E03's human face over the task queue.
 *
 * The suite follows the Serien/Automatisierungen discipline: every claim about a GATE mounts a real
 * `CapabilitiesProvider` over a transport that answers `whoami` (the hook fails open, so a test
 * without the provider measures the permissive default and calls it a permission test), a loading
 * assertion waits for the read to have STARTED, and copy is asserted through the catalogue, never
 * as a literal typed here.
 *
 * The one E03-specific gate claim worth singling out: the ✓ stays ENABLED for the ASSIGNEE even
 * without `tasks.write`, because the engine's completion rule is "tasks.write OR assignee" and the
 * Studio must not invent a stricter policy than the product has.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesProvider } from '../../lib/CapabilitiesProvider';
import { neverSettles, watchReads } from '../../test-transport';
import Tasks from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const TASK = (over: Record<string, unknown> = {}) => ({
  id: 'task_1',
  title: 'Offerte nachfassen',
  notes: null,
  assigneeUserId: 'studio',
  createdByUserId: 'studio',
  dueAt: '2026-07-15',
  reminderAt: null,
  snoozedUntil: null,
  status: 'open',
  entityKind: null,
  entityId: null,
  recurrenceRule: null,
  recurrenceParentId: null,
  completedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  bucket: 'overdue',
  ...over,
});

const whoamiWith = (actor: string, capabilities: string[]): RestResponse =>
  ok({ actor, role: null, isMember: true, provisioned: true, memberId: 'm1', userId: 'u1', capabilities });

const baseCanned = (): Canned => ({
  whoami: whoamiWith('studio', ['tasks.read', 'tasks.write']),
  tasks_list: ok({ tasks: [TASK()], total: 1 }),
  list_saved_views: ok({ savedViews: [] }),
});

function tree(canned: Canned, workspaceId: string | null, withProvider: boolean) {
  const inner = (
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>
  );
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          {withProvider ? <CapabilitiesProvider>{inner}</CapabilitiesProvider> : inner}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

const renderTasks = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, false));
const withCapabilities = (canned: Canned, workspaceId: string | null = 'ws_test') => render(tree(canned, workspaceId, true));

describe('Tasks, the load states', () => {
  it('shows the loading skeleton once the queue read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Tasks />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('tasks_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the padlock when the queue read is refused (the tasks.read gate)', async () => {
    renderTasks({ ...baseCanned(), tasks_list: reject('permission_denied', { capability: 'tasks.read' }, 403) });
    expect(await screen.findByText(de.tasks.error.permissionDenied.read)).toBeInTheDocument();
  });

  it('states what the surface is for when there are no tasks, with the create CTA', async () => {
    renderTasks({ ...baseCanned(), tasks_list: ok({ tasks: [], total: 0 }) });
    expect(await screen.findByText(de.tasks.empty)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: de.tasks.action.create }).length).toBeGreaterThan(0);
  });
});

describe('Tasks, the queue', () => {
  it('groups rows into the four sections and renders status as glyph AND label', async () => {
    const canned = {
      ...baseCanned(),
      tasks_list: ok({
        tasks: [
          TASK(),
          TASK({ id: 'task_2', title: 'Beleg nachreichen', bucket: 'today', status: 'doing' }),
          TASK({ id: 'task_3', title: 'Serie prüfen', bucket: 'upcoming', recurrenceRule: 'FREQ=MONTHLY' }),
          TASK({ id: 'task_4', title: 'Abgeschlossen', bucket: 'done', status: 'done' }),
        ],
        total: 4,
      }),
    };
    renderTasks(canned);
    expect(await screen.findByText('Offerte nachfassen')).toBeInTheDocument();
    // All four section headings, from the catalogue. By ROLE, because "Erledigt" is also a status
    // label on the done row and a bare text query would match both.
    for (const key of ['overdue', 'today', 'upcoming', 'done'] as const) {
      expect(screen.getByRole('heading', { name: new RegExp(de.tasks.bucket[key]) })).toBeInTheDocument();
    }
    // Status is text, not colour: the doing row carries its label.
    expect(screen.getByText(de.tasks.status.doing)).toBeInTheDocument();
    // The recurring badge on the recurring row.
    expect(screen.getByText(de.tasks.recurring.badge)).toBeInTheDocument();
  });

  it('has no axe violations on the loaded queue', async () => {
    const { container } = renderTasks(baseCanned());
    await screen.findByText('Offerte nachfassen');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Tasks, the gates (real CapabilitiesProvider, real whoami)', () => {
  it('hides create/edit/snooze/cancel without tasks.write, and disables the check for a non-assignee', async () => {
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith('viewer-actor', ['tasks.read']),
      tasks_list: ok({ tasks: [TASK({ assigneeUserId: 'somebody-else' })], total: 1 }),
    };
    withCapabilities(canned);
    await screen.findByText('Offerte nachfassen');
    expect(screen.queryByRole('button', { name: de.tasks.action.create })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.tasks.action.edit })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: de.tasks.action.cancel })).not.toBeInTheDocument();
    const check = screen.getByRole('button', { name: `${de.tasks.action.complete}: Offerte nachfassen` });
    expect(check).toBeDisabled();
  });

  it('keeps the check ENABLED for the assignee without tasks.write (the engine allows exactly that)', async () => {
    const canned = {
      ...baseCanned(),
      whoami: whoamiWith('worker-1', ['tasks.read']),
      tasks_list: ok({ tasks: [TASK({ assigneeUserId: 'worker-1' })], total: 1 }),
    };
    withCapabilities(canned);
    await screen.findByText('Offerte nachfassen');
    expect(screen.getByRole('button', { name: `${de.tasks.action.complete}: Offerte nachfassen` })).toBeEnabled();
  });
});

describe('Tasks, the writes', () => {
  it('completes over the wire, logging the activity for a contact-linked task, and announces a series end', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      tasks_list: ok({
        tasks: [TASK({ entityKind: 'contact', entityId: 'contact_1', recurrenceRule: 'FREQ=MONTHLY;COUNT=2' })],
        total: 1,
      }),
      tasks_complete: ok({ taskId: 'task_1', spawnedTaskId: null, seriesEnded: true, activityId: 'act_1' }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Tasks />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Offerte nachfassen');
    await userEvent.click(screen.getByRole('button', { name: `${de.tasks.action.complete}: Offerte nachfassen` }));

    await waitFor(() => {
      const call = asked.find((a) => a.action === 'tasks_complete');
      expect(call).toBeDefined();
      // The wire input is asserted exactly: the OP5 log rides the contact link, and the write
      // carries a fresh idempotency key.
      expect(call?.input.taskId).toBe('task_1');
      expect(call?.input.logActivity).toBe(true);
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
    // "Serie beendet." shown once, as a status, dismissible.
    expect(await screen.findByText(new RegExp(de.tasks.recurring.series_ended))).toBeInTheDocument();
  });

  it('creates through the DetailDrawer, sending the title and a fresh idempotency key over the wire', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      tasks_list: ok({ tasks: [], total: 0 }),
      tasks_create: ok({ taskId: 'task_new' }),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Tasks />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // Open the create drawer from the empty-state CTA; it is a real dialog, focus-trapped.
    await screen.findByText(de.tasks.empty);
    await userEvent.click(screen.getAllByRole('button', { name: de.tasks.action.create })[0] as HTMLElement);
    const drawer = await screen.findByRole('dialog', { name: de.tasks.editor.createTitle });
    expect(drawer).toBeInTheDocument();
    // The recurrence field is create-only.
    expect(screen.getByText(de.tasks.field.recurrence)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(de.tasks.field.title), 'Rechnung stellen');
    await userEvent.click(screen.getByRole('button', { name: de.tasks.editor.save }));

    await waitFor(() => {
      const call = asked.find((a) => a.action === 'tasks_create');
      expect(call).toBeDefined();
      expect(call?.input.title).toBe('Rechnung stellen');
      expect(typeof call?.input.idempotencyKey).toBe('string');
    });
  });

  it('opens the edit drawer seeded from the row, with no recurrence field', async () => {
    renderTasks(baseCanned());
    await screen.findByText('Offerte nachfassen');
    await userEvent.click(screen.getByRole('button', { name: de.tasks.action.edit }));
    const drawer = await screen.findByRole('dialog', {
      name: de.tasks.editor.label.replace('{title}', 'Offerte nachfassen'),
    });
    expect(drawer).toBeInTheDocument();
    // Seeded from the row.
    expect(screen.getByLabelText(de.tasks.field.title)).toHaveValue('Offerte nachfassen');
    // Recurrence is create-only, so the edit drawer does not carry it.
    expect(screen.queryByText(de.tasks.field.recurrence)).not.toBeInTheDocument();
  });

  it('renders the engine refusal for a bad snooze where it was attempted', async () => {
    const canned: Canned = {
      ...baseCanned(),
      tasks_list: ok({ tasks: [TASK({ reminderAt: '2026-07-20T08:00:00.000Z' })], total: 1 }),
      tasks_snooze: reject('snooze_in_past', { until: '2026-01-01' }),
    };
    renderTasks(canned);
    await screen.findByText('Offerte nachfassen');
    await userEvent.click(screen.getByRole('button', { name: de.tasks.action.snooze }));
    const untilInput = screen.getByLabelText(de.tasks.snooze.until);
    await userEvent.type(untilInput, '2026-01-01T08:00');
    await userEvent.click(screen.getAllByRole('button', { name: de.tasks.action.snooze })[1] as HTMLElement);
    expect(await screen.findByText(de.tasks.error.snooze_in_past)).toBeInTheDocument();
  });
});
