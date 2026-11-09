/**
 * A41.5: the bank line's review view shows its Beleg (the approved artifact's view B), under the facts card of
 * the detail area, so it stands beside the booking in every mode. In order of what the line holds:
 *
 *  1. A41.3 re-cut v2: the line's ASSIGNED receipt (`belegAssignment`), the one an automatic booking would rest
 *     on, with who assigned it ("Von TILL zugeordnet, passt eindeutig" or "Von dir zugeordnet") and "Lösen"
 *     (`release_beleg`). I-E: absent or null for a seat that may not read receipts and bank lines: nothing shows.
 *  2. The receipts filed on the line; on an OPEN line that has no assignment they read "Abgelegt, nicht
 *     zugeordnet" with "Zuordnen" (A41.3 follow-ups: one filed file through `assign_beleg_file`, captured and
 *     assigned in one act; several through `assign_beleg`). The new version a `move` left on the line reads
 *     "Neue Version, bitte zuordnen" (`newVersionToAssign`) with the same "Zuordnen".
 *  3. The ONE captured receipt A41.1 found for it ("Passender Beleg"), with "Zuordnen" on an open line.
 *  4. The drop zone.
 *
 * Beside an assigned or candidate receipt the capture's figure trust (I-F, `get_capture`): "Zahlen bestätigt",
 * "Zahlen aus dem QR-Code", or "Vom Agent gelesen, nicht bestätigt" with "Zahlen bestätigen"
 * (`confirm_capture_figures`). A seat that may not read a file's bytes (F7: `read_master_data` AND
 * `read_file_content`) sees no preview: the engine would refuse the read.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { refusalText } from '../../components/states';
import { BelegPreview, type BelegPreviewFile } from '../../components/BelegPreview';
import { FigureTrustLine, type FiguresTrust } from '../../components/FigureTrust';
import { parseFiles } from '../Files/model';
import { formatDate, formatMoney } from '../../i18n';
import { CAPTURE_TRUST_FIELD_KEYS, STALE_FIGURE_ERRORS, confirmEntryOf, engineFieldsOfRead, normaliseShown, type ConfirmEntry } from '../../lib/expectedFigures';
import type { BankInboxLine } from './model';
import type { AssignBeleg } from './useAssignBeleg';

export interface LineBelegProps {
  workspaceId: string;
  line: BankInboxLine;
  /** The person may attach a Beleg to the line (the drop zone shows). */
  canAttach: boolean;
  onAttach: (files: File[]) => void;
  /** A41.3: assign, release, confirm (absent: the review view only shows). */
  assigner?: AssignBeleg;
  /** After an assignment, a release or a confirmation: the host re-reads the line. */
  onAssignChanged?: () => void;
  onSaid?: (tone: 'success' | 'warn', message: string) => void;
}

/** The engine's read of one capture's trust (`get_capture`). */
interface CaptureTrust {
  captureId: string;
  trust: FiguresTrust;
  amountProvenance: string | null;
  underReview: boolean;
  /** What the line shows of the figures, and what a confirmation vouches for: the SAME read. */
  shown: { key: string; label: string; text: string }[];
  /** The confirmation of exactly what is shown, or null when the capture cannot be confirmed here. */
  entry: ConfirmEntry | null;
  /** A value could not be shown exactly (control or line-break characters): no confirmation here. */
  unshowable: boolean;
}

const money = (v: unknown): string => {
  const m = typeof v === 'object' && v !== null ? (v as { minor?: unknown; currency?: unknown }) : null;
  return m !== null && typeof m.minor === 'number' && typeof m.currency === 'string' ? formatMoney(m.minor, m.currency) : '';
};

/**
 * Security review (07.11.2026): a confirmation vouches for EVERY field of the trust set, so the review view shows
 * every one that has a value, each as its OWN labelled element (a free-text value cannot imitate another field),
 * from the SAME `engineFields` the confirmation sends back (`confirmEntryOf`). A date is formatted only when the
 * whole value is a date (anchored); anything else, and any shape this does not know, is shown in full as text.
 */
/** The order the line reads in (who, then how much, then when); every trust key appears, an unlisted one last. */
const READ_FIRST: readonly string[] = ['vendor_name', 'iban', 'vendor_uid', 'amount', 'currency', 'vat_amount', 'invoice_date', 'due_date', 'reference'];
const DISPLAY_ORDER: readonly string[] = [...READ_FIRST.filter((k) => (CAPTURE_TRUST_FIELD_KEYS as readonly string[]).includes(k)), ...CAPTURE_TRUST_FIELD_KEYS.filter((k) => !READ_FIRST.includes(k))];

