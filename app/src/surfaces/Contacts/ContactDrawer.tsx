/**
 * ContactDrawer, C00's detail drawer over the existing Kontakte route (spec C00 §6).
 *
 * Three tabs, which is the whole of C00's read surface for one relationship:
 *
 *   Stammdaten  the identity facts A09 already holds, plus C00's kind, employer link and tag chips.
 *   Verlauf     the OP5 activity timeline (glyph per kind) and the one-tap "Notiz erfassen".
 *   Finanzen    the A09-owned financial summary, read-only here. A09 owns the numbers; C00 owns the
 *               place they are shown, so this tab states what it does not yet carry rather than
 *               rendering an empty frame that looks like a load that failed.
 *
 * The tabs are a real ARIA tablist with arrow-key navigation, so the drawer is keyboard-reachable in
 * a logical order (WCAG 2.2 AA). Anonymisieren lives here behind a TYPED confirm, because it is the
 * revDSG erasure path and an accidental click must not be able to reach it.
 *
 * ## BUILT ON THE SHARED DetailDrawer PRIMITIVE (D118 B2, 2026-08-23)
 *
 * The edge panel, its scrim, the focus trap (Tab cannot walk out to the list behind it), Escape-to-
 * close and focus-restore are all the shared `DetailDrawer`'s now, which is precisely the model the
 * primitive was grounded in: the bespoke drawer had neither a focus trap nor Escape. The tab strip is
 * the shared `Tabs` (K-11, D137) in its SHARED-PANEL model: the caller renders only the active view,
 * because each panel loads its own data on open (the timeline, the tasks, the two portal panels) and
 * mounting all four would fire every one of those reads at once. The C3 `Provenance` line is not
 * shown: the contact read model carries no actor/origin/trace, only an optional `createdAt`.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { formatCalendar } from '../../lib/format';
import { useCan, useCapabilities, CAP } from '../../lib/capabilities';
import { DetailDrawer } from '../../components/DetailDrawer';
import { ErrorBanner, PermissionDenied, Skeleton } from '../../components/states';
import { ActionFeedback } from '../../components/ActionFeedback';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';
import { Tabs } from '../../components/Tabs';
import type { Err } from '../../lib/client';
import { ActivityGlyph, KindGlyph } from './glyphs';
import { VendorPortalPanel } from './VendorPortalPanel';
import { LinkedFiles } from '../Files/LinkedFiles';
import {
  ACTIVITY_KINDS,
  addressOf,
  idemKey,
  kindOf,
  tagsOf,
  type Activity,
  type ActivityKind,
  type Contact,
} from './model';

type Tab = 'master' | 'timeline' | 'finance' | 'portal';
const TABS: readonly Tab[] = ['master', 'timeline', 'finance', 'portal'];

export interface ContactDrawerProps {
  contact: Contact;
  workspaceId: string;
  /** Every contact currently loaded, so the employer link can be resolved to a name. */
  contacts: readonly Contact[];
  onClose: () => void;
  onEdit: () => void;
  /** Called after a write that changes the row, so the list can reload. */
  onChanged: () => void;
}

export function ContactDrawer({
  contact,
  workspaceId,
  contacts,
  onClose,
  onEdit,
  onChanged,
}: ContactDrawerProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('master');
  // A24. Bearbeiten is an ordinary write on `manage_master_data`; Anonymisieren is the revDSG erasure
  // path and since the F5 retrofit the engine requires `contacts.merge` AS WELL (the ALL-OF in
  // `actionCapabilities.ts`), so its affordance renders only when both are held. Neither is rendered
  // for an actor the engine would refuse (the padlock pattern, never shown-then-rejected). The TYPED
  // confirm inside `AnonymiseAction` is a separate and still-necessary guard: permission answers WHO
  // may, the typed word answers WHETHER they meant to.
  const canManage = useCan(CAP.manageMasterData);
  const canAnonymise = useCan(CAP.contactsMerge) && canManage;

  const kindMark = (
    <span className="ct-kind-mark">
      <KindGlyph kind={kindOf(contact)} />
      <span className="visually-hidden">{t(`contact.kind.${kindOf(contact)}`)}</span>
    </span>
  );

  const footer = canManage ? (
    <>
      {canAnonymise && <AnonymiseAction contact={contact} workspaceId={workspaceId} onDone={onChanged} />}
      <button type="button" className="btn btn--secondary" onClick={onEdit}>
        {t('contact.edit')}
      </button>
    </>
  ) : undefined;

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={contact.name}
      closeLabel={t('contact.close')}
      headerExtra={kindMark}
      footer={footer}
    >
      <Tabs
        label={t('contact.tabs')}
        tabs={TABS.map((id) => ({ id, label: t(`contact.tab.${id}`) }))}
        activeId={tab}
        onChange={(id) => setTab(id as Tab)}
      >
        <div className="ct-tabpanel">
          {tab === 'master' && (
            <MasterTab contact={contact} contacts={contacts} workspaceId={workspaceId} onChanged={onChanged} />
          )}
          {tab === 'timeline' && <TimelineTab contact={contact} workspaceId={workspaceId} />}
          {tab === 'finance' && <FinanceTab />}
          {tab === 'portal' && (
            <>
              {/* F02 customer portal for a customer/both contact; F03 vendor portal for a vendor/both
                  contact. A `both` contact shows both sections, each self-contained. */}
              {contact.partyRole !== 'vendor' && <PortalTab contact={contact} workspaceId={workspaceId} />}
              {contact.partyRole !== 'customer' && (
                <VendorPortalPanel contact={contact} workspaceId={workspaceId} />
              )}
            </>
          )}
        </div>
      </Tabs>
    </DetailDrawer>
  );
}

