/**
 * N00, das Hausbuch (`/hausbuch`, rail group Einstellungen): the workspace's house notes, the conventions
 * every agent reads first in `workspace_brief`, and a look at what that brief carries.
 *
 * TWO PARTS. "Hausregeln": the active notes, grouped by what they are about (the workspace, an account, a
 * bank counterparty, a topic) with a count per group; each row says the note, its scope and who changed it
 * when, with Bearbeiten beside it and Archivieren under Mehr; "Notiz hinzufügen" is the one primary action.
 * "Was Agenten sehen": a closed disclosure that, once opened, reads `workspace_brief` and shows each
 * section's size and what it leaves out, so the owner sees the agent's first read without reading JSON.
 *
 * AN AGENT'S NOTE WAITS IN PENDENZEN. The two writes are governed by the agent dial under `customize`, so a
 * note an agent writes arrives here only once the owner approved its Vorschlag; this page is the person's
 * door and writes directly.
 *
 * Five states: the skeleton while `hausbuch_notes` is in flight; the empty state with "Notiz hinzufügen";
 * the read error with Erneut versuchen; the groups; and the padlock when the reader lacks
 * `read_master_data`. Without `manage_settings` the list is read-only, the actions hidden, and one line says
 * which right is missing. Counterparty notes a reader without `read_sales` may not see are counted, never
 * shown. Archiving answers in a status line with Rückgängig, which sets the note again on its id.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useI18n } from '../../i18n';
import { formatDate } from '../../i18n';
import { useWorkspaceId } from '../../app/workspace';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCan } from '../../lib/capabilities';
import { useMemberNames } from '../../lib/useMemberNames';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton, refusalText } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { IconButton } from '../../components/IconButton';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { ActionFeedback } from '../../components/ActionFeedback';
import './Hausbuch.css';

/** The engine's scope kinds (§H-ENUM mirror of `NOTE_SCOPE_KINDS` in `src/core/hausbuch/notes.ts`). */
export const SCOPE_KINDS = ['workspace', 'account', 'counterparty', 'topic'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** The longest note the engine stores (`NOTE_TEXT_MAX`). */
export const NOTE_TEXT_MAX = 500;

export interface HausbuchNote {
  id: string;
  scope: { kind: ScopeKind; ref: string | null; label: string | null };
  text: string;
  status: 'active' | 'archived';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The notes per scope kind, in the engine's kind order, empty groups left out. */
export function groupNotes(notes: readonly HausbuchNote[]): { kind: ScopeKind; notes: HausbuchNote[] }[] {
  return SCOPE_KINDS.map((kind) => ({ kind, notes: notes.filter((n) => n.scope.kind === kind) })).filter((g) => g.notes.length > 0);
}

let keySeq = 0;
const newKey = () => `hausbuch-${Date.now().toString(36)}-${(keySeq += 1)}`;

/** The scope a person reads: the label the engine resolved, else the reference, else the kind's word. */
function scopeText(t: (key: string, params?: Record<string, string | number>) => string, note: HausbuchNote): string {
  if (note.scope.kind === 'workspace') return t('hausbuch.scope.workspace');
  return note.scope.label ?? note.scope.ref ?? t(`hausbuch.scope.${note.scope.kind}`);
}

export function Hausbuch() {
  const workspaceId = useWorkspaceId();
  if (workspaceId === null) return <NoWorkspaceState />;
  return <HausbuchPage workspaceId={workspaceId} />;
}

export function HausbuchPage({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const client = useClient();
  const canRead = useCan(CAP.readMasterData);
  const canWrite = useCan(CAP.manageSettings);
  const names = useMemberNames();
  const [notes, setNotes] = useState<HausbuchNote[] | null>(null);
  const [withheld, setWithheld] = useState(0);
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [editing, setEditing] = useState<HausbuchNote | 'new' | null>(null);
  const [archived, setArchived] = useState<HausbuchNote | null>(null);
  const [actionError, setActionError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    const { body } = await client.call('hausbuch_notes', { workspaceId, status: 'active' });
    if (isErr(body)) {
      setLoadError(body);
      return;
    }
    setLoadError(null);
    const answer = body as unknown as { notes: HausbuchNote[]; withheld?: number };
    setNotes(answer.notes);
    setWithheld(answer.withheld ?? 0);
  }, [client, workspaceId]);

  useEffect(() => {
    if (canRead) void load();
  }, [load, canRead]);

  const who = (actor: string): string => {
    if (actor === 'agent') return t('hausbuch.actor.agent');
    if (actor === 'studio') return t('hausbuch.actor.studio');
    return names.resolve(actor).label;
  };

  async function archive(note: HausbuchNote) {
    setActionError(null);
    const { body } = await client.call('hausbuch_note_archive', { workspaceId, id: note.id, idempotencyKey: newKey() });
    if (isErr(body)) {
      setActionError(body);
      return;
    }
    setArchived(note);
    void load();
  }

  async function undoArchive(note: HausbuchNote) {
    setActionError(null);
    const scope = note.scope.ref === null ? { kind: note.scope.kind } : { kind: note.scope.kind, ref: note.scope.ref };
    const { body } = await client.call('hausbuch_note_set', { workspaceId, id: note.id, text: note.text, scope, idempotencyKey: newKey() });
    if (isErr(body)) {
      setActionError(body);
      return;
    }
    setArchived(null);
    void load();
  }

  const addButton = canWrite ? (
    <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
      {t('hausbuch.add')}
    </button>
  ) : null;

  const header = (
    <SurfaceHeader
      title={t('hausbuch.title')}
      titleId="hausbuch-title"
      subtitle={t('hausbuch.subtitle')}
      help={<SurfaceHelp surface="Hausbuch" />}
      actions={notes !== null && notes.length > 0 ? addButton : null}
    />
  );

  let body;
  if (!canRead) {
    body = <PermissionDenied body={t('hausbuch.denied')} />;
  } else if (notes === null && loadError !== null) {
    body = <ErrorBanner context="read" error={loadError} onRetry={() => void load()} />;
  } else if (notes === null) {
    body = <Skeleton rows={4} labelKey="hausbuch.loading" />;
  } else {
    body = (
      <>
        {loadError !== null && <ErrorBanner context="read" error={loadError} onRetry={() => void load()} />}
        {!canWrite && (
          <p className="status-line hausbuch-readonly" role="note">
            {t('hausbuch.readOnly')}
          </p>
        )}
        {archived !== null && (
          <ActionFeedback tone="success" message={t('hausbuch.archived', { text: archived.text })}>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void undoArchive(archived)}>
              {t('hausbuch.undo')}
            </button>
          </ActionFeedback>
        )}
        {actionError !== null && (
          <p className="status-line status-error" role="alert">
            {refusalText(t, actionError, { own: 'hausbuch.refusal' })}
          </p>
        )}
        {notes.length === 0 ? (
          <EmptyState
            title={t('hausbuch.empty.title')}
            hint={t('hausbuch.empty.hint')}
            {...(canWrite ? { action: { label: t('hausbuch.add'), onClick: () => setEditing('new') } } : {})}
          />
        ) : (
          <section className="hausbuch-notes" aria-labelledby="hausbuch-notes-title">
            <h2 id="hausbuch-notes-title" className="hausbuch-section-title">
              {t('hausbuch.notes')}
            </h2>
            {groupNotes(notes).map((group) => (
              <div key={group.kind} className="hausbuch-group" data-kind={group.kind}>
                <h3 className="hausbuch-group-title">
                  {t(`hausbuch.group.${group.kind}`)} <span className="hausbuch-count t-num">{group.notes.length}</span>
                </h3>
                <table className="hausbuch-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('hausbuch.col.note')}</th>
                      <th scope="col">{t('hausbuch.col.scope')}</th>
                      <th scope="col">{t('hausbuch.col.changed')}</th>
                      {canWrite && (
                        <th scope="col">
                          <span className="visually-hidden">{t('hausbuch.col.actions')}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {group.notes.map((note) => (
                      <tr key={note.id} data-note={note.id}>
                        <th scope="row" className="hausbuch-text">
                          {note.text}
                        </th>
                        <td>{scopeText(t, note)}</td>
                        <td className="hausbuch-changed">
                          {t('hausbuch.changedBy', { who: who(note.updatedBy), date: formatDate(note.updatedAt) })}
                        </td>
                        {canWrite && (
                          <td className="hausbuch-actions">
                            <IconButton icon="edit" small context={note.text} onClick={() => setEditing(note)} />
                            <OverflowMenu
                              label={t('hausbuch.more', { text: note.text })}
                              icon="more"
                              quiet
                              items={[{ key: 'archive', label: t('hausbuch.archive'), onSelect: () => void archive(note) }]}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        )}
        {withheld > 0 && (
          <p className="status-line hausbuch-withheld" role="note">
            {t('hausbuch.withheld', { count: withheld })}
          </p>
        )}
        <BriefPreview workspaceId={workspaceId} />
      </>
    );
  }

  return (
    <section className="hausbuch" aria-labelledby="hausbuch-title">
      {header}
      {body}
      {editing !== null && (
        <NoteDialog
          workspaceId={workspaceId}
          note={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setArchived(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** What `workspace_brief` answers, as far as the preview reads it. */
interface BriefAnswer {
  sections: string[];
  accounts?: { rows: unknown[] };
  vatCodes?: { rows: unknown[] };
  bankAccounts?: { rows: unknown[] };
  rules?: unknown[];
  notes?: { items: unknown[] };
  counts?: { total: number | null };
  omitted: { section: string }[];
}

/** One number per section the brief carries, from the answer itself. */
export function briefFigures(brief: BriefAnswer): { section: string; count: number | null }[] {
  return brief.sections.map((section) => {
    switch (section) {
      case 'accounts':
        return { section, count: brief.accounts?.rows.length ?? 0 };
      case 'vatCodes':
        return { section, count: brief.vatCodes?.rows.length ?? 0 };
      case 'bankAccounts':
        return { section, count: brief.bankAccounts?.rows.length ?? 0 };
      case 'rules':
        return { section, count: brief.rules?.length ?? 0 };
      case 'notes':
        return { section, count: brief.notes?.items.length ?? 0 };
      default:
        return { section, count: brief.counts?.total ?? null };
    }
  });
}

/** "Was Agenten sehen": the brief, read only once the person opens it. */
function BriefPreview({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState<BriefAnswer | null>(null);
  const [size, setSize] = useState(0);
  const [error, setError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    const { body } = await client.call('workspace_brief', { workspaceId });
    if (isErr(body)) {
      setError(body);
      return;
    }
    setError(null);
    setBrief(body as unknown as BriefAnswer);
    setSize(Math.ceil(JSON.stringify(body).length / 4));
  }, [client, workspaceId]);

  useEffect(() => {
    if (open && brief === null) void load();
  }, [open, brief, load]);

  return (
    <details className="hausbuch-preview" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="hausbuch-section-title">{t('hausbuch.preview')}</summary>
      <p className="hausbuch-preview-hint">{t('hausbuch.previewHint')}</p>
      {error !== null && <ErrorBanner context="read" error={error} onRetry={() => void load()} />}
      {open && brief === null && error === null && <Skeleton rows={3} labelKey="hausbuch.previewLoading" />}
      {brief !== null && (
        <>
          <dl className="hausbuch-figures">
            {briefFigures(brief).map((f) => (
              <div key={f.section} className="hausbuch-figure" data-section={f.section}>
                <dt>{t(`hausbuch.section.${f.section}`)}</dt>
                <dd className="t-num">{f.count === null ? t('hausbuch.none') : f.count}</dd>
              </div>
            ))}
          </dl>
          {brief.omitted.length > 0 && (
            <p className="status-line" role="note">
              {t('hausbuch.omitted', { sections: brief.omitted.map((o) => t(`hausbuch.section.${o.section}`)).join(', ') })}
            </p>
          )}
          <p className="hausbuch-preview-size">{t('hausbuch.size', { tokens: size })}</p>
        </>
      )}
    </details>
  );
}

/** The dialog that writes a note: the text, what it is about, and the reference that kind needs. */
function NoteDialog({
  workspaceId,
  note,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  note: HausbuchNote | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const ids = { text: useId(), kind: useId(), ref: useId(), hint: useId(), count: useId() };
  const [text, setText] = useState(note?.text ?? '');
  const [kind, setKind] = useState<ScopeKind>(note?.scope.kind ?? 'workspace');
  // An account is shown and edited by its label's number; anything else by its reference as stored.
  const [ref, setRef] = useState(
    note === null ? '' : note.scope.kind === 'account' ? (note.scope.label?.split(' ')[0] ?? note.scope.ref ?? '') : (note.scope.label ?? note.scope.ref ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [key] = useState(newKey);
  const trimmed = text.trim();
  const needsRef = kind !== 'workspace';
  const ready = trimmed.length > 0 && trimmed.length <= NOTE_TEXT_MAX && (!needsRef || ref.trim().length > 0);

  async function save() {
    setBusy(true);
    const scope = needsRef ? { kind, ref: ref.trim() } : { kind };
    const input: Record<string, unknown> = { workspaceId, text: trimmed, scope, idempotencyKey: key };
    if (note !== null) input.id = note.id;
    const { body } = await client.call('hausbuch_note_set', input);
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    onSaved();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={note === null ? t('hausbuch.dialog.addTitle') : t('hausbuch.dialog.editTitle')}
      closeLabel={t('hausbuch.dialog.cancel')}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('hausbuch.dialog.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => void save()}>
            {t('hausbuch.dialog.save')}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <div className="form-row">
          <label htmlFor={ids.text}>{t('hausbuch.dialog.text')}</label>
          <textarea
            id={ids.text}
            className="field"
            rows={3}
            maxLength={NOTE_TEXT_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={ids.count}
            required
          />
          <p id={ids.count} className="field-hint t-num">
            {t('hausbuch.dialog.count', { used: trimmed.length, max: NOTE_TEXT_MAX })}
          </p>
        </div>
        <div className="form-row">
          <label htmlFor={ids.kind}>{t('hausbuch.dialog.kind')}</label>
          <Select
            id={ids.kind}
            value={kind}
            onChange={(v) => {
              setKind(v as ScopeKind);
              setRef('');
            }}
            options={SCOPE_KINDS.map((k) => ({ value: k, label: t(`hausbuch.scope.${k}`) }))}
          />
        </div>
        {needsRef && (
          <div className="form-row">
            <label htmlFor={ids.ref}>{t(`hausbuch.dialog.ref.${kind}`)}</label>
            <input id={ids.ref} className="field" value={ref} onChange={(e) => setRef(e.target.value)} aria-describedby={ids.hint} />
            <p id={ids.hint} className="field-hint">
              {t(`hausbuch.dialog.refHint.${kind}`)}
            </p>
          </div>
        )}
        {error !== null && (
          <p className="status-line status-error" role="alert">
            {refusalText(t, error, { own: 'hausbuch.refusal' })}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default Hausbuch;