function fieldText(key: string, raw: unknown): string {
  const value = normaliseShown(raw);
  if (value === null || value === undefined || value === '') return '';
  if (key === 'amount' || key === 'vat_amount') {
    const m = money(value);
    return m !== '' ? m : JSON.stringify(value);
  }
  if ((key === 'invoice_date' || key === 'due_date') && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function useCaptureTrust(workspaceId: string, captureIds: readonly string[], nonce: number): CaptureTrust[] | null {
  const client = useClient();
  const t = useT();
  const key = captureIds.join('|');
  const [read, setRead] = useState<{ key: string; rows: CaptureTrust[] } | null>(null);
  useEffect(() => {
    if (key === '') return undefined;
    let live = true;
    void Promise.all(
      key.split('|').map(async (captureId) => {
        const { body } = await client.call('get_capture', { workspaceId, captureId });
        if (isErr(body)) return null;
        const b = body as unknown as { capture?: { status?: unknown; figuresTrust?: unknown; sha256?: unknown; engineFields?: unknown }; fields?: { key: string; value: unknown; provenance?: unknown; superseded?: boolean }[] };
        const trust = b.capture?.figuresTrust === 'confirmed' || b.capture?.figuresTrust === 'qr' ? b.capture.figuresTrust : null;
        const amount = (b.fields ?? []).find((f) => f.key === 'amount' && f.superseded !== true);
        // ONE source for what is shown and what is sent: the read's engineFields (absent keys absent).
        const engine = engineFieldsOfRead(b.capture?.engineFields) ?? {};
        const shown = DISPLAY_ORDER.map((key) => ({ key, label: t(`figureTrust.field.${key}`), text: fieldText(key, engine[key]) })).filter((x) => x.text !== '');
        const entry = confirmEntryOf(captureId, b.capture?.sha256, b.capture?.engineFields);
        const unshowable = entry === null && typeof b.capture?.sha256 === 'string' && engineFieldsOfRead(b.capture?.engineFields) !== null;
        return { captureId, trust, amountProvenance: typeof amount?.provenance === 'string' ? amount.provenance : null, underReview: b.capture?.status === 'needs_review', shown, entry, unshowable } satisfies CaptureTrust;
      }),
    ).then((rows) => {
      if (live) setRead({ key, rows: rows.filter((r): r is CaptureTrust => r !== null) });
    });
    return () => {
      live = false;
    };
  }, [client, t, workspaceId, key, nonce]);
  return read !== null && read.key === key ? read.rows : null;
}

export function LineBeleg({ workspaceId, line, canAttach, onAttach, assigner, onAssignChanged, onSaid }: LineBelegProps) {
  const t = useT();
  const client = useClient();
  const { can } = useCapabilities();
  const canRead = can(CAP.readMasterData) && can(CAP.readFileContent);
  const [linked, setLinked] = useState<{ lineId: string; files: BelegPreviewFile[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [trustNonce, setTrustNonce] = useState(0);
  const count = line.receiptCount;
  const lineId = line.bankTxnId;
  const open = line.state === 'open';
  const assignment = line.belegAssignment ?? null;
  useEffect(() => {
    if (!canRead || count === 0) return undefined;
    let live = true;
    void client.call('files_list_linked', { workspaceId, entityKind: 'bank_txn', entityId: lineId }).then(({ body }) => {
      if (!live) return;
      const parsed = isErr(body) ? null : parseFiles(body);
      setLinked({ lineId, files: (parsed ?? []).map((f) => ({ fileId: f.id, filename: f.filename })) });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, lineId, count, canRead]);

  const groups = line.belegCandidates ?? [];
  const group = groups.length === 1 ? groups[0] : undefined;
  const nameOf = (fileId: string): string =>
    linked?.files.find((f) => f.fileId === fileId)?.filename ?? group?.files.find((f) => f.fileId === fileId)?.filename ?? '';
  // Whose figures the review view vouches for: the assignment's captures, else the candidate's.
  const trustIds = assignment !== null ? assignment.files.map((f) => f.captureId) : count === 0 && group !== undefined ? group.files.map((f) => f.captureId) : [];
  const trust = useCaptureTrust(workspaceId, canRead ? trustIds : [], trustNonce);

  const run = async (act: () => Promise<Err | null>, done: string) => {
    setBusy(true);
    const refused = await act();
    setBusy(false);
    // A41.3 (security review): the figures moved since they were shown; the re-read below shows them again,
    // and the person confirms again (never an automatic retry).
    if (refused !== null && STALE_FIGURE_ERRORS.has(refused.error)) onSaid?.('warn', t('figureTrust.changed'));
    else if (refused !== null) onSaid?.('warn', refusalText(t, refused, { own: 'bankInbox.assign.error' }));
    else onSaid?.('success', done);
    setTrustNonce((n) => n + 1);
    onAssignChanged?.();
  };
  const canAssign = open && assigner !== undefined && assigner.canAssign;

  const trustLines =
    trust === null || trust.length === 0 ? null : (
      <div className="bank-review__trust">
        {trust.map((c) => (
          <FigureTrustLine
            key={c.captureId}
            trust={c.trust}
            amountProvenance={c.amountProvenance}
            fields={c.shown}
            busy={busy}
            {...(c.unshowable ? { blockedReason: t('figureTrust.unshowable') } : {})}
            onConfirm={assigner !== undefined && c.underReview && c.entry !== null ? () => void run(() => assigner.confirm([c.entry as ConfirmEntry]), t('bankInbox.assign.confirmed')) : null}
          />
        ))}
      </div>
    );

  if (!canRead) return null;

  if (assignment !== null) {
    const files = assignment.files.map((f) => ({ fileId: f.fileId, filename: nameOf(f.fileId) }));
    const by = assignment.source === 'person' ? t('bankInbox.assign.byPerson') : t('bankInbox.assign.byTill');
    return (
      <div className="bank-review" data-assignment={assignment.source}>
        <BelegPreview key={`${lineId}:${assignment.assignmentId}`} workspaceId={workspaceId} files={files} title={t('bankInbox.assign.title')} note={by} compact />
        {trustLines}
        {canAssign && (
          <p className="bank-review__acts">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => assigner.release(lineId), t('bankInbox.assign.released'))}>
              {t('bankInbox.assign.release')}
            </button>
          </p>
        )}
      </div>
    );
  }

  if (count > 0) {
    // Quiet while the list reads (a few milliseconds); the preview then shows its own loading page.
    if (linked === null || linked.lineId !== lineId) return null;
    if (linked.files.length > 0) {
      const unassigned = open && canAssign;
      // A41.3 follow-ups: a FILED file (no capture yet) is captured and assigned in one act (`assign_beleg_file`): the
      // new version a move left on the line, or the line's one filed file. Several files keep `assign_beleg`
      // (captured receipts of one group).
      const newVersion = line.newVersionToAssign?.fileId ?? null;
      const single = newVersion ?? (linked.files.length === 1 ? (linked.files[0]?.fileId ?? null) : null);
      const assignNow = (): Promise<Err | null> => {
        if (assigner === undefined) return Promise.resolve(null);
        return single !== null ? assigner.assignFile(lineId, single) : assigner.assign(lineId, linked.files.map((f) => f.fileId));
      };
      const note = !unassigned
        ? undefined
        : newVersion !== null
          ? t(line.newVersionOrigin === 'machine' ? 'bankInbox.assign.newVersionMachine' : 'bankInbox.assign.newVersion')
          : t('bankInbox.assign.filedNotAssigned');
      return (
        <div className="bank-review" {...(newVersion !== null ? { 'data-new-version': 'true' } : {})}>
          <BelegPreview key={lineId} workspaceId={workspaceId} files={linked.files} note={note} compact />
          {unassigned && (
            <p className="bank-review__acts">
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void run(assignNow, t('bankInbox.assign.assigned', { party: line.counterparty.name ?? line.derivedCounterparty?.label ?? '' }))}>
                {t('bankInbox.assign.assign')}
              </button>
            </p>
          )}
        </div>
      );
    }
  }
  if (count === 0 && group !== undefined) {
    return (
      <div className="bank-review">
        <BelegPreview
          key={`${lineId}:${group.groupKey}`}
          workspaceId={workspaceId}
          files={group.files.map((f) => ({ fileId: f.fileId, filename: f.filename }))}
          title={t('bankInbox.review.candidateTitle')}
          note={t('bankInbox.review.candidateNote')}
          compact
        />
        {trustLines}
        {canAssign && (
          <p className="bank-review__acts">
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void run(() => assigner.assign(lineId, group.files.map((f) => f.fileId)), t('bankInbox.assign.assigned', { party: line.counterparty.name ?? line.derivedCounterparty?.label ?? '' }))}>
              {t('bankInbox.assign.assign')}
            </button>
          </p>
        )}
      </div>
    );
  }
  return <BelegPreview key={lineId} workspaceId={workspaceId} files={[]} onAttach={canAttach ? onAttach : null} compact />;
}