/** Stammdaten: the identity facts, the employer link, and the tag chips (US-C00.1, US-C00.2). */
function MasterTab({
  contact,
  contacts,
  workspaceId,
  onChanged,
}: {
  contact: Contact;
  contacts: readonly Contact[];
  workspaceId: string;
  onChanged: () => void;
}) {
  const t = useT();
  const address = addressOf(contact as unknown as Record<string, unknown>);
  const employer = contacts.find((c) => c.id === contact.companyContactId);
  const people = contacts.filter((c) => c.companyContactId === contact.id);

  return (
    <>
      <dl className="ct-facts">
        <dt>{t('contact.kindLabel')}</dt>
        <dd>{t(`contact.kind.${kindOf(contact)}`)}</dd>
        <dt>{t('contact.partyRole')}</dt>
        <dd>{t(`contact.role.${contact.partyRole}`)}</dd>
        {contact.vatNumber != null && contact.vatNumber !== '' && (
          <>
            <dt>{t('contact.vatNumber')}</dt>
            <dd className="t-num">{contact.vatNumber}</dd>
          </>
        )}
        {contact.email != null && contact.email !== '' && (
          <>
            <dt>{t('contact.email')}</dt>
            <dd>{contact.email}</dd>
          </>
        )}
        {address.city !== undefined && address.city !== '' && (
          <>
            <dt>{t('contact.city')}</dt>
            <dd>{address.city}</dd>
          </>
        )}
        {/* The employer link, shown only for a person that has one (US-C00.1). */}
        {employer !== undefined && (
          <>
            <dt>{t('contact.field.employer')}</dt>
            <dd>{employer.name}</dd>
          </>
        )}
      </dl>

      {/* A company's Personen section: the org structure modelled rather than flattened. */}
      {kindOf(contact) === 'company' && people.length > 0 && (
        <section className="ct-subsection">
          <h3 className="ct-subsection-title">{t('contact.people')}</h3>
          <ul className="ct-people">
            {people.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
          </ul>
        </section>
      )}

      {/* The chips READ for everyone; only the add-a-segment field is a write, so the section renders
          either way and `canManage` decides whether it can be added to. */}
      <TagEditor contact={contact} workspaceId={workspaceId} onChanged={onChanged} />

      {/* E06 consent (US-E06.2): the ONE switch that lets a draft consult this client's books.
          Deliberately C00's own write path (`update_contact` patch), never an E06 tool. */}
      <ConsentToggle contact={contact} workspaceId={workspaceId} onChanged={onChanged} />

      {/* E00: the shared Dateien panel, parameterised by the OP3 pair. A signed contract or a copy of
          the vendor's ID files against the contact here, in the ONE attachment UI, never a copy. */}
      <LinkedFiles workspaceId={workspaceId} entityKind="contact" entityId={contact.id} />
    </>
  );
}

/**
 * "Buchhaltung einbeziehen" (E06 US-E06.2): a per-client consent the practitioner decides once and
 * can see. OFF by default; the honest note says nothing is sent anywhere EITHER WAY, because the
 * grounding happens on this device and TILL has no send path at all. Rides `update_contact`
 * (`contact` is C00's table, one table takes one write path), so it obeys the same
 * `manage_master_data` gate as every other field in this drawer.
 */
function ConsentToggle({
  contact,
  workspaceId,
  onChanged,
}: {
  contact: Contact;
  workspaceId: string;
  onChanged: () => void;
}) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.manageMasterData);
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = contact.ledgerGroundingEnabled === true;

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    const resp = await client.call('update_contact', {
      workspaceId,
      contactId: contact.id,
      patch: { ledgerGroundingEnabled: next },
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    onChanged();
  }

  return (
    <section className="ct-subsection">
      <h3 className="ct-subsection-title">{t('contact.consent.title')}</h3>
      {error !== null && <ErrorBanner error={error} />}
      <label className="ct-consent-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canManage || saving}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{t('contact.consent.toggle')}</span>
      </label>
      <p className="ct-field-hint">{t('contact.consent.note')}</p>
    </section>
  );
}

