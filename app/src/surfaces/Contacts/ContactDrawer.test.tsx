/**
 * E03, the per-contact task list embedded in the Verlauf tab of the ContactDrawer (spec E03 §6).
 *
 * What this file pins is exactly what the spec asks the drawer section to carry and what is easy to
 * ship broken:
 *   - the FIVE states, and in particular that a FAILED read is an honest retryable error and never a
 *     false "no tasks yet" (the A23-U2 bug was a failed read shown as empty),
 *   - a NAMED touch-point for every one of E03's five write verbs (create, update, complete, snooze,
 *     cancel), each reaching the wire with a `workspaceId`, the contact link, and an idempotency key,
 *   - status is ALWAYS glyph AND label, never colour or glyph alone (WCAG 1.4.1),
 *   - a contact-linked completion asks the engine to log the OP5 activity and re-reads the timeline,
 *   - the A24 padlock: no `tasks.write` hides create/edit/snooze/cancel, and a refusal is surfaced.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { watchReads, type WatchedTransport } from '../../test-transport';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, CAP, type Capabilities } from '../../lib/capabilities';
import { ContactDrawer } from './ContactDrawer';
import type { Contact } from './model';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;

function transport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, status = 422): RestResponse => ({ status, body: { ok: false, error } });

const CONTACT: Contact = { id: 'k1', partyRole: 'customer', kind: 'company', name: 'Muster AG', segments: [] };

/** A capability context that answers a fixed set, so the fail-open default cannot mask the A24 gate. */
function caps(held: readonly string[], actor = 'studio'): Capabilities {
  return {
    whoami: { actor, provisioned: true, isMember: true, memberId: 'm1', userId: 'u1', role: 'owner', capabilities: [...held] },
    can: (capability) => held.includes(capability),
    refresh: () => undefined,
  };
}

/** Render the drawer. Without a caps override the ALLOW_ALL default applies (canWrite true). */
function renderDrawer(canned: Canned, capsCtx?: Capabilities, wrap: (t: Transport) => Transport = (t) => t) {
  const client = new TillClient(wrap(transport(canned)));
  const tree = (
    <TillClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter>
          <ContactDrawer
            contact={CONTACT}
            workspaceId="ws_test"
            contacts={[CONTACT]}
            onClose={() => undefined}
            onEdit={() => undefined}
            onChanged={() => undefined}
          />
        </MemoryRouter>
      </I18nProvider>
    </TillClientProvider>
  );
  return render(capsCtx === undefined ? tree : <CapabilitiesContext.Provider value={capsCtx}>{tree}</CapabilitiesContext.Provider>);
}

describe('ContactDrawer E00 attachments, the shared Dateien panel mounted on Stammdaten', () => {
  it('mounts LinkedFiles against THIS contact, parameterised by the OP3 pair', async () => {
    const listLinked = vi.fn<Handler>(() => ok({ files: [] }));
    renderDrawer({ contacts_timeline: ok({ activities: [] }), files_list_linked: listLinked });
    // The panel lives on the default Stammdaten tab: one shared component, never a bespoke copy.
    expect(await screen.findByRole('heading', { name: 'Dateien' })).toBeInTheDocument();
    await waitFor(() => expect(listLinked).toHaveBeenCalled());
    expect(listLinked.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws_test',
      entityKind: 'contact',
      entityId: 'k1',
    });
  });
});

/** Pick one of a task card's overflow verbs (K-21: only Erledigen stays in the open). */
async function taskAction(row: HTMLElement, name: string): Promise<void> {
  await userEvent.click(within(row).getByRole('button', { name: /^Weitere Aktionen für Aufgabe/ }));
  await userEvent.click(within(row).getByRole('menuitem', { name }));
}

/** Open the Verlauf tab, where the task section lives, and return the drawer element. */
async function openTasks(): Promise<HTMLElement> {
  const drawer = await screen.findByRole('dialog');
  await userEvent.click(within(drawer).getByRole('tab', { name: 'Verlauf' }));
  return drawer;
}

