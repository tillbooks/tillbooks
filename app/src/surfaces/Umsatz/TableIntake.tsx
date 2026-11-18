/**
 * A43 §2 and §3, the table door on `/umsatz`: a CSV or XLSX export of a turnover source becomes ONE
 * till-settlement/v1 document, which the screen then reviews and books exactly like a loaded JSON file.
 *
 * A NEW SOURCE RUNS: name, mapping, template (only when the source has none), review. Each step is the
 * engine's: `settlement_from_table` reads the table and proposes the mapping (saved, a named profile, or the
 * generic guess), `set_settlement_table_mapping` saves it, `SettlementTemplateEditor` saves the booking
 * template, and the document the last read answers goes UNCHANGED to `settlement_review` and
 * `import_settlement`. Nothing is booked here and no figure is computed here.
 *
 * Low cognitive load (DESIGN.md rule 7): one step at a time, the shared Select for every choice, glyphs with
 * their words on hover. Five states: the skeleton while the table is read, the error (a mismatch starts over
 * from the engine's guess), the empty table, the padlock (the page's own), the step.
 *
 * D206: when the setting `settlement.table_event_id` allows it and the table has no id, the id row offers "lists
 * whole days" instead (the person's confirmation, saved with the mapping; its words on hover). The engine then reads
 * the table day by day and answers which days it left out; those go to the review with the document.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useI18n, formatDate, formatMoney } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { EmptyState, ErrorBanner, Skeleton, refusalText } from '../../components/states';
import { Select, type SelectOption } from '../../components/Select';
import { Tooltip } from '../../components/Tooltip';
import { StatusSuccessGlyph, StatusWarnGlyph, TextLinesGlyph, TagGlyph, HelpGlyph } from '../../components/icons';
import { SettlementTemplateEditor, SETTLEMENT_KINDS } from '../BankAccounts/SettlementTemplateEditor';

/** The mapping as `settlement_from_table` answers it (and takes it back). */
export interface TableMapping {
  /** One header per field; `id` names one column or up to five composed into one id. */
  columns: Partial<Record<MappingField, string>> & { id?: string | string[] };
  kindMap: Record<string, string>;
  kindDefault: { positive: string; negative: string };
  vat: { mode: 'from_template' | 'stated' | 'none'; fees?: 'none' | 'from_template' };
  dateFormat: string;
  decimalSeparator: '.' | ',';
  feeSign: 'deducted' | 'signed';
  amountSign: 'as_stated' | 'by_kind';
  idDayPrecision?: 'day' | 'second';
  /** D206: a person confirmed the export lists every row of each day it covers (the whole-day mode). */
  wholeDays?: boolean;
  delimiter?: string;
  encoding?: string;
  headerRow?: number;
}

/** The fields the mapping step offers, in the order a person reads a table. */
export const MAPPING_FIELDS = ['day', 'amount', 'kind', 'fee', 'documentNumber', 'counterparty', 'description', 'currency', 'vat', 'net', 'payoutId'] as const;

/** The most columns one composed id reads (the engine's `TABLE_ID_COLUMNS_MAX`). */
const ID_PARTS_MAX = 5;

/** The id columns of a mapping, as a list. */
export function idPartsOf(m: TableMapping): string[] {
  const v = m.columns.id;
  return v === undefined ? [] : Array.isArray(v) ? [...v] : [v];
}
export type MappingField = (typeof MAPPING_FIELDS)[number];

/** D206: one day of a whole-day table, as `settlement_from_table` answers it (`days`). */
export interface DayView {
  day: string;
  status: 'new' | 'passed' | 'in_books' | 'differs' | 'incomplete' | 'edge_excluded' | 'edge_unconfirmed' | 'not_over';
  edge: 'first' | 'last' | 'both' | null;
  rows: number[];
  file: { events: number; amountMinor: number };
  books: { events: number; amountMinor: number } | null;
  /** D206 (critic r2 M-A): a new edge that shares these amounts with the held day beside it; it asks whatever the setting. */
  nearHeld?: { day: string; amountsMinor: number[] };
}