/** The segment chips and the add-a-segment field, both driving `contacts_tag` (US-C00.2). */
function TagEditor({
  contact,
  workspaceId,
  onChanged,
}: {
  contact: Contact;
  workspaceId: string;
  onChanged: () => void;
}) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.manageMasterData);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);
  const segments = tagsOf(contact, 'segments');

  async function addSegment() {
    const value = draft.trim();
    if (value === '') return;
    setSaving(true);
    setError(null);
    const resp = await client.call('contacts_tag', {
      workspaceId,
      contactId: contact.id,
      segments: [value],
      idempotencyKey: idemKey('tag'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    setDraft('');
    onChanged();
  }

  return (
    <section className="ct-subsection">
      <h3 className="ct-subsection-title">{t('contact.segmentsTitle')}</h3>
      {error !== null && <ErrorBanner error={error} />}
      {segments.length === 0 ? (
        <p className="ct-field-hint">{t('contact.segments.empty')}</p>
      ) : (
        <ul className="ct-chips">
          {segments.map((s) => (
            <li key={s} className="ct-chip">
              {s}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <>
          <div className="ct-field-row">
            <label className="ct-field-inner">
              <span className="ct-field-label">{t('contact.segments.add')}</span>
              <input
                className="field"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={saving || draft.trim() === ''}
              onClick={() => void addSegment()}
            >
              {t('contact.segments.addAction')}
            </button>
          </div>
          {/* D15: a disabled primary action states WHY it is disabled, inline, not sitting dead. */}
          {draft.trim() === '' && <span className="ct-field-hint">{t('contact.segments.addHint')}</span>}
        </>
      )}
    </section>
  );
}

// --- E03, the per-contact task list (spec E03 §6) ----------------------------------------------
// The OP3 entity drawer "gains a compact task list + Aufgabe anlegen". It rides the Verlauf tab, the
// one drawer tab that already hosts the OP5 timeline, and leads it: what is still due is
// forward-looking and actionable, the log below is what already happened. Every read filters on this
// contact (`entityKind:'contact'`), and all five lifecycle writes (create, edit, complete, snooze,
// cancel) have a named touch-point here, so the section is the GUI face of E03's five write verbs.

/**
 * A task's state as the one `Status` word (K-22): Offen is neutral, In Arbeit under way, Erledigt done
 * and Abgebrochen out of play. The glyph comes from the icon set with the word, never a text dingbat.
 */
const TASK_STATUS_KIND: Record<string, StatusKind> = {
  open: 'neutral',
  doing: 'pending',
  done: 'success',
  cancelled: 'inactive',
};

interface DrawerTask {
  id: string;
  title: string;
  assigneeUserId: string;
  dueAt: string | null;
  reminderAt: string | null;
  snoozedUntil: string | null;
  status: string;
  recurrenceRule: string | null;
  bucket: string;
}

/**
 * Read the `tasks_list` payload defensively. A shape this surface cannot read is a FAILED read, not
 * an empty contact: returning `null` routes to the honest error state with a retry, never a false
 * "no tasks yet" over a broken read (the A23-U2 bug was exactly a failed read shown as empty).
 */
function parseDrawerTasks(body: unknown): DrawerTask[] | null {
  if (body === null || typeof body !== 'object') return null;
  const tasks = (body as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  const items: DrawerTask[] = [];
  for (const raw of tasks) {
    if (raw === null || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string') return null;
    items.push({
      id: row.id,
      title: row.title,
      assigneeUserId: typeof row.assigneeUserId === 'string' ? row.assigneeUserId : '',
      dueAt: typeof row.dueAt === 'string' ? row.dueAt : null,
      reminderAt: typeof row.reminderAt === 'string' ? row.reminderAt : null,
      snoozedUntil: typeof row.snoozedUntil === 'string' ? row.snoozedUntil : null,
      status: typeof row.status === 'string' ? row.status : 'open',
      recurrenceRule: typeof row.recurrenceRule === 'string' ? row.recurrenceRule : null,
      bucket: typeof row.bucket === 'string' ? row.bucket : 'upcoming',
    });
  }
  return items;
}

/** A `datetime-local` value to a sortable ISO instant; empty stays absent. */
function toReminderInstant(value: string): string | undefined {
  if (value === '') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * A stored ISO reminder instant back to a `datetime-local` value in LOCAL wall-clock, so the edit
 * editor PREFILLS the existing reminder. Without this the editor opened blank and an untouched save
 * silently wiped the reminder (`toReminderInstant('')` is null), losing the very field the operator
 * did not intend to touch (canon: a failed/edited action never destroys input it did not ask to).
 */
function toLocalReminderInput(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface TaskDraft {
  title: string;
  assigneeUserId: string;
  dueAt: string;
  reminderAt: string;
  recurrenceRule: string;
}

const EMPTY_TASK_DRAFT: TaskDraft = { title: '', assigneeUserId: '', dueAt: '', reminderAt: '', recurrenceRule: '' };

/** Map a known engine refusal to a friendly line; anything else falls to the generic message. */
function taskErrorMessage(t: (key: string, params?: Record<string, string | number>) => string, error: Err): string {
  const known = [
    'reminder_in_past',
    'reminder_after_due',
    'snooze_in_past',
    'recurrence_invalid',
    'task_not_open',
    'invalid_status_transition',
  ];
  if (known.includes(error.error)) return t(`contact.tasks.error.${error.error}`);
  return t('contact.tasks.fallbackError');
}

/**
 * The five presets, each mapping a picker key to the exact recurrence STRING it produces. `none`
 * clears the rule. These outputs are the engine's own closed grammar (src/core/tasks/recurrence.ts:
 * `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`), so a preset can never trip `recurrence_invalid`. The raw
 * value stays an RRULE-style string end to end: the picker is a friendlier way to write and read it,
 * not a new wire shape.
 */
const RECURRENCE_PRESETS = [
  { key: 'none', rule: '' },
  { key: 'daily', rule: 'FREQ=DAILY' },
  { key: 'weekly', rule: 'FREQ=WEEKLY' },
  { key: 'monthly', rule: 'FREQ=MONTHLY' },
  { key: 'yearly', rule: 'FREQ=YEARLY' },
] as const;

/** Which preset a stored rule maps to, or `custom` for any RRULE outside the five (BYDAY, INTERVAL, ...). */
function presetKeyOf(rule: string): string {
  const trimmed = rule.trim();
  const hit = RECURRENCE_PRESETS.find((p) => p.rule === trimmed);
  return hit === undefined ? 'custom' : hit.key;
}

/**
 * Preset picker + an "Erweitert" escape hatch for the full iCalendar RRULE. A wrong free-text rule
 * used to fail only server-side (`recurrence_invalid`); the picker hands most users a valid rule with
 * no typing, while power users keep the raw field.
 *
 * Recognition over recall: the picker's selection is DERIVED from the stored value, so opening a task
 * whose rule matches a preset shows that preset, and a complex rule that matches none selects
 * "Erweitert" and reveals the raw field PRE-FILLED, so an existing rule is never silently discarded.
 */
function RecurrenceField({
  value,
  onChange,
  idPrefix,
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
}) {
  const t = useT();
  const derivedKey = presetKeyOf(value);
  // An explicit "advanced open" so choosing Erweitert reveals the raw field even when the current
  // value happens to equal a preset (extending FREQ=MONTHLY by hand). A stored custom rule opens it
  // on mount; `derivedKey === 'custom'` keeps it open while the value stays outside the five.
  const [advancedOpen, setAdvancedOpen] = useState(derivedKey === 'custom');
  const showAdvanced = advancedOpen || derivedKey === 'custom';
  const selectValue = showAdvanced ? 'custom' : derivedKey;

  return (
    <div className="ct-field-inner">
      <div className="ct-field-inner">
        <span className="ct-field-label">{t('contact.tasks.field.recurrence')}</span>
        <Select
          id={`${idPrefix}-recurrence`}
          value={selectValue}
          onChange={(key) => {
            if (key === 'custom') {
              // Reveal the raw field but KEEP the current value, so the user extends what is there
              // (e.g. FREQ=MONTHLY -> add INTERVAL) rather than starting from a wiped field.
              setAdvancedOpen(true);
              return;
            }
            setAdvancedOpen(false);
            const preset = RECURRENCE_PRESETS.find((p) => p.key === key);
            onChange(preset === undefined ? '' : preset.rule);
          }}
          options={[
            ...RECURRENCE_PRESETS.map((p) => ({
              value: p.key,
              label: t(`contact.tasks.recurrence.preset.${p.key}`),
            })),
            { value: 'custom', label: t('contact.tasks.recurrence.preset.custom') },
          ]}
          ariaLabel={t('contact.tasks.field.recurrence')}
        />
      </div>
      {showAdvanced && (
        <>
          <label className="ct-field-inner">
            <span className="ct-field-label">{t('contact.tasks.recurrence.advancedLabel')}</span>
            <input
              id={`${idPrefix}-recurrence-advanced`}
              className="field"
              value={value}
              placeholder="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
          {/* Hint sits OUTSIDE the label (the surface's convention), so the field's accessible name
              stays exactly its label and does not absorb the example text. */}
          <span className="ct-field-hint">{t('contact.tasks.recurrence.advancedHint')}</span>
        </>
      )}
    </div>
  );
}

/**
 * The compact per-contact task list (US-E03.1/2/3/5). It owns the five states (loading, empty,
 * error-with-retry, populated, and the success-after-write re-read) and gates on E03's OWN
 * capabilities (`tasks.read`/`tasks.write`), NOT the drawer's `manage_master_data`: reading a
 * relationship's tasks and adding to them are different rights from editing its identity.
 *
 * The ✓ stays enabled for the ASSIGNEE even without `tasks.write`, because the engine's completion
 * rule is "tasks.write OR assignee" and pre-disabling the very allowance the engine makes would be
 * the Studio inventing a stricter policy than the product has (the standing Studio rule).
 */
function ContactTasksSection({
  contact,
  workspaceId,
  onActivityLogged,
}: {
  contact: Contact;
  workspaceId: string;
  onActivityLogged: () => void;
}) {
  const t = useT();
  const client = useClient();
  const { can, whoami } = useCapabilities();
  const canWrite = can(CAP.tasksWrite);

  const [tasks, setTasks] = useState<DrawerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_TASK_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<TaskDraft>(EMPTY_TASK_DRAFT);
  const [snoozingId, setSnoozingId] = useState<string | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const resp = await client.call('tasks_list', { workspaceId, entityKind: 'contact', entityId: contact.id });
    if (isErr(resp.body)) {
      if (resp.body.error === 'permission_denied' || resp.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseDrawerTasks(resp.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setTasks(parsed);
    setLoading(false);
  }, [client, workspaceId, contact.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a write, surface the engine's own refusal, and re-read on success (the five verbs' path). */
  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setWriteError(null);
      const resp = await client.call(action, { workspaceId, ...input });
      if (isErr(resp.body)) {
        setWriteError(resp.body);
        return null;
      }
      await load();
      return resp.body as unknown as Record<string, unknown>;
    },
    [client, workspaceId, load],
  );

  const create = useCallback(async () => {
    const body = await write('tasks_create', {
      title: draft.title,
      assigneeUserId: draft.assigneeUserId === '' ? (whoami?.actor ?? 'studio') : draft.assigneeUserId,
      entityKind: 'contact',
      entityId: contact.id,
      ...(draft.dueAt === '' ? {} : { dueAt: draft.dueAt }),
      ...(toReminderInstant(draft.reminderAt) === undefined ? {} : { reminderAt: toReminderInstant(draft.reminderAt) }),
      ...(draft.recurrenceRule.trim() === '' ? {} : { recurrenceRule: draft.recurrenceRule.trim() }),
      idempotencyKey: idemKey('task-create'),
    });
    if (body !== null) {
      setCreating(false);
      setDraft(EMPTY_TASK_DRAFT);
    }
  }, [write, draft, whoami, contact.id]);

  const saveEdit = useCallback(
    async (taskId: string) => {
      const patch: Record<string, unknown> = { title: edit.title };
      if (edit.assigneeUserId !== '') patch.assigneeUserId = edit.assigneeUserId;
      patch.dueAt = edit.dueAt === '' ? null : edit.dueAt;
      patch.reminderAt = toReminderInstant(edit.reminderAt) ?? null;
      // The editor now shows and owns the recurrence rule, so send it: an empty picker clears it,
      // an unchanged rule re-sends the same RRULE string (the engine keeps it). The value is loaded
      // from the task on open, so opening an existing rule and saving never discards it.
      patch.recurrenceRule = edit.recurrenceRule.trim() === '' ? null : edit.recurrenceRule.trim();
      const body = await write('tasks_update', { taskId, patch, idempotencyKey: idemKey('task-update') });
      if (body !== null) setEditingId(null);
    },
    [write, edit],
  );

  const complete = useCallback(
    async (task: DrawerTask) => {
      // Every task here is contact-linked, so log the completion onto the OP5 timeline (US-E03.2).
      // The engine owns the `contact_activity` write; the Studio only asks for it, then re-reads the
      // timeline below so the new `task` activity shows without a manual refresh.
      const body = await write('tasks_complete', {
        taskId: task.id,
        logActivity: true,
        idempotencyKey: idemKey('task-complete'),
      });
      if (body !== null) {
        if (body.seriesEnded === true) setNotice(t('contact.tasks.recurring.seriesEnded'));
        onActivityLogged();
      }
    },
    [write, t, onActivityLogged],
  );

  const snooze = useCallback(
    async (taskId: string) => {
      const until = toReminderInstant(snoozeUntil);
      if (until === undefined) return;
      const body = await write('tasks_snooze', { taskId, until, idempotencyKey: idemKey('task-snooze') });
      if (body !== null) {
        setSnoozingId(null);
        setSnoozeUntil('');
      }
    },
    [write, snoozeUntil],
  );

  const cancel = useCallback(
    (taskId: string) => {
      void write('tasks_cancel', { taskId, idempotencyKey: idemKey('task-cancel') });
    },
    [write],
  );

  const editorFields = (value: TaskDraft, onChange: (next: TaskDraft) => void, idPrefix: string) => (
    <div className="ct-task-editor-fields">
      <label className="ct-field-inner">
        <span className="ct-field-label">{t('contact.tasks.field.title')}</span>
        <input
          id={`${idPrefix}-title`}
          className="field"
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          required
        />
      </label>
      <label className="ct-field-inner">
        <span className="ct-field-label">{t('contact.tasks.field.assignee')}</span>
        <input
          id={`${idPrefix}-assignee`}
          className="field"
          value={value.assigneeUserId}
          placeholder={whoami?.actor ?? ''}
          onChange={(event) => onChange({ ...value, assigneeUserId: event.target.value })}
        />
      </label>
      <label className="ct-field-inner">
        <span className="ct-field-label">{t('contact.tasks.field.due')}</span>
        <input
          id={`${idPrefix}-due`}
          className="field"
          type="date"
          value={value.dueAt}
          onChange={(event) => onChange({ ...value, dueAt: event.target.value })}
        />
      </label>
      <label className="ct-field-inner">
        <span className="ct-field-label">{t('contact.tasks.field.reminder')}</span>
        <input
          id={`${idPrefix}-reminder`}
          className="field"
          type="datetime-local"
          value={value.reminderAt}
          onChange={(event) => onChange({ ...value, reminderAt: event.target.value })}
        />
      </label>
    </div>
  );

  return (
    <section className="ct-subsection ct-tasks">
      <div className="ct-tasks-head">
        <h3 className="ct-subsection-title">
          {t('contact.tasks.title')}
          {!loading && !denied && !failed && tasks.length > 0 && <span className="ct-tasks-count">{tasks.length}</span>}
        </h3>
        {canWrite && !denied && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCreating(!creating)}>
            {t('contact.tasks.action.create')}
          </button>
        )}
      </div>

      {notice !== null && (
        <ActionFeedback
          tone="info"
          message={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('contact.close')}
        />
      )}
      {writeError !== null && <ErrorBanner message={taskErrorMessage(t, writeError)} />}

      {creating && canWrite && (
        <form
          className="ct-task-editor"
          aria-label={t('contact.tasks.createLabel', { name: contact.name })}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {editorFields(draft, setDraft, 'ct-task-create')}
          <RecurrenceField
            value={draft.recurrenceRule}
            onChange={(next) => setDraft({ ...draft, recurrenceRule: next })}
            idPrefix="ct-task-create"
          />
          <div className="ct-task-editor-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={draft.title.trim() === ''}>
              {t('contact.tasks.action.save')}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                // Discard means discard: clear the draft so a refused attempt (e.g. a past reminder)
                // does not silently survive into the next Aufgabe anlegen and get resubmitted.
                setCreating(false);
                setDraft(EMPTY_TASK_DRAFT);
                setWriteError(null);
              }}
            >
              {t('contact.tasks.action.discard')}
            </button>
          </div>
          {/* D15: a disabled primary action says WHAT is missing rather than sitting dead. */}
          {draft.title.trim() === '' && <span className="ct-field-hint">{t('contact.tasks.titleHint')}</span>}
        </form>
      )}

      {loading ? (
        <div role="status" aria-busy="true">
          <span className="visually-hidden">{t('contact.tasks.loading')}</span>
          <Skeleton rows={2} height={32} />
        </div>
      ) : denied ? (
        <PermissionDenied body={t('contact.tasks.permissionDenied')} />
      ) : failed ? (
        <ErrorBanner context="read" message={t('contact.tasks.loadFailed')} onRetry={() => void load()} />
      ) : tasks.length === 0 ? (
        <p className="ct-field-hint">{t('contact.tasks.empty')}</p>
      ) : (
        <ul className="ct-tasks-list">
          {tasks.map((task) => {
            const live = task.status === 'open' || task.status === 'doing';
            const mayComplete = canWrite || whoami === null || whoami.actor === task.assigneeUserId;
            const snoozePastDue =
              task.dueAt !== null &&
              snoozeUntil !== '' &&
              toReminderInstant(snoozeUntil) !== undefined &&
              new Date(toReminderInstant(snoozeUntil) as string).getTime() > new Date(task.dueAt).getTime();
            return (
              <li key={task.id} className="ct-task-row">
                <div className="ct-task-main">
                  {/* glyph AND word: a status is never signalled by glyph or colour alone (WCAG 1.4.1). */}
                  <Status
                    className="ct-task-status"
                    kind={TASK_STATUS_KIND[task.status] ?? 'neutral'}
                    label={t(`contact.tasks.status.${task.status}`)}
                  />
                  <span className="ct-task-title">{task.title}</span>
                  {task.recurrenceRule !== null && (
                    <span className="ct-task-badge" title={task.recurrenceRule}>
                      {t('contact.tasks.recurring.badge')}
                    </span>
                  )}
                </div>
                {(task.dueAt !== null || task.reminderAt !== null) && (
                  <div className="ct-task-meta t-num">
                    {task.dueAt !== null && (
                      <span>
                        {t('contact.tasks.field.due')}: {formatDate(task.dueAt.slice(0, 10))}
                      </span>
                    )}
                    {task.reminderAt !== null && (
                      <span>
                        {t('contact.tasks.field.reminder')}: {formatDate(task.reminderAt.slice(0, 10))}
                        {task.snoozedUntil !== null &&
                          ` (${t('contact.tasks.snoozedUntil', { until: formatDate(task.snoozedUntil.slice(0, 10)) })})`}
                      </span>
                    )}
                  </div>
                )}
                {live && (
                  // K-21: a task card keeps ONE quiet verb in the open, Erledigen, and every other one
                  // (Bearbeiten, Zurückstellen, Abbrechen) behind its overflow, the cancel last.
                  <div className="ct-task-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={!mayComplete}
                      aria-label={`${t('contact.tasks.action.complete')}: ${task.title}`}
                      onClick={() => void complete(task)}
                    >
                      {t('contact.tasks.action.complete')}
                    </button>
                    {canWrite && (
                      <OverflowMenu
                        quiet
                        label={t('contact.tasks.rowActions', { title: task.title })}
                        items={[
                          {
                            key: 'edit',
                            label: t('contact.tasks.action.edit'),
                            onSelect: () => {
                              setEditingId(editingId === task.id ? null : task.id);
                              setEdit({
                                title: task.title,
                                assigneeUserId: task.assigneeUserId,
                                dueAt: task.dueAt?.slice(0, 10) ?? '',
                                reminderAt: toLocalReminderInput(task.reminderAt),
                                recurrenceRule: task.recurrenceRule ?? '',
                              });
                            },
                          },
                          ...(task.reminderAt !== null
                            ? [
                                {
                                  key: 'snooze',
                                  label: t('contact.tasks.action.snooze'),
                                  onSelect: () => {
                                    setSnoozingId(snoozingId === task.id ? null : task.id);
                                    setSnoozeUntil('');
                                  },
                                },
                              ]
                            : []),
                          {
                            key: 'cancel',
                            label: t('contact.tasks.action.cancel'),
                            danger: true,
                            onSelect: () => cancel(task.id),
                          },
                        ]}
                      />
                    )}
                  </div>
                )}
                {editingId === task.id && (
                  <form
                    className="ct-task-editor"
                    aria-label={t('contact.tasks.editLabel', { title: task.title })}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEdit(task.id);
                    }}
                  >
                    {editorFields(edit, setEdit, `ct-task-edit-${task.id}`)}
                    <RecurrenceField
                      value={edit.recurrenceRule}
                      onChange={(next) => setEdit({ ...edit, recurrenceRule: next })}
                      idPrefix={`ct-task-edit-${task.id}`}
                    />
                    <div className="ct-task-editor-actions">
                      <button type="submit" className="btn btn--primary btn--sm" disabled={edit.title.trim() === ''}>
                        {t('contact.tasks.action.save')}
                      </button>
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditingId(null)}>
                        {t('contact.tasks.action.discard')}
                      </button>
                    </div>
                  </form>
                )}
                {snoozingId === task.id && (
                  <form
                    className="ct-task-editor"
                    aria-label={t('contact.tasks.snoozeLabel', { title: task.title })}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void snooze(task.id);
                    }}
                  >
                    <label className="ct-field-inner">
                      <span className="ct-field-label">{t('contact.tasks.snoozeUntil')}</span>
                      <input
                        className="field"
                        type="datetime-local"
                        value={snoozeUntil}
                        onChange={(event) => setSnoozeUntil(event.target.value)}
                        required
                      />
                    </label>
                    {/* US-E03.5 boundary: snoozing past the deadline is allowed, but the UI warns once. */}
                    {snoozePastDue && <span className="ct-field-hint">{t('contact.tasks.warnReminderAfterDue')}</span>}
                    <div className="ct-task-editor-actions">
                      <button type="submit" className="btn btn--primary btn--sm">
                        {t('contact.tasks.action.snooze')}
                      </button>
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSnoozingId(null)}>
                        {t('contact.tasks.action.discard')}
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Verlauf: the OP5 timeline plus the log-an-activity form (US-C00.3). */
function TimelineTab({ contact, workspaceId }: { contact: Contact; workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.manageMasterData);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);

  const [kind, setKind] = useState<ActivityKind>('note');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const resp = await client.call('contacts_timeline', { workspaceId, contactId: contact.id });
    if (isErr(resp.body)) {
      setError(resp.body);
      setLoading(false);
      return;
    }
    const raw = (resp.body as { activities?: unknown }).activities;
    setActivities(Array.isArray(raw) ? (raw as Activity[]) : []);
    setLoading(false);
  }, [client, workspaceId, contact.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function logIt() {
    const text = body.trim();
    if (text === '') return;
    setSaving(true);
    setWriteError(null);
    const resp = await client.call('contacts_log_activity', {
      workspaceId,
      contactId: contact.id,
      kind,
      body: text,
      idempotencyKey: idemKey('act'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    setBody('');
    void load();
  }

  return (
    <>
      {/* E03 §6: the per-entity task list rides the drawer that already hosts the OP5 timeline. It
          leads the tab because "what is still due" is forward-looking and actionable, while the log
          below it is the record of what happened. A contact-linked completion appends a `task`
          activity via the engine (never a direct write here), so a completed task surfaces in the
          timeline below on the same reload. */}
      <ContactTasksSection contact={contact} workspaceId={workspaceId} onActivityLogged={load} />

      {writeError !== null && <ErrorBanner error={writeError} />}

      {/* Spec §6/US-C00.3: without `contacts.write` the Verlauf tab is READ-ONLY and the "Notiz
          erfassen" affordance is hidden. The timeline below still reads, which is the point of the
          split: reading a relationship's memory and adding to it are different rights. */}
      {canManage && (
        <section className="ct-subsection">
          <h3 className="ct-subsection-title">{t('contact.timeline.log')}</h3>
          <div className="ct-field-row">
            <div className="ct-field-inner">
              <span className="ct-field-label">{t('contact.timeline.kind')}</span>
              <Select
                value={kind}
                onChange={(value) => setKind(value as ActivityKind)}
                options={ACTIVITY_KINDS.map((k) => ({ value: k, label: t(`contact.activity.${k}`) }))}
                ariaLabel={t('contact.timeline.kind')}
              />
            </div>
          </div>
          <label className="ct-field-inner">
            <span className="ct-field-label">{t('contact.timeline.body')}</span>
            <textarea
              className="field ct-textarea"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving || body.trim() === ''}
            onClick={() => void logIt()}
          >
            {t('contact.timeline.logAction')}
          </button>
          {/* D15: the reason the primary action is disabled, stated inline, not left to guesswork. */}
          {body.trim() === '' && <span className="ct-field-hint">{t('contact.timeline.bodyHint')}</span>}
        </section>
      )}

      <section className="ct-subsection">
        <h3 className="ct-subsection-title">{t('contact.tab.timeline')}</h3>
        {loading ? (
          <Skeleton rows={3} height={32} />
        ) : error !== null ? (
          <ErrorBanner error={error} onRetry={() => void load()} context="read" />
        ) : activities.length === 0 ? (
          <p className="ct-field-hint">{t('contact.timeline.empty')}</p>
        ) : (
          <ul className="ct-timeline">
            {activities.map((a) => (
              <li key={a.id} className="ct-timeline-row">
                <span className="ct-timeline-kind">
                  <ActivityGlyph kind={a.kind} />
                  {/* glyph AND label: a kind is never colour- or icon-only (WCAG 2.2 AA). */}
                  <span className="ct-timeline-kind-label">{t(`contact.activity.${a.kind}`)}</span>
                </span>
                <span className="ct-timeline-body">{a.body}</span>
                <span className="ct-timeline-when t-num">{formatCalendar(a.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * F02, Portal-Zugang (US-F02.1/4/6): the operator's grant-management panel on the contact detail. It
 * LISTS the customer's portal grants (each with a glyph+label status, never colour-only, WCAG 2.2
 * AA), CREATES a scoped, expiring grant (showing the one-time link exactly once), and REVOKES one.
 * The hosted portal page itself is cloud-tier and out of this repo (OP4): the OSS-core surface is the
 * link artifact plus the "Lokal (nicht gehostet)" row state.
 *
 * A24: create and revoke render only with `portal.manage` (the padlock pattern, never
 * shown-then-rejected). Without it the panel is READ-ONLY: the list still reads (it rides
 * `read_master_data`, the contact-detail domain), which is the split the spec draws.
 */
interface PortalGrant {
  id: string;
  status: 'draft' | 'active' | 'revoked' | 'expired';
  expiresAt: string;
  scopes: { kind: string; id?: string | null }[];
  hosted: boolean;
}

/** A grant's state as the one `Status` word (K-22): live, not yet live, or out of play. */
const PORTAL_STATUS_KIND: Record<PortalGrant['status'], StatusKind> = {
  active: 'success',
  draft: 'neutral',
  revoked: 'inactive',
  expired: 'inactive',
};

function PortalTab({ contact, workspaceId }: { contact: Contact; workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const canManage = useCan(CAP.portalManage);
  const [grants, setGrants] = useState<PortalGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);

  const [expiresAt, setExpiresAt] = useState('');
  const [allInvoices, setAllInvoices] = useState(true);
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  // The one-time link, shown exactly once after a successful create (spec §6: "Link wird nur einmal
  // angezeigt"). Never re-derivable, so it is held in component state and never re-fetched.
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const resp = await client.call('portal_grant_list', { workspaceId, contactId: contact.id });
    if (isErr(resp.body)) {
      setError(resp.body);
      setLoading(false);
      return;
    }
    const raw = (resp.body as { grants?: unknown }).grants;
    setGrants(Array.isArray(raw) ? (raw as PortalGrant[]) : []);
    setLoading(false);
  }, [client, workspaceId, contact.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createGrant() {
    if (expiresAt === '') return;
    setSaving(true);
    setWriteError(null);
    setOneTimeLink(null);
    const resp = await client.call('portal_grant_create', {
      workspaceId,
      contactId: contact.id,
      scopes: allInvoices ? [{ kind: 'all_invoices' }] : [],
      expiresAt,
      idempotencyKey: idemKey('pgrant'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    const link = (resp.body as { localLink?: unknown }).localLink;
    if (typeof link === 'string') setOneTimeLink(link);
    void load();
  }

  async function revoke(grantId: string) {
    setWriteError(null);
    const resp = await client.call('portal_grant_revoke', {
      workspaceId,
      grantId,
      idempotencyKey: idemKey('prevoke'),
    });
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    void load();
  }

  return (
    <div className="ct-portal-section">
      {writeError !== null && <ErrorBanner error={writeError} />}

      {/* The one-time link, surfaced once with a copy affordance (aria-label, keyboard-reachable). */}
      {oneTimeLink !== null && (
        <section className="ct-subsection">
          <h3 className="ct-subsection-title">{t('portal.link.once')}</h3>
          <div className="ct-field-row">
            <input className="field" readOnly value={oneTimeLink} aria-label={t('portal.link.once')} />
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-label={t('portal.link.copyLabel')}
              onClick={() => void navigator.clipboard?.writeText(oneTimeLink)}
            >
              {t('portal.link.copy')}
            </button>
          </div>
        </section>
      )}

      {/* Create (US-F02.1). Hidden entirely without portal.manage: the panel is then read-only. */}
      {canManage && (
        <section className="ct-subsection">
          <h3 className="ct-subsection-title">{t('portal.action.create')}</h3>
          <label className="ct-field-inner">
            <span className="ct-field-label">{t('portal.field.expiresAt')}</span>
            <input
              type="date"
              className="field"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <label className="ct-checkbox">
            <input type="checkbox" checked={allInvoices} onChange={(event) => setAllInvoices(event.target.checked)} />
            <span>{t('portal.scope.all_invoices')}</span>
          </label>
          {allInvoices && <span className="ct-field-hint">{t('portal.scope.all_invoices_warning')}</span>}
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving || expiresAt === ''}
            onClick={() => void createGrant()}
          >
            {t('portal.action.create')}
          </button>
          {expiresAt === '' && <span className="ct-field-hint">{t('portal.field.expiresAtHint')}</span>}
        </section>
      )}

      <section className="ct-subsection">
        <h3 className="ct-subsection-title">{t('portal.panel.title')}</h3>
        {loading ? (
          <Skeleton rows={2} height={32} />
        ) : error !== null ? (
          <ErrorBanner error={error} onRetry={() => void load()} context="read" />
        ) : grants.length === 0 ? (
          <p className="ct-field-hint">{t('portal.empty')}</p>
        ) : (
          <ul className="ct-portal-list">
            {grants.map((g) => (
              <li key={g.id} className="ct-portal-row">
                {/* glyph AND word, never colour-only (WCAG 2.2 AA). */}
                <Status kind={PORTAL_STATUS_KIND[g.status]} label={t(`portal.status.${g.status}`)} />
                <span className="ct-portal-expiry t-num">{formatCalendar(g.expiresAt)}</span>
                {/* OP4/P9: the OSS core mints the artifact and stops; every grant is local-only here. */}
                {!g.hosted && <span className="ct-portal-hosting">{t('portal.not_hosted')}</span>}
                {canManage && g.status !== 'revoked' && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void revoke(g.id)}>
                    {t('portal.action.revoke')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Finanzen: A09's territory. It states plainly that the figures live on the financial surfaces
 * rather than rendering an empty panel, which would read as a failed load (spec C00 §6: A09 owns
 * this tab's numbers).
 */
function FinanceTab() {
  const t = useT();
  return <p className="ct-field-hint">{t('contact.finance.hint')}</p>;
}

/**
 * Anonymisieren, the revDSG erasure action, behind a TYPED confirm.
 *
 * The typed confirm is not ceremony: this blanks personal fields and redacts activity bodies, and
 * while the accounting record survives (OR 958f), the personal data around it does not come back. A
 * one-click path to that is a path somebody takes by accident.
 */
function AnonymiseAction({
  contact,
  workspaceId,
  onDone,
}: {
  contact: Contact;
  workspaceId: string;
  onDone: () => void;
}) {
  const t = useT();
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);
  const expected = t('contact.anonymise.confirmWord');

  async function run() {
    setSaving(true);
    setError(null);
    const resp = await client.call('contacts_anonymise', {
      workspaceId,
      contactId: contact.id,
      idempotencyKey: idemKey('anon'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
        {t('contact.action.anonymise')}
      </button>
    );
  }

  const matches = typed.trim() === expected;
  return (
    <div className="ct-confirm">
      {error !== null && <ErrorBanner error={error} />}
      <p className="ct-confirm-text">{t('contact.anonymise.warning', { word: expected })}</p>
      <label className="ct-field-inner">
        <span className="ct-field-label">{t('contact.anonymise.typeLabel', { word: expected })}</span>
        <input className="field" value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>
      <div className="ct-confirm-actions">
        <button type="button" className="btn btn--secondary" onClick={() => setOpen(false)}>
          {t('contact.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={!matches || saving}
          onClick={() => void run()}
        >
          {t('contact.action.anonymise')}
        </button>
      </div>
      {/* D15 again: the disabled action says what is missing, it does not just refuse to work. */}
      {!matches && <span className="ct-field-hint">{t('contact.anonymise.typeHint', { word: expected })}</span>}
    </div>
  );
}