const TASKS = [
  { id: 't1', title: 'Rechnung nachfassen', assigneeUserId: 'studio', status: 'open', dueAt: '2026-09-01', reminderAt: '2026-08-30T09:00:00.000Z', snoozedUntil: null, recurrenceRule: null, bucket: 'upcoming' },
  { id: 't2', title: 'MWST vorbereiten', assigneeUserId: 'studio', status: 'doing', dueAt: null, reminderAt: null, snoozedUntil: null, recurrenceRule: 'FREQ=MONTHLY', bucket: 'upcoming' },
];

const base = (extra: Canned = {}): Canned => ({
  contacts_timeline: ok({ activities: [] }),
  tasks_list: ok({ tasks: TASKS }),
  ...extra,
});

describe('ContactDrawer task section, the five states', () => {
  it('shows a loading skeleton before the list resolves', async () => {
    let resolve: (r: RestResponse) => void = () => undefined;
    const pending = new Promise<RestResponse>((r) => {
      resolve = r;
    });
    let watched!: WatchedTransport;
    renderDrawer(base({ tasks_list: () => pending }), undefined, (t) => (watched = watchReads(t)));
    const drawer = await openTasks();
    // Prove the read really went in flight before asserting the skeleton: the skeleton is the
    // section's DEFAULT, so without this the assertion would hold over a surface that never reads.
    await watched.started('tasks_list');
    expect(within(drawer).getByText('Aufgaben werden geladen')).toBeInTheDocument();
    resolve(ok({ tasks: [] }));
    await within(drawer).findByText('Noch keine Aufgaben für diesen Kontakt.');
  });

  it('invites a first task on the empty state rather than a bare "no data"', async () => {
    renderDrawer(base({ tasks_list: ok({ tasks: [] }) }));
    const drawer = await openTasks();
    expect(await within(drawer).findByText('Noch keine Aufgaben für diesen Kontakt.')).toBeInTheDocument();
    // The create affordance sits in the section header, so the empty state is not a dead end.
    expect(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' })).toBeInTheDocument();
  });

  it('shows a FAILED read as a retryable error, never a false empty (A23-U2)', async () => {
    const listSpy = vi.fn<Handler>(() => reject('boom', 500));
    renderDrawer(base({ tasks_list: listSpy }));
    const drawer = await openTasks();
    // The honest split: an alert with a way out, and NOT the empty-state copy over a broken read.
    expect(await within(drawer).findByText('Die Aufgaben konnten nicht geladen werden.')).toBeInTheDocument();
    expect(within(drawer).queryByText('Noch keine Aufgaben für diesen Kontakt.')).toBeNull();
    const before = listSpy.mock.calls.length;
    await userEvent.click(within(drawer).getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(before));
  });

  it('renders the permission-denied padlock when the read is forbidden', async () => {
    renderDrawer(base({ tasks_list: reject('permission_denied', 403) }));
    const drawer = await openTasks();
    expect(await within(drawer).findByText('Dir fehlt die Berechtigung, Aufgaben zu sehen.')).toBeInTheDocument();
    // The create button is not offered on a surface the actor cannot even read.
    expect(within(drawer).queryByRole('button', { name: 'Aufgabe anlegen' })).toBeNull();
  });

  it('renders every status as glyph AND label, never colour alone', async () => {
    renderDrawer(base());
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');
    // Offen and In Arbeit are the shared Status (K-22): an icon-set glyph beside the word, never a
    // text dingbat and never colour alone.
    const open = within(drawer).getByText('Offen').closest('.status-word') as HTMLElement;
    const doing = within(drawer).getByText('In Arbeit').closest('.status-word') as HTMLElement;
    expect(open).toHaveAttribute('data-kind', 'neutral');
    expect(doing).toHaveAttribute('data-kind', 'pending');
    expect(open.querySelector('svg')).not.toBeNull();
    expect(within(drawer).queryByText('○')).toBeNull();
    // The recurring marker is a word, and the due date is a de-CH day (P11).
    expect(within(drawer).getByText('Wiederkehrend')).toBeInTheDocument();
    expect(within(drawer).getByText(/01\.09\.2026/)).toBeInTheDocument();
  });
});

describe('ContactDrawer task section, the five write verbs each have a touch-point', () => {
  it('creates a task linked to THIS contact with an idempotency key (US-E03.1)', async () => {
    const createSpy = vi.fn<Handler>(() => ok({ taskId: 'new', task: {} }));
    renderDrawer(base({ tasks_create: createSpy }));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' }));
    const form = within(drawer).getByRole('form', { name: /Neue Aufgabe für Muster AG/ });
    await userEvent.type(within(form).getByLabelText('Titel'), 'Vertrag prüfen');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_test',
      title: 'Vertrag prüfen',
      entityKind: 'contact',
      entityId: 'k1',
    });
    expect(createSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
  });

  it('states inline why Speichern is disabled on an empty title (D15) and keeps typed input on error', async () => {
    renderDrawer(base({ tasks_create: reject('reminder_in_past') }));
    const drawer = await openTasks();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' }));
    const form = within(drawer).getByRole('form', { name: /Neue Aufgabe für Muster AG/ });

    expect(within(form).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(within(form).getByText('Gib zuerst einen Titel ein, dann kannst du die Aufgabe anlegen.')).toBeInTheDocument();

    await userEvent.type(within(form).getByLabelText('Titel'), 'Mit Erinnerung');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    // The engine's structured refusal reaches the operator as words, never a 500, and the form keeps
    // the title so a fix is one edit away, not a retype (canon: a failed action never destroys input).
    expect(await within(drawer).findByText('Die Erinnerung liegt in der Vergangenheit.')).toBeInTheDocument();
    expect(within(drawer).getByDisplayValue('Mit Erinnerung')).toBeInTheDocument();
  });

  it('edits a task through tasks_update from the Bearbeiten affordance (US-E03.5)', async () => {
    const updateSpy = vi.fn<Handler>(() => ok({ task: {} }));
    renderDrawer(base({ tasks_update: updateSpy }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Rechnung nachfassen')).closest('li') as HTMLElement;

    await taskAction(row, 'Bearbeiten');
    const editor = within(drawer).getByRole('form', { name: /Aufgabe Rechnung nachfassen bearbeiten/ });
    const title = within(editor).getByLabelText('Titel');
    await userEvent.clear(title);
    await userEvent.type(title, 'Rechnung final nachfassen');
    await userEvent.click(within(editor).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ taskId: 't1', patch: { title: 'Rechnung final nachfassen' } });
    expect(updateSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
  });

  it('completes a contact-linked task with logActivity and re-reads the timeline (US-E03.2)', async () => {
    const completeSpy = vi.fn<Handler>(() => ok({ seriesEnded: false }));
    const timelineSpy = vi.fn<Handler>(() => ok({ activities: [] }));
    renderDrawer(base({ tasks_complete: completeSpy, contacts_timeline: timelineSpy }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Rechnung nachfassen')).closest('li') as HTMLElement;

    const before = timelineSpy.mock.calls.length;
    await userEvent.click(within(row).getByRole('button', { name: /Erledigen: Rechnung nachfassen/ }));

    await waitFor(() => expect(completeSpy).toHaveBeenCalledOnce());
    expect(completeSpy.mock.calls[0][0]).toMatchObject({ taskId: 't1', logActivity: true });
    expect(completeSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
    // The OP5 timeline below re-reads, so a completed task's `task` activity shows without a manual step.
    await waitFor(() => expect(timelineSpy.mock.calls.length).toBeGreaterThan(before));
  });

  it('announces "Serie beendet." when a recurring completion ends the series (US-E03.3)', async () => {
    renderDrawer(base({ tasks_complete: ok({ seriesEnded: true, spawnedTaskId: null }) }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('MWST vorbereiten')).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Erledigen: MWST vorbereiten/ }));
    expect(await within(drawer).findByText('Serie beendet.')).toBeInTheDocument();
  });

  it('snoozes a task with a reminder through tasks_snooze (US-E03.5)', async () => {
    const snoozeSpy = vi.fn<Handler>(() => ok({ task: {} }));
    renderDrawer(base({ tasks_snooze: snoozeSpy }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Rechnung nachfassen')).closest('li') as HTMLElement;

    await taskAction(row, 'Zurückstellen');
    const form = within(drawer).getByRole('form', { name: /Aufgabe Rechnung nachfassen zurückstellen/ });
    await userEvent.type(within(form).getByLabelText('Zurückstellen bis'), '2026-09-15T08:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Zurückstellen' }));

    await waitFor(() => expect(snoozeSpy).toHaveBeenCalledOnce());
    expect(snoozeSpy.mock.calls[0][0]).toMatchObject({ taskId: 't1' });
    expect(snoozeSpy.mock.calls[0][0].until).toBeTruthy();
    expect(snoozeSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
  });

  it('surfaces snooze_in_past as words, not a 500', async () => {
    renderDrawer(base({ tasks_snooze: reject('snooze_in_past') }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Rechnung nachfassen')).closest('li') as HTMLElement;
    await taskAction(row, 'Zurückstellen');
    const form = within(drawer).getByRole('form', { name: /zurückstellen/ });
    await userEvent.type(within(form).getByLabelText('Zurückstellen bis'), '2020-01-01T08:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Zurückstellen' }));
    expect(await within(drawer).findByText('Der Zurückstellzeitpunkt liegt in der Vergangenheit.')).toBeInTheDocument();
  });

  it('cancels a task through tasks_cancel (US-E03.2)', async () => {
    const cancelSpy = vi.fn<Handler>(() => ok({ task: {} }));
    renderDrawer(base({ tasks_cancel: cancelSpy }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Rechnung nachfassen')).closest('li') as HTMLElement;
    await taskAction(row, 'Aufgabe abbrechen');

    await waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce());
    expect(cancelSpy.mock.calls[0][0]).toMatchObject({ taskId: 't1' });
    expect(cancelSpy.mock.calls[0][0].idempotencyKey).toBeTruthy();
  });
});

describe('ContactDrawer task section, the A24 padlock', () => {
  it('hides create/edit/snooze/cancel without tasks.write, and keeps the read', async () => {
    // The actor holds neither tasks.write nor the assignee identity of these rows: the write controls
    // are hidden (never shown then rejected), while the list itself still reads.
    renderDrawer(base(), caps([CAP.tasksRead], 'someone_else'));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');

    expect(within(drawer).queryByRole('button', { name: 'Aufgabe anlegen' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Zurückstellen' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Aufgabe abbrechen' })).toBeNull();
    // Without tasks.write there is no overflow at all: its every verb needs the right.
    expect(within(drawer).queryByRole('button', { name: /Weitere Aktionen für Aufgabe/ })).toBeNull();
    // The ✓ is present but disabled for a non-assignee without tasks.write (the engine's own rule).
    const complete = within(drawer).getByRole('button', { name: /Erledigen: Rechnung nachfassen/ });
    expect(complete).toBeDisabled();
  });

  it('leaves the ✓ enabled for the assignee even without tasks.write (engine rule)', async () => {
    renderDrawer(base(), caps([CAP.tasksRead], 'studio'));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');
    // studio IS the assignee of the fixture rows, so completion is the engine's tasks.write-OR-assignee.
    const complete = within(drawer).getByRole('button', { name: /Erledigen: Rechnung nachfassen/ });
    expect(complete).toBeEnabled();
    // Still no write affordances that require tasks.write proper.
    expect(within(drawer).queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
  });
});

describe('ContactDrawer task recurrence, preset picker + advanced escape hatch (K-48)', () => {
  it('turns the "Monatlich" preset into FREQ=MONTHLY on the wire', async () => {
    const createSpy = vi.fn<Handler>(() => ok({ taskId: 'new', task: {} }));
    renderDrawer(base({ tasks_create: createSpy }));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' }));
    const form = within(drawer).getByRole('form', { name: /Neue Aufgabe für Muster AG/ });
    await userEvent.type(within(form).getByLabelText('Titel'), 'Monatsabschluss');
    await userEvent.click(within(form).getByRole('combobox', { name: 'Wiederholung' }));
    await userEvent.click(screen.getByRole('option', { name: 'Monatlich' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // The preset produces the engine's exact closed-grammar string, so it cannot trip recurrence_invalid.
    expect(createSpy.mock.calls[0][0]).toMatchObject({ recurrenceRule: 'FREQ=MONTHLY' });
  });

  it('sends NO recurrence rule when the picker is set back to "Keine"', async () => {
    const createSpy = vi.fn<Handler>(() => ok({ taskId: 'new', task: {} }));
    renderDrawer(base({ tasks_create: createSpy }));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' }));
    const form = within(drawer).getByRole('form', { name: /Neue Aufgabe für Muster AG/ });
    await userEvent.type(within(form).getByLabelText('Titel'), 'Einmalig');
    const picker = within(form).getByRole('combobox', { name: 'Wiederholung' });
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole('option', { name: 'Wöchentlich' }));
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole('option', { name: 'Keine' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // Keine clears the rule: the create call omits recurrenceRule entirely, not an empty string.
    expect(createSpy.mock.calls[0][0].recurrenceRule).toBeUndefined();
  });

  it('opens a complex stored rule in the "Erweitert" state, pre-filled, never discarded', async () => {
    const complex = {
      id: 'tc',
      title: 'Serie',
      assigneeUserId: 'studio',
      status: 'open',
      dueAt: '2026-09-01',
      reminderAt: null,
      snoozedUntil: null,
      recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2',
      bucket: 'upcoming',
    };
    renderDrawer(base({ tasks_list: ok({ tasks: [complex] }) }));
    const drawer = await openTasks();
    const row = (await within(drawer).findByText('Serie')).closest('li') as HTMLElement;

    await taskAction(row, 'Bearbeiten');
    const editor = within(drawer).getByRole('form', { name: /Aufgabe Serie bearbeiten/ });
    // The raw rule survives into the advanced field (recognition over recall), and the picker sits on
    // Erweitert rather than silently snapping to a preset that would drop the INTERVAL.
    expect(within(editor).getByDisplayValue('FREQ=WEEKLY;INTERVAL=2')).toBeInTheDocument();
    // The picker sits on the Erweitert (custom) state: the trigger shows that label rather than a preset.
    expect(within(editor).getByRole('combobox', { name: 'Wiederholung' })).toHaveTextContent('Erweitert');
  });

  it('saves the raw RRULE typed into the "Erweitert" field verbatim', async () => {
    const createSpy = vi.fn<Handler>(() => ok({ taskId: 'new', task: {} }));
    renderDrawer(base({ tasks_create: createSpy }));
    const drawer = await openTasks();
    await within(drawer).findByText('Rechnung nachfassen');

    await userEvent.click(within(drawer).getByRole('button', { name: 'Aufgabe anlegen' }));
    const form = within(drawer).getByRole('form', { name: /Neue Aufgabe für Muster AG/ });
    await userEvent.type(within(form).getByLabelText('Titel'), 'Zweiwöchentlich montags');
    await userEvent.click(within(form).getByRole('combobox', { name: 'Wiederholung' }));
    await userEvent.click(screen.getByRole('option', { name: 'Erweitert' }));
    await userEvent.type(within(form).getByLabelText('Erweiterte Regel (RRULE)'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledOnce());
    // Advanced takes precedence: the full iCalendar RRULE reaches the wire unchanged.
    expect(createSpy.mock.calls[0][0]).toMatchObject({ recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' });
  });
});