/** The answer of `settlement_from_table`, as this step reads it. */
export interface FromTable {
  system: string;
  processor: string;
  headers: string[];
  /** L6: each preview row with what it was read as (its event, or the refusal code). */
  rows: { row: number; cells: Record<string, string>; parsed?: { id: string; day: string; kind: string; amountMinor: number } | { code: string } | null }[];
  /** L4: every distinct type cell of the table. */
  typeCells?: string[];
  /** Round 4, L3: text id columns a workbook holds as number cells. */
  idTextAsNumber?: string[];
  rowCount: number;
  mappingSource: 'given' | 'saved' | 'profile' | 'guessed';
  mapping: TableMapping;
  profile: { id: string; label: string; docsUrl: string | null; note: string };
  templateSaved: boolean;
  /** Events whose id is already booked with the same figures: the import books nothing again for them. */
  sameAsBooked: { eventId: string; row: number }[];
  /** Events whose id is booked with OTHER figures: the import refuses them (event_amended). */
  sameIdOtherFigures: { eventId: string; row: number }[];
  /** A mapping is saved for the source (critic M2: replacing it is confirmed). */
  savedMapping: boolean;
  savedHeadersDiffer: { missing: string[]; added: string[] } | null;
  idRecipeDiffers: boolean;
  bookedEvents: number;
  settlement: Record<string, unknown>;
  refusedRows: { row: number; code: string }[];
  totals: { rows: number; events: number; amountMinor: number; table?: { events: number; amountMinor: number } };
  warnings: string[];
  /** D206: the table is read by whole days, and what each day is. */
  dayMode?: boolean;
  days?: DayView[];
  /** D206: the first and last day of the whole file (the import's edges when a period's part is booked). */
  edgeDays?: { first: string; last: string } | null;
}

type Step = 'name' | 'mapping' | 'template';

const NONE = '-';
/** The source picker's own choice for a source not saved yet. */
const NEW_SOURCE = '+new';
const DATE_FORMATS = ['yyyy-mm-dd', 'dd.mm.yyyy', 'dd.mm.yy', 'dd/mm/yyyy', 'mm/dd/yyyy'] as const;
const VAT_MODES = ['from_template', 'stated', 'none'] as const;
const PREVIEW_ROWS = 5;

/** The refusals this step words itself (`umsatz.table.refusal.<code>`). */
const KNOWN = ['table_mapping_mismatch', 'xls_unsupported', 'table_unreadable', 'table_too_large', 'id_column_missing', 'invalid_input', 'day_mode_payout_mapped', 'unreadable_day', 'person_decides'] as const;

/** D206: the whole-day row codes this step words itself (`umsatz.dayCode.<code>`). */
const DAY_ROW_CODES = ['day_incomplete', 'day_differs', 'day_not_over'] as const;

/** The ids the review marks: the same as booked, the same id with other figures, and (D206) the days. */
function marksOf(answer: FromTable): TableMarks {
  return { same: answer.sameAsBooked.map((s) => s.eventId), other: (answer.sameIdOtherFigures ?? []).map((s) => s.eventId), days: answer.days ?? [], fileDays: answer.edgeDays ? { first: answer.edgeDays.first, last: answer.edgeDays.last } : null };
}

export interface TableMarks {
  same: string[];
  other: string[];
  /** D206: every day of a whole-day table, so the review lists the ones left out. */
  days?: DayView[];
  /** D206 (critic r1 M2): the whole file's first and last day, sent with the review and with Buchen. */
  fileDays?: { first: string; last: string } | null;
}

let keySeq = 0;
const newKey = (act: string) => `umsatz-table-${act}-${Date.now().toString(36)}-${(keySeq += 1)}`;

export function TableIntake({
  workspaceId,
  contentBase64,
  onDocument,
  onOtherFile,
}: {
  workspaceId: string;
  contentBase64: string;
  /** The document, and the ids the review marks "same as booked" and "same id, other figures". */
  onDocument: (settlement: Record<string, unknown>, marks: TableMarks) => void;
  /** Load another file instead (the empty table's one action). */
  onOtherFile: () => void;
}) {
  const { t } = useI18n();
  const client = useClient();
  const id = useId();
  const [step, setStep] = useState<Step>('name');
  const [system, setSystem] = useState('');
  const [processor, setProcessor] = useState('');
  const [read, setRead] = useState<FromTable | null>(null);
  const [draft, setDraft] = useState<TableMapping | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [error, setError] = useState<Err | null>(null);
  // A mismatch with the saved mapping: shown while the person maps the new file from the engine's guess.
  const [notice, setNotice] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // CRITIC M2: the sources already saved (a mapping, a template or a feed), picked from the shared Select, so a
  // typo never starts a second source; "new source" is its own choice.
  const [sources, setSources] = useState<{ system: string; processor: string }[] | null>(null);
  const [picked, setPicked] = useState<string>('');
  // CRITIC M2: replacing a saved mapping waits for this confirm, which names the double-booking risk.
  const [confirming, setConfirming] = useState(false);
  // RE-CUT: the preview rows, kept apart from the answer so an id-less read (refused) still shows the table.
  const [preview, setPreview] = useState<{ rows: FromTable['rows']; rowCount: number } | null>(null);
  // RE-CUT: the mapping has no id yet: the person picks the column(s); the engine's candidates on hover.
  const [needsId, setNeedsId] = useState<string[] | null>(null);
  // L2: a mapping deriving ids otherwise than what booked waits for this confirm; then every read carries it.
  const [pendingIdChange, setPendingIdChange] = useState<Err | null>(null);
  const [idConfirmed, setIdConfirmed] = useState(false);
  // D206: the setting allows reading an id-less table by whole days (the engine says so on the id-less refusal).
  const [dayModeAvailable, setDayModeAvailable] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([
      client.call('get_settlement_table_mapping', { workspaceId }),
      client.call('get_settlement_template', { workspaceId }),
      client.call('get_settlement_source', { workspaceId }),
    ]).then(([map, tpl, feed]) => {
      if (!live) return;
      const all = new Map<string, { system: string; processor: string }>();
      const add = (list: unknown) => {
        for (const x of (Array.isArray(list) ? list : []) as { system: string; processor: string }[]) all.set(JSON.stringify([x.system, x.processor]), { system: x.system, processor: x.processor });
      };
      if (!isErr(map.body)) add((map.body as unknown as { mappings?: unknown }).mappings);
      if (!isErr(tpl.body)) add((tpl.body as unknown as { templates?: unknown }).templates);
      if (!isErr(feed.body)) add((feed.body as unknown as { sources?: unknown }).sources);
      const list = [...all.values()].sort((a, b) => a.system.localeCompare(b.system) || a.processor.localeCompare(b.processor));
      setSources(list);
      const only = list.length === 1 ? list[0] : undefined;
      if (list.length === 0) setPicked(NEW_SOURCE);
      else if (only !== undefined) {
        setPicked(JSON.stringify([only.system, only.processor]));
        setSystem(only.system);
        setProcessor(only.processor);
      }
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const fromTable = useCallback(
    async (mapping: TableMapping | null, confirm: boolean = idConfirmed): Promise<FromTable | null> => {
      setBusy(true);
      setError(null);
      const call = (m: TableMapping | null) =>
        client.call('settlement_from_table', { workspaceId, system, processor, contentBase64, ...(m !== null ? { mapping: m } : {}), ...(confirm ? { confirmIdChange: true } : {}) });
      let { body } = await call(mapping);
      // A mismatch with the saved mapping starts over from the engine's own guess for this file, read at once.
      const guessed = isErr(body) && body.error === 'table_mapping_mismatch' ? (body as unknown as { guessedMapping?: TableMapping }).guessedMapping : undefined;
      if (guessed !== undefined) {
        setNotice(body as Err);
        setDirty(true);
        ({ body } = await call(guessed));
      }
      setBusy(false);
      if (isErr(body)) {
        const b = body as unknown as { headers?: string[]; rows?: FromTable['rows']; rowCount?: number; guessedMapping?: TableMapping; candidates?: string[]; dayModeAvailable?: boolean; mapping?: TableMapping };
        if (body.error === 'unreadable_day') {
          // D206: a whole-day table with a day it cannot read: keep the mapping step, so the date format can be fixed.
          setRead(null);
          if (b.mapping !== undefined) setDraft(b.mapping);
          if (b.headers !== undefined) setHeaders(b.headers);
          if (b.rows !== undefined) setPreview({ rows: b.rows, rowCount: b.rowCount ?? b.rows.length });
          setError(body);
          return null;
        }
        if (body.error === 'id_column_missing') {
          setDayModeAvailable(b.dayModeAvailable === true);
          // No id yet: show the table and the mapping so far, and ask for the id column(s).
          setRead(null);
          if (b.guessedMapping !== undefined) setDraft(b.guessedMapping);
          else if (mapping !== null) setDraft(mapping);
          if (b.headers !== undefined) setHeaders(b.headers);
          if (b.rows !== undefined) setPreview({ rows: b.rows, rowCount: b.rowCount ?? b.rows.length });
          setNeedsId(b.candidates ?? []);
          return null;
        }
        if (body.error === 'event_id_derivation_changed') {
          setRead(null);
          const m = (body as unknown as { mapping?: TableMapping }).mapping ?? mapping;
          if (m !== null) setDraft(m);
          if (b.headers !== undefined) setHeaders(b.headers);
          setPendingIdChange(body);
          return null;
        }
        setError(body);
        return null;
      }
      const answer = body as unknown as FromTable;
      setRead(answer);
      setHeaders(answer.headers);
      setDraft(answer.mapping);
      setPreview({ rows: answer.rows, rowCount: answer.rowCount });
      setNeedsId(null);
      setPendingIdChange(null);
      if (answer.dayMode === true) setDayModeAvailable(true);
      return answer;
    },
    [client, workspaceId, system, processor, contentBase64, idConfirmed],
  );

  const word = (e: Err): string => refusalText(t, e, { own: 'umsatz.table.refusal', known: KNOWN });
  /** Round 4, L4: a row code the person can act on is worded; the others stay the engine's code. */
  const rowCodeWord = (code: string): string =>
    code === 'id_time_unknown' ? t('umsatz.table.rowCode.id_time_unknown') : (DAY_ROW_CODES as readonly string[]).includes(code) ? t(`umsatz.dayCode.${code}`) : code;

  /** Save the mapping when it is not the saved one, read again, then the template or the review. */
  async function confirmMapping(replaceConfirmed = false) {
    if (draft === null) return;
    if (dirty || read?.mappingSource !== 'saved') {
      // CRITIC M2: a saved mapping is never replaced without the person's confirm.
      if (read?.savedMapping === true && !replaceConfirmed) {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      setBusy(true);
      const { body } = await client.call('set_settlement_table_mapping', {
        workspaceId,
        system,
        processor,
        mapping: draft,
        headers,
        ...(replaceConfirmed || idConfirmed ? { confirmIdChange: true } : {}),
        idempotencyKey: newKey('mapping'),
      });
      setBusy(false);
      if (isErr(body)) {
        setError(body);
        return;
      }
      setDirty(false);
      setNotice(null);
    }
    const answer = await fromTable(null);
    if (answer === null) return;
    if (!answer.templateSaved) setStep('template');
    else onDocument(answer.settlement, marksOf(answer));
  }

  async function afterTemplate() {
    const answer = await fromTable(null);
    if (answer !== null) onDocument(answer.settlement, marksOf(answer));
  }

  function change(patch: Partial<TableMapping>) {
    if (draft === null) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirty(true);
    void fromTable(next);
  }

  if (step === 'name') {
    if (sources === null) return <Skeleton rows={2} />;
    const ready = system.trim() !== '' && processor.trim() !== '';
    const sourceOptions: SelectOption[] = [
      ...sources.map((x) => ({ value: JSON.stringify([x.system, x.processor]), label: `${x.system} · ${x.processor}` })),
      { value: NEW_SOURCE, label: t('umsatz.table.newSource') },
    ];
    return (
      <form
        className="umsatz-intake"
        aria-label={t('umsatz.table.nameStep')}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setStep('mapping');
          void fromTable(null);
        }}
      >
        <span>{t('umsatz.table.source.pick')}</span>
        <Select
          ariaLabel={t('umsatz.table.source.pick')}
          value={picked}
          placeholder={t('umsatz.table.source.choose')}
          options={sourceOptions}
          onChange={(v) => {
            setPicked(v);
            if (v === NEW_SOURCE) {
              setSystem('');
              setProcessor('');
              return;
            }
            const [sys, proc] = JSON.parse(v) as [string, string];
            setSystem(sys);
            setProcessor(proc);
          }}
        />
        {picked === NEW_SOURCE && (
          <>
            <label htmlFor={`${id}-system`}>{t('umsatz.table.system')}</label>
            <input id={`${id}-system`} className="field" value={system} onChange={(e) => setSystem(e.target.value)} />
            <label htmlFor={`${id}-processor`}>{t('umsatz.table.processor')}</label>
            <input id={`${id}-processor`} className="field" value={processor} onChange={(e) => setProcessor(e.target.value)} />
          </>
        )}
        <div className="umsatz-intake-actions">
          <button type="submit" className="btn btn--primary btn--sm" aria-disabled={!ready}>
            {t('umsatz.table.next')}
          </button>
        </div>
      </form>
    );
  }

  if (step === 'template') {
    return (
      <div className="umsatz-intake">
        {error !== null && <ErrorBanner message={word(error)} />}
        <SettlementTemplateEditor workspaceId={workspaceId} system={read?.system ?? system} processor={read?.processor ?? processor} canPost onSaved={() => void afterTemplate()} />
      </div>
    );
  }

  // The mapping step.
  if (draft === null) {
    return error !== null ? <ErrorBanner message={word(error)} onRetry={() => void fromTable(null)} context="read" /> : <Skeleton rows={4} />;
  }
  if (preview !== null && preview.rowCount === 0) return <EmptyState title={t('umsatz.table.empty')} hint="" action={{ label: t('umsatz.table.otherFile'), onClick: onOtherFile }} />;

  const headerOptions: SelectOption[] = [{ value: NONE, label: t('umsatz.table.none') }, ...headers.map((h) => ({ value: h, label: h }))];
  const kindOptions: SelectOption[] = SETTLEMENT_KINDS.map((k) => ({ value: k, label: t(`umsatz.kind.${k}`) }));
  const kindHeader = draft.columns.kind;
  // L4: the engine answers every distinct type cell, so the kind map is never limited to the preview rows.
  const typeCells = kindHeader === undefined || read === null ? [] : (read.typeCells ?? [...new Set(read.rows.map((r) => (r.cells[kindHeader] ?? '').trim()).filter((c) => c !== ''))]);
  const SourceGlyph = read?.mappingSource === 'saved' ? StatusSuccessGlyph : read?.mappingSource === 'profile' ? TagGlyph : read?.mappingSource === 'given' ? TextLinesGlyph : HelpGlyph;
  const sourceWord = read === null ? t('umsatz.table.source.guessed') : t(`umsatz.table.source.${read.mappingSource}`, { label: read.profile.label });
  const refused = read?.refusedRows.length ?? 0;
  const idParts = idPartsOf(draft);
  const duplicates = read?.refusedRows.filter((r) => r.code === 'id_not_unique').length ?? 0;
  const setIdParts = (parts: string[]) => {
    const columns = { ...draft.columns };
    if (parts.length === 0) delete columns.id;
    else columns.id = parts.length === 1 ? (parts[0] as string) : parts;
    change({ columns });
  };
  // L3: an id with an amount part reads two equal sales of another file as the same event.
  const moneyHeaders = [draft.columns.amount, draft.columns.fee, draft.columns.vat, draft.columns.net].filter((x): x is string => x !== undefined);
  const amountInId = idParts.some((p) => moneyHeaders.includes(p));
  // D206: an id-less table may be read by whole days, once the person says the export lists every row of a day.
  const wholeDays = draft.wholeDays === true && idParts.length === 0;
  const idWord =
    wholeDays
      ? t('umsatz.table.wholeDays.on')
      : needsId !== null
      ? t('umsatz.table.id.missing', { candidates: needsId.join(', ') })
      : duplicates > 0
        ? t('umsatz.table.id.notUnique', { count: duplicates })
        : t('umsatz.table.id.unique');

  return (
    <section className="umsatz-intake" aria-label={t('umsatz.table.mappingStep')}>
      <div className="umsatz-intake-head">
        <Tooltip content={read?.mappingSource === 'profile' ? `${sourceWord} (${read.profile.note})` : sourceWord}>
          <span className="umsatz-intake-source" role="img" tabIndex={0} aria-label={sourceWord}>
            <SourceGlyph size={16} />
          </span>
        </Tooltip>
        <span className="umsatz-intake-name">
          {read?.system ?? system} · {read?.processor ?? processor}
        </span>
        {read !== null && (
          <span className="umsatz-intake-count">{t('umsatz.table.events', { events: read.totals.events, rows: read.rowCount })}</span>
        )}
        {read !== null && read.sameAsBooked.length > 0 && (
          <Tooltip content={read.sameAsBooked.slice(0, 10).map((r) => t('umsatz.table.sameAsBookedRow', { row: r.row })).join(', ')}>
            <span className="umsatz-intake-refused" role="img" tabIndex={0} aria-label={t('umsatz.table.sameAsBooked', { count: read.sameAsBooked.length })}>
              <StatusWarnGlyph size={16} /> {t('umsatz.table.sameAsBooked', { count: read.sameAsBooked.length })}
            </span>
          </Tooltip>
        )}
        {read !== null && read.sameIdOtherFigures.length > 0 && (
          <Tooltip content={read.sameIdOtherFigures.slice(0, 10).map((r) => t('umsatz.table.sameAsBookedRow', { row: r.row })).join(', ')}>
            <span className="umsatz-intake-refused" role="img" tabIndex={0} aria-label={t('umsatz.table.sameIdOther', { count: read.sameIdOtherFigures.length })}>
              <StatusWarnGlyph size={16} /> {t('umsatz.table.sameIdOther', { count: read.sameIdOtherFigures.length })}
            </span>
          </Tooltip>
        )}
        {refused > 0 && read !== null && (
          <Tooltip content={read.refusedRows.slice(0, 10).map((r) => t('umsatz.table.refusedRow', { row: r.row, code: rowCodeWord(r.code) })).join(', ')}>
            <span className="umsatz-intake-refused" role="img" tabIndex={0} aria-label={t('umsatz.table.refused', { count: refused })}>
              <StatusWarnGlyph size={16} /> {refused}
            </span>
          </Tooltip>
        )}
      </div>
      {notice !== null && <ErrorBanner message={word(notice)} />}
      {error !== null && <ErrorBanner message={word(error)} />}
      {read !== null && read.warnings.length > 0 && (
        <ul className="umsatz-intake-warnings" aria-label={t('umsatz.table.warnings')}>
          {read.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {/* RE-CUT: the id, one column or several composed; the live check says whether it is unique in the file. */}
      <div className="umsatz-intake-grid" role="group" aria-label={t('umsatz.table.id.label')}>
        {[...idParts, ...(idParts.length < ID_PARTS_MAX ? [NONE] : [])].map((part, k) => (
          <div key={`id-${k}`} className="umsatz-intake-field">
            <span>{t('umsatz.table.id.part', { n: k + 1 })}</span>
            <Select
              ariaLabel={t('umsatz.table.id.part', { n: k + 1 })}
              value={part}
              options={headerOptions}
              disabled={busy}
              onChange={(v) => {
                const next = [...idParts];
                if (k < idParts.length) {
                  if (v === NONE) next.splice(k, 1);
                  else next[k] = v;
                } else if (v !== NONE) next.push(v);
                setIdParts(next.filter((x, i) => next.indexOf(x) === i));
              }}
            />
          </div>
        ))}
        {dayModeAvailable && idParts.length === 0 && (
          <div className="umsatz-intake-field">
            <span>{t('umsatz.table.wholeDays.label')}</span>
            <Select
              ariaLabel={t('umsatz.table.wholeDays.label')}
              value={wholeDays ? 'days' : 'id'}
              options={[
                { value: 'id', label: t('umsatz.table.wholeDays.no') },
                { value: 'days', label: t('umsatz.table.wholeDays.yes') },
              ]}
              disabled={busy}
              onChange={(v) => change({ wholeDays: v === 'days' })}
            />
            <Tooltip content={t('umsatz.table.wholeDays.hint')}>
              <span className="umsatz-intake-source" role="img" tabIndex={0} aria-label={t('umsatz.table.wholeDays.hint')}>
                <HelpGlyph size={16} />
              </span>
            </Tooltip>
          </div>
        )}
        {draft.columns.day !== undefined && idParts.includes(draft.columns.day) && (
          <div className="umsatz-intake-field">
            <span>{t('umsatz.table.id.precision')}</span>
            <Select
              ariaLabel={t('umsatz.table.id.precision')}
              value={draft.idDayPrecision ?? 'day'}
              options={(['day', 'second'] as const).map((v) => ({ value: v, label: t(`umsatz.table.id.precisionOf.${v}`) }))}
              disabled={busy}
              onChange={(v) => change({ idDayPrecision: v === 'second' ? 'second' : 'day' })}
            />
          </div>
        )}
        <Tooltip content={idWord}>
          <span className="umsatz-intake-source" role="img" tabIndex={0} aria-label={idWord}>
            {!wholeDays && (needsId !== null || duplicates > 0) ? <StatusWarnGlyph size={16} /> : <StatusSuccessGlyph size={16} />}
          </span>
        </Tooltip>
        {read !== null && (read.idTextAsNumber ?? []).length > 0 && (
          <Tooltip content={t('umsatz.table.id.textAsNumber', { columns: (read.idTextAsNumber ?? []).join(', ') })}>
            <span className="umsatz-intake-source" role="img" tabIndex={0} aria-label={t('umsatz.table.id.textAsNumber', { columns: (read.idTextAsNumber ?? []).join(', ') })}>
              <StatusWarnGlyph size={16} />
            </span>
          </Tooltip>
        )}
        {amountInId && (
          <Tooltip content={t('umsatz.table.id.amountPart')}>
            <span className="umsatz-intake-source" role="img" tabIndex={0} aria-label={t('umsatz.table.id.amountPart')}>
              <StatusWarnGlyph size={16} />
            </span>
          </Tooltip>
        )}
      </div>

      <div className="umsatz-intake-grid">
        {MAPPING_FIELDS.map((f) => (
          <div key={f} className="umsatz-intake-field">
            <span id={`${id}-${f}`}>{t(`umsatz.table.field.${f}`)}</span>
            <Select
              ariaLabel={t(`umsatz.table.field.${f}`)}
              value={draft.columns[f] ?? NONE}
              options={f === 'day' || f === 'amount' ? headerOptions.slice(1) : headerOptions}
              disabled={busy}
              onChange={(v) => {
                const columns = { ...draft.columns };
                if (v === NONE) delete columns[f];
                else columns[f] = v;
                change({ columns });
              }}
            />
          </div>
        ))}
        <div className="umsatz-intake-field">
          <span>{t('umsatz.table.dateFormat')}</span>
          <Select ariaLabel={t('umsatz.table.dateFormat')} value={draft.dateFormat} options={DATE_FORMATS.map((d) => ({ value: d, label: d }))} disabled={busy} onChange={(v) => change({ dateFormat: v })} />
        </div>
        <div className="umsatz-intake-field">
          <span>{t('umsatz.table.decimal')}</span>
          <Select
            ariaLabel={t('umsatz.table.decimal')}
            value={draft.decimalSeparator}
            options={[
              { value: '.', label: '12.50' },
              { value: ',', label: '12,50' },
            ]}
            disabled={busy}
            onChange={(v) => change({ decimalSeparator: v === ',' ? ',' : '.' })}
          />
        </div>
        {/* L5: each reading choice is a control with its default (D172). */}
        <div className="umsatz-intake-field">
          <span>{t('umsatz.table.amountSign')}</span>
          <Select
            ariaLabel={t('umsatz.table.amountSign')}
            value={draft.amountSign}
            options={(['as_stated', 'by_kind'] as const).map((v) => ({ value: v, label: t(`umsatz.table.sign.${v}`) }))}
            disabled={busy}
            onChange={(v) => change({ amountSign: v === 'by_kind' ? 'by_kind' : 'as_stated' })}
          />
        </div>
        {draft.columns.fee !== undefined && (
          <div className="umsatz-intake-field">
            <span>{t('umsatz.table.feeSign')}</span>
            <Select
              ariaLabel={t('umsatz.table.feeSign')}
              value={draft.feeSign}
              options={(['deducted', 'signed'] as const).map((v) => ({ value: v, label: t(`umsatz.table.fee.${v}`) }))}
              disabled={busy}
              onChange={(v) => change({ feeSign: v === 'signed' ? 'signed' : 'deducted' })}
            />
          </div>
        )}
        {draft.columns.kind === undefined && (
          <>
            <div className="umsatz-intake-field">
              <span>{t('umsatz.table.kindPositive')}</span>
              <Select ariaLabel={t('umsatz.table.kindPositive')} value={draft.kindDefault.positive} options={kindOptions} disabled={busy} onChange={(v) => change({ kindDefault: { ...draft.kindDefault, positive: v } })} />
            </div>
            <div className="umsatz-intake-field">
              <span>{t('umsatz.table.kindNegative')}</span>
              <Select ariaLabel={t('umsatz.table.kindNegative')} value={draft.kindDefault.negative} options={kindOptions} disabled={busy} onChange={(v) => change({ kindDefault: { ...draft.kindDefault, negative: v } })} />
            </div>
          </>
        )}
        <div className="umsatz-intake-field">
          <span>{t('umsatz.table.vatMode')}</span>
          <Select
            ariaLabel={t('umsatz.table.vatMode')}
            value={draft.vat.mode}
            options={VAT_MODES.map((m) => ({ value: m, label: t(`umsatz.table.vat.${m}`) }))}
            disabled={busy}
            onChange={(v) => change({ vat: { ...draft.vat, mode: v as TableMapping['vat']['mode'] } })}
          />
        </div>
        {draft.vat.mode === 'from_template' && (
          <div className="umsatz-intake-field">
            <span>{t('umsatz.table.vatFees')}</span>
            <Select
              ariaLabel={t('umsatz.table.vatFees')}
              value={draft.vat.fees ?? 'none'}
              options={(['none', 'from_template'] as const).map((v) => ({ value: v, label: t(`umsatz.table.vat.${v === 'none' ? 'none' : 'from_template'}`) }))}
              disabled={busy}
              onChange={(v) => change({ vat: { ...draft.vat, fees: v === 'from_template' ? 'from_template' : 'none' } })}
            />
          </div>
        )}
      </div>

      {typeCells.length > 0 && (
        <div className="umsatz-intake-grid" aria-label={t('umsatz.table.kindMap')} role="group">
          {typeCells.map((cell) => (
            <div key={cell} className="umsatz-intake-field">
              <span>{cell}</span>
              <Select
                ariaLabel={t('umsatz.table.kindOf', { cell })}
                value={draft.kindMap[cell.toLowerCase().replace(/\s+/g, ' ')] ?? 'other'}
                options={kindOptions}
                disabled={busy}
                onChange={(v) => change({ kindMap: { ...draft.kindMap, [cell.toLowerCase().replace(/\s+/g, ' ')]: v } })}
              />
            </div>
          ))}
        </div>
      )}

      {preview !== null && (
        <div className="umsatz-intake-preview">
          <table className="umsatz-table">
            <caption className="visually-hidden">{t('umsatz.table.preview')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('umsatz.table.readAs')}</th>
                {headers.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, PREVIEW_ROWS).map((r) => (
                <tr key={r.row}>
                  {/* L6: the PARSED row, so a day read in the wrong format shows before anything is booked. */}
                  <td className="umsatz-intake-parsed">
                    {r.parsed === undefined || r.parsed === null
                      ? ''
                      : 'code' in r.parsed
                        ? t('umsatz.table.refusedRow', { row: r.row, code: rowCodeWord(r.parsed.code) })
                        : `${formatDate(r.parsed.day)} · ${t(`umsatz.kind.${r.parsed.kind}`)} · ${formatMoney(r.parsed.amountMinor, 'CHF')}`}
                  </td>
                  {headers.map((h) => (
                    <td key={h}>{r.cells[h] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingIdChange !== null && (
        <div className="umsatz-intake-confirm" role="group" aria-label={t('umsatz.table.otherIds.title')}>
          <p>{t('umsatz.table.otherIds.risk', { count: (pendingIdChange as unknown as { bookedEvents?: number }).bookedEvents ?? 0 })}</p>
          <div className="umsatz-intake-actions">
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => {
                setIdConfirmed(true);
                setPendingIdChange(null);
                void fromTable(draft, true);
              }}
            >
              {t('umsatz.table.otherIds.confirm')}
            </button>
          </div>
        </div>
      )}

      {confirming && read !== null && (
        <div className="umsatz-intake-confirm" role="group" aria-label={t('umsatz.table.replace.title')}>
          <p>{read.bookedEvents > 0 ? t('umsatz.table.replace.risk', { count: read.bookedEvents }) : t('umsatz.table.replace.plain')}</p>
          <div className="umsatz-intake-actions">
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void confirmMapping(true)}>
              {t('umsatz.table.replace.confirm')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)}>
              {t('umsatz.table.replace.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="umsatz-intake-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          aria-disabled={busy || read === null || error !== null || confirming}
          onClick={() => {
            if (!busy && read !== null && error === null && !confirming) void confirmMapping();
          }}
        >
          {t('umsatz.table.next')}
        </button>
      </div>
    </section>
  );
}
