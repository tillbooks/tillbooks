/**
 * The front-half entry of the Datenübernahme wizard (G09 §6, US-G09.1/US-G09.2), rendered on the
 * Migration surface when no plan exists yet: the file-drop / upload entry, the source discovery view,
 * the plan-creation form (source system + Übernahmestichtag), and the scope selection.
 *
 * WHAT THIS COMPONENT IS CAREFUL ABOUT:
 *   - Discovery classifies WITHOUT writing a ledger row and names each file's detected adapter, its
 *     data classes, its row count, a header sample, a confidence and the file's own as-of date. A file
 *     no adapter can parse is named in `failures[]` for THAT file only; the others still classify.
 *   - Nothing is guessed silently. A format that carries no as-of date leaves the Stichtag field for
 *     the operator rather than inventing one (US-G09.1 boundary), and an unparseable file says why.
 *   - An Übernahmestichtag in the FUTURE is accepted (F-09, 2026-09-06): a migration is prepared ahead
 *     of its date, and only the commit and the promotion wait for it (`cutover_in_future` is now a
 *     commit-time refusal, never a plan-time one). The hint under the date field says so.
 *   - Scope is a per-class INCLUDE choice over exactly the classes the uploaded files can produce, so a
 *     class can never import by accident. A class outside first scope is named with its owner, never
 *     silently absent (the engine's `unavailable[]`).
 *   - This mints no verb, no tool, no table: it wires `files_upload`, `migration_discover_source`,
 *     `migration_create_plan` and `migration_set_scope`, all already in the registry.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { ActionFeedback } from '../../components/ActionFeedback';
import { Select } from '../../components/Select';
import { FileDrop } from '../../components/FileDrop';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** The single-call upload bound (E00 MAX_FILE_BYTES). A larger file goes through the G18 chunk lane. */
const SINGLE_CALL_MAX_BYTES = 25 * 1024 * 1024;
/** Each chunk is within the single-call bound; 8 MiB keeps the base64 payload comfortably under it. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Hex sha256 of an ArrayBuffer, via the platform SubtleCrypto (no dependency). */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Base64 of a byte slice, chunked so a large slice does not overflow the argument stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

/** Read a selected File as base64, without the data-URL prefix (the Capture surface's helper). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

interface DiscoveredFile {
  fileId: string;
  filename: string;
  adapter: string;
  dataClasses: string[];
  rowCount: number;
  headers: string[];
  confidence: string;
  asAt: string | null;
  warnings: string[];
  // G18 US-G18.2: an xlsx source reports every worksheet by name, so a per-file worksheet choice can be
  // offered. G18 US-G18.3: a zip bundle reports its member files, so it renders as a group. Both are
  // optional: they are present only once discovery surfaces them (the discover verb's bundle/worksheet
  // fields), so the UI degrades to the flat file row when they are absent.
  worksheets?: string[];
  worksheet?: string;
  members?: Array<{ fileId: string; filename: string }>;
}
interface DiscoverFailure {
  fileId: string;
  filename: string;
  error: string;
  // The deeper cause the discover verb returns per unparseable file (US-G09.1): a reason code and,
  // for a tabular parse, what the sniffer detected. K-15 renders these so a failure is diagnosable,
  // not a bare "could not be read".
  reason?: string;
  detectedEncoding?: string;
  detectedDelimiter?: string;
  member?: string;
}
interface AdapterDto {
  id: string;
  label: string;
  dataClasses: string[];
}

type Phase = 'files' | 'plan' | 'scope';

/** The go-live scope classes (moneyPath ones lead), mirrored from the engine's first-scope registry. */
const KNOWN_CLASSES = [
  'opening_balances',
  'open_items_ar',
  'open_items_ap',
  'bank_statements',
  'vat_history',
  'chart_of_accounts',
  'tax_codes',
  'contacts',
  'items',
  'payment_terms',
  'bank_accounts',
  'documents',
  'gl_history',
] as const;

/** The encodings the discover override can FORCE (K-15), mirrored from the engine's SOURCE_ENCODINGS. */
const FORCE_ENCODINGS = ['utf-8', 'latin1', 'windows-1252'] as const;
/** The delimiter NAMES the discover override can FORCE (K-15), mirrored from the engine's DELIMITERS. */
const FORCE_DELIMITERS = ['comma', 'semicolon', 'tab'] as const;

/**
 * K-15: the discover verb returns a reason CODE per unparseable file (US-G09.1). This surface map
 * localises the known codes; any code the map does not carry falls back to a humanised form of the
 * code itself, so a new engine reason is still legible and never a raw snake_case token.
 */
const REASON_KEY: Record<string, string> = {
  no_header_row: 'noHeaderRow',
  not_yet_readable: 'notYetReadable',
  encrypted: 'encrypted',
  corrupt: 'corrupt',
  worksheet_not_found: 'worksheetNotFound',
  not_a_zip: 'notAZip',
  not_abaconnect: 'notAbaconnect',
  source_integrity_mismatch: 'sourceIntegrityMismatch',
  source_unparseable: 'unparseable',
  invalid_input: 'invalidInput',
};

/** A snake_case code as a readable fallback: `no_header_row` -> `No header row`. */
function humanizeCode(code: string): string {
  const spaced = code.replace(/_/g, ' ').trim();
  return spaced === '' ? code : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The localised reason for a failed file: the deeper reason code wins, else the error code. */
function failureReason(t: (key: string) => string, f: DiscoverFailure): string {
  const code = f.reason ?? f.error;
  const key = REASON_KEY[code];
  return key === undefined ? humanizeCode(code) : t(`migration.intake.reason.${key}`);
}

export function SourceIntake(props: { workspaceId: string; onCreated: () => void }): React.ReactElement {
  const { workspaceId, onCreated } = props;
  const client = useClient();
  const t = useT();

  const [phase, setPhase] = useState<Phase>('files');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // G18 US-G18.4: per-file chunked-upload progress (0..100), announced via a live region for a large
  // source that goes through the chunk lane. A small file never enters this map.
  const [progress, setProgress] = useState<Record<string, number>>({});
  // G18 US-G18.2: the per-file worksheet choice for an xlsx source (fileId -> chosen sheet name).
  const [worksheetChoice, setWorksheetChoice] = useState<Record<string, string>>({});

  const [discovered, setDiscovered] = useState<DiscoveredFile[]>([]);
  const [failures, setFailures] = useState<DiscoverFailure[]>([]);
  // K-15: the per-file FORCED-format choice for a failed file (fileId -> chosen adapter/encoding/
  // delimiter). An unset field means "leave it to auto-detection"; the force retry sends only the
  // fields the operator actually chose.
  const [overrideChoice, setOverrideChoice] = useState<Record<string, { adapter?: string; encoding?: string; delimiter?: string }>>({});

  const [adapters, setAdapters] = useState<AdapterDto[]>([]);
  const [sourceSystem, setSourceSystem] = useState('csv');
  const [cutoverDate, setCutoverDate] = useState('');
  const [planError, setPlanError] = useState<string | null>(null);

  const [planId, setPlanId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unavailable, setUnavailable] = useState<Array<{ dataClass: string; owner: string }>>([]);
  const [scopeError, setScopeError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = (await client.call('migration_list_source_adapters', {})).body;
      if (!isErr(res)) setAdapters((res.adapters ?? []) as AdapterDto[]);
    })();
  }, [client]);

  // The union of classes the uploaded files can produce: scope only ever offers what a file can feed.
  const offeredClasses = useMemo(() => {
    const union = new Set<string>();
    for (const f of discovered) for (const c of f.dataClasses) union.add(c);
    return KNOWN_CLASSES.filter((c) => union.has(c));
  }, [discovered]);

  // G18 US-G18.4: upload a large file through the chunk lane, reporting progress. The bytes are read
  // once (for the sha256 the commit verifies), sliced into bounded chunks, and each chunk sent in order;
  // the committed blob is served only through the stream, never a single base64 call.
  const uploadViaLane = useCallback(
    async (file: File): Promise<{ fileId: string; filename: string } | null> => {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const sha256 = await sha256Hex(buf);
      const begin = (
        await client.call('files_upload_begin', {
          workspaceId,
          name: file.name,
          mediaType: file.type || 'text/csv',
          sizeBytes: bytes.byteLength,
          intent: 'migration_source',
          idempotencyKey: newIdempotencyKey(),
        })
      ).body;
      if (isErr(begin)) {
        setNotice(t(`migration.intake.uploadError.${begin.error === 'file_too_large' ? 'tooLarge' : 'generic'}`));
        return null;
      }
      const uploadId = begin.uploadId as string;
      const total = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
      for (let seq = 0; seq < total; seq += 1) {
        const slice = bytes.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, bytes.byteLength));
        const chunk = (
          await client.call('files_upload_chunk', {
            workspaceId,
            uploadId,
            seq,
            contentBase64: bytesToBase64(slice),
            idempotencyKey: newIdempotencyKey(),
          })
        ).body;
        if (isErr(chunk)) {
          setNotice(t('migration.intake.uploadError.generic'));
          return null;
        }
        setProgress((prev) => ({ ...prev, [file.name]: Math.round(((seq + 1) / total) * 100) }));
      }
      const commit = (
        await client.call('files_upload_commit', { workspaceId, uploadId, sha256, idempotencyKey: newIdempotencyKey() })
      ).body;
      if (isErr(commit)) {
        setNotice(t(`migration.intake.uploadError.${commit.error === 'source_integrity_mismatch' ? 'integrity' : 'generic'}`));
        return null;
      }
      setProgress((prev) => ({ ...prev, [file.name]: 100 }));
      const fileId = (commit.file as { id: string } | undefined)?.id ?? (commit.fileId as string);
      return { fileId, filename: file.name };
    },
    [client, workspaceId, t],
  );

  // Merge one discover response into the discovered / failures lists. Idempotent per fileId: a file
  // that now parses drops out of failures, and a still-failing retry replaces its own row rather than
  // stacking a duplicate. K-15 carries the full failure shape (reason code + detected encoding /
  // delimiter + bundle member) so a failed row is diagnosable, not a bare sentence.
  const mergeDiscovery = useCallback((disc: Record<string, unknown>, byId: Map<string, string>): void => {
    const files0 = (disc.files ?? []) as Array<Record<string, unknown>>;
    const fails0 = (disc.failures ?? []) as Array<Record<string, unknown>>;
    const okIds = new Set(files0.map((f) => f.fileId as string));
    setDiscovered((prev) => [
      ...prev.filter((p) => !okIds.has(p.fileId)),
      ...files0.map((f) => ({
        fileId: f.fileId as string,
        filename: byId.get(f.fileId as string) ?? (f.fileId as string),
        adapter: (f.adapter as string) ?? 'csv',
        dataClasses: (f.dataClasses as string[]) ?? [],
        rowCount: (f.rowCount as number) ?? 0,
        headers: (f.headers as string[]) ?? [],
        confidence: (f.confidence as string) ?? 'low',
        asAt: (f.asAt as string | null) ?? null,
        warnings: (f.warnings as string[]) ?? [],
        worksheets: (f.worksheets as string[] | undefined) ?? undefined,
        worksheet: (f.worksheet as string | undefined) ?? undefined,
        members: (f.members as Array<{ fileId: string; filename: string }> | undefined) ?? undefined,
      })),
    ]);
    setFailures((prev) => {
      const failIds = new Set(fails0.map((f) => f.fileId as string));
      return [
        ...prev.filter((p) => !failIds.has(p.fileId) && !okIds.has(p.fileId)),
        ...fails0.map((f) => ({
          fileId: f.fileId as string,
          filename: byId.get(f.fileId as string) ?? (f.fileId as string),
          error: (f.error as string) ?? 'source_unparseable',
          reason: f.reason as string | undefined,
          detectedEncoding: f.detectedEncoding as string | undefined,
          detectedDelimiter: f.detectedDelimiter as string | undefined,
          member: f.member as string | undefined,
        })),
      ];
    });
  }, []);

  const ingest = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setBusy(true);
      setNotice(null);
      try {
        const uploaded: Array<{ fileId: string; filename: string }> = [];
        for (const file of list) {
          // A file over the single-call bound goes through the chunk lane with visible progress; a
          // small one keeps the single base64 call. The human never sees `file_too_large_use_stream`.
          if (file.size > SINGLE_CALL_MAX_BYTES) {
            setProgress((prev) => ({ ...prev, [file.name]: 0 }));
            const large = await uploadViaLane(file);
            if (large !== null) uploaded.push(large);
            continue;
          }
          const contentBase64 = await fileToBase64(file);
          const up = (
            await client.call('files_upload', {
              workspaceId,
              contentBase64,
              filename: file.name,
              mime: file.type || 'text/csv',
              idempotencyKey: newIdempotencyKey(),
            })
          ).body;
          if (isErr(up)) {
            setNotice(t(`migration.intake.uploadError.${up.error === 'file_too_large' ? 'tooLarge' : 'generic'}`));
            continue;
          }
          uploaded.push({ fileId: (up.file as { id: string } | undefined)?.id ?? (up.fileId as string), filename: file.name });
        }
        if (uploaded.length === 0) return;

        const byId = new Map(uploaded.map((u) => [u.fileId, u.filename]));
        const disc = (await client.call('migration_discover_source', { workspaceId, fileIds: uploaded.map((u) => u.fileId) })).body;
        if (isErr(disc)) {
          setNotice(t('migration.intake.discoverError'));
          return;
        }
        mergeDiscovery(disc, byId);
        // Seed the plan form from the first confident detection: adapter and the file's own as-of date.
        const files0 = (disc.files ?? []) as Array<Record<string, unknown>>;
        const lead = files0[0];
        if (lead !== undefined) {
          const adapterId = (lead.adapter as string) ?? 'csv';
          setSourceSystem(adapterId);
          const asAt = lead.asAt as string | null;
          if (typeof asAt === 'string' && asAt !== '') setCutoverDate((prev) => (prev === '' ? asAt : prev));
        }
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, t, uploadViaLane, mergeDiscovery],
  );

  // K-15 recovery: re-run discovery for a single failed file AS-IS (useful after a re-upload or a
  // transient integrity failure). This is the default retry; when auto-detection is the problem, the
  // "force a format" retry below pins the adapter/encoding/delimiter instead.
  const retryDiscover = useCallback(
    async (target: DiscoverFailure): Promise<void> => {
      setBusy(true);
      setNotice(null);
      try {
        const disc = (await client.call('migration_discover_source', { workspaceId, fileIds: [target.fileId] })).body;
        if (isErr(disc)) {
          setNotice(t('migration.intake.discoverError'));
          return;
        }
        mergeDiscovery(disc, new Map([[target.fileId, target.filename]]));
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, t, mergeDiscovery],
  );

  // K-15: re-run discovery for a single failed file FORCING the chosen format. Only the fields the
  // operator actually picked are sent, so a partial choice (e.g. just the encoding) still leaves the
  // rest to auto-detection. When nothing is chosen this is the same as the as-is retry.
  const forceRetry = useCallback(
    async (target: DiscoverFailure): Promise<void> => {
      const choice = overrideChoice[target.fileId] ?? {};
      const override: Record<string, string> = {};
      if (choice.adapter !== undefined && choice.adapter !== '') override.adapter = choice.adapter;
      if (choice.encoding !== undefined && choice.encoding !== '') override.encoding = choice.encoding;
      if (choice.delimiter !== undefined && choice.delimiter !== '') override.delimiter = choice.delimiter;
      setBusy(true);
      setNotice(null);
      try {
        const disc = (
          await client.call('migration_discover_source', {
            workspaceId,
            fileIds: [target.fileId],
            ...(Object.keys(override).length > 0 ? { override } : {}),
          })
        ).body;
        if (isErr(disc)) {
          setNotice(t('migration.intake.discoverError'));
          return;
        }
        mergeDiscovery(disc, new Map([[target.fileId, target.filename]]));
      } finally {
        setBusy(false);
      }
    },
    [client, workspaceId, t, mergeDiscovery, overrideChoice],
  );

  /** Set one field of a failed file's forced-format choice. */
  function setOverrideField(fileId: string, field: 'adapter' | 'encoding' | 'delimiter', value: string): void {
    setOverrideChoice((prev) => ({ ...prev, [fileId]: { ...prev[fileId], [field]: value } }));
  }

  // K-15 recovery: drop a failed file from the batch so the operator can proceed with the files that
  // did classify. Nothing was ever written for it, so this is a pure surface-state removal.
  function removeFailure(fileId: string): void {
    setFailures((prev) => prev.filter((f) => f.fileId !== fileId));
  }

  async function createPlan(): Promise<void> {
    setBusy(true);
    setPlanError(null);
    try {
      const res = (
        await client.call('migration_create_plan', {
          workspaceId,
          sourceSystem,
          cutoverDate,
          idempotencyKey: newIdempotencyKey(),
        })
      ).body;
      if (isErr(res)) {
        setPlanError(res.error === 'invalid_input' ? 'invalidDate' : 'generic');
        return;
      }
      const id = res.planId as string;
      setPlanId(id);
      // Re-run discovery WITH the plan so each classified file is linked as a Beleg (US-G09.8): the
      // G11 source_as_at and document-integrity controls read those linked files.
      if (discovered.length > 0) {
        await client.call('migration_discover_source', { workspaceId, planId: id, fileIds: discovered.map((f) => f.fileId) });
      }
      setSelected(new Set(offeredClasses));
      setPhase('scope');
    } finally {
      setBusy(false);
    }
  }

  async function saveScope(): Promise<void> {
    if (planId === null) return;
    setBusy(true);
    setScopeError(null);
    try {
      const classes = offeredClasses.map((dataClass) => ({ dataClass, include: selected.has(dataClass) }));
      const res = (await client.call('migration_set_scope', { workspaceId, planId, classes, idempotencyKey: newIdempotencyKey() })).body;
      if (isErr(res)) {
        setScopeError('generic');
        return;
      }
      setUnavailable(((res.unavailable ?? []) as Array<{ dataClass: string; owner: string }>) ?? []);
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  function toggle(dataClass: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dataClass)) next.delete(dataClass);
      else next.add(dataClass);
      return next;
    });
  }

  return (
    <section className="intake" aria-busy={busy ? 'true' : undefined}>
      <ol className="intake-steps" aria-label={t('migration.intake.stepsLabel')}>
        <li className={phase === 'files' ? 'is-current' : undefined} aria-current={phase === 'files' ? 'step' : undefined}>
          {t('migration.intake.step.files')}
        </li>
        <li className={phase === 'plan' ? 'is-current' : undefined} aria-current={phase === 'plan' ? 'step' : undefined}>
          {t('migration.intake.step.plan')}
        </li>
        <li className={phase === 'scope' ? 'is-current' : undefined} aria-current={phase === 'scope' ? 'step' : undefined}>
          {t('migration.intake.step.scope')}
        </li>
      </ol>

      {phase === 'files' && (
        <div className="intake-files">
          {/* K-13: the one FileDrop primitive (a drop zone around the real, labelled input), never a
              hand-rolled proxy of a hidden input. */}
          <FileDrop
            multiple
            disabled={busy}
            label={t('migration.intake.drop.choose')}
            prompt={t('migration.intake.drop.hint')}
            onFiles={(files) => void ingest(files)}
          />

          {notice !== null && <ActionFeedback tone="error" message={notice} />}

          {Object.keys(progress).length > 0 && (
            <ul className="intake-progress" aria-live="polite" aria-label={t('migration.source.uploadProgress')}>
              {Object.entries(progress).map(([name, pct]) => (
                <li key={name} className="intake-progress-row">
                  <span className="intake-progress-name">{name}</span>
                  <progress className="intake-progress-bar" max={100} value={pct} aria-label={name} />
                  <span className="intake-progress-pct">{t('migration.source.uploadProgress')}: {pct}%</span>
                </li>
              ))}
            </ul>
          )}

          {discovered.length > 0 && (
            <ul className="intake-discovered">
              {discovered.map((f) => (
                <li key={f.fileId} className="intake-file">
                  <p className="intake-file-name">{f.filename}</p>
                  <dl className="intake-file-facts">
                    <div>
                      <dt>{t('migration.intake.file.adapter')}</dt>
                      <dd>{adapterLabel(adapters, f.adapter)}</dd>
                    </div>
                    <div>
                      <dt>{t('migration.intake.file.rows')}</dt>
                      <dd>{f.rowCount}</dd>
                    </div>
                    <div>
                      <dt>{t('migration.intake.file.asAt')}</dt>
                      <dd>{f.asAt ?? t('migration.intake.file.noAsAt')}</dd>
                    </div>
                  </dl>
                  {f.worksheets !== undefined && f.worksheets.length > 0 && (
                    <div className="intake-file-worksheet">
                      <label htmlFor={`ws-${f.fileId}`}>{t('migration.source.worksheet')}</label>
                      <Select
                        id={`ws-${f.fileId}`}
                        value={worksheetChoice[f.fileId] ?? f.worksheet ?? f.worksheets[0]}
                        onChange={(val) => setWorksheetChoice((prev) => ({ ...prev, [f.fileId]: val }))}
                        options={f.worksheets.map((w) => ({ value: w, label: w }))}
                        ariaLabel={t('migration.source.worksheet')}
                      />
                    </div>
                  )}
                  {f.members !== undefined && f.members.length > 0 && (
                    <details className="intake-file-bundle">
                      <summary>{t('migration.source.bundle')} ({f.members.length})</summary>
                      <ul>
                        {f.members.map((m) => (
                          <li key={m.fileId}>{m.filename}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {f.dataClasses.length > 0 && (
                    // K-22: the recognised data classes are words, so they read as a quiet list, never
                    // a row of chips (a chip is for a number).
                    <p className="intake-file-classes">{f.dataClasses.map((c) => classLabel(t, c)).join(', ')}</p>
                  )}
                  {f.warnings.length > 0 && (
                    <p className="intake-file-warn" role="note">{f.warnings.join(' ')}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {failures.length > 0 && (
            <ul className="intake-failures">
              {failures.map((f) => (
                <li key={f.fileId} className="intake-failure" role="note">
                  <p className="intake-failure-name">
                    <strong>{f.filename}</strong>
                    {f.member !== undefined && <span className="intake-failure-member"> ({f.member})</span>}
                  </p>
                  {/* K-15: the localised REASON the engine gave, never a generic sentence. */}
                  <p className="intake-failure-reason">{failureReason(t, f)}</p>
                  {(f.detectedEncoding !== undefined || f.detectedDelimiter !== undefined) && (
                    <p className="intake-failure-detected">
                      {f.detectedEncoding !== undefined && (
                        <span>{t('migration.intake.failure.encoding', { value: f.detectedEncoding })}</span>
                      )}
                      {f.detectedDelimiter !== undefined && (
                        <span>{t('migration.intake.failure.delimiter', { value: f.detectedDelimiter })}</span>
                      )}
                    </p>
                  )}
                  {/* K-15: force a format when auto-detection got the adapter/encoding/delimiter wrong.
                      The chosen fields are sent as the discover override; unset fields stay auto. */}
                  <details className="intake-failure-force">
                    <summary>{t('migration.intake.failure.force')}</summary>
                    <p className="intake-hint">{t('migration.intake.failure.forceHint')}</p>
                    <div className="intake-failure-force-fields">
                      <label>
                        {t('migration.intake.failure.forceAdapter')}
                        <Select
                          value={overrideChoice[f.fileId]?.adapter ?? ''}
                          onChange={(val) => setOverrideField(f.fileId, 'adapter', val)}
                          options={[
                            { value: '', label: t('migration.intake.failure.forceAuto') },
                            ...adapters.map((a) => ({ value: a.id, label: a.label })),
                          ]}
                          ariaLabel={t('migration.intake.failure.forceAdapter')}
                        />
                      </label>
                      <label>
                        {t('migration.intake.failure.forceEncoding')}
                        <Select
                          value={overrideChoice[f.fileId]?.encoding ?? ''}
                          onChange={(val) => setOverrideField(f.fileId, 'encoding', val)}
                          options={[
                            { value: '', label: t('migration.intake.failure.forceAuto') },
                            ...FORCE_ENCODINGS.map((enc) => ({ value: enc, label: enc })),
                          ]}
                          ariaLabel={t('migration.intake.failure.forceEncoding')}
                        />
                      </label>
                      <label>
                        {t('migration.intake.failure.forceDelimiter')}
                        <Select
                          value={overrideChoice[f.fileId]?.delimiter ?? ''}
                          onChange={(val) => setOverrideField(f.fileId, 'delimiter', val)}
                          options={[
                            { value: '', label: t('migration.intake.failure.forceAuto') },
                            ...FORCE_DELIMITERS.map((d) => ({
                              value: d,
                              label: t(`migration.intake.failure.delimiterName.${d}`),
                            })),
                          ]}
                          ariaLabel={t('migration.intake.failure.forceDelimiter')}
                        />
                      </label>
                    </div>
                    <button type="button" className="btn btn--secondary intake-failure-force-retry" disabled={busy} onClick={() => void forceRetry(f)}>
                      {t('migration.intake.failure.forceRetry')}
                    </button>
                  </details>

                  {/* K-15: per-row recovery. Retry re-runs discovery for this file AS-IS; remove drops it
                      from the batch so the classified files can still proceed. */}
                  <div className="intake-failure-actions">
                    <button type="button" className="btn btn--secondary intake-failure-retry" disabled={busy} onClick={() => void retryDiscover(f)}>
                      {t('migration.intake.failure.retry')}
                    </button>
                    <button type="button" className="btn btn--ghost intake-failure-remove" onClick={() => removeFailure(f.fileId)}>
                      {t('migration.intake.failure.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {discovered.length > 0 && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setPhase('plan')}>
              {t('migration.intake.continue')}
            </button>
          )}
        </div>
      )}

      {phase === 'plan' && (
        <form
          className="intake-plan"
          onSubmit={(e) => {
            e.preventDefault();
            void createPlan();
          }}
        >
          <label htmlFor="intake-source">{t('migration.intake.plan.source')}</label>
          <Select
            id="intake-source"
            value={sourceSystem}
            onChange={(val) => setSourceSystem(val)}
            options={adapters.map((a) => ({ value: a.id, label: a.label }))}
            ariaLabel={t('migration.intake.plan.source')}
          />

          <label htmlFor="intake-cutover">{t('migration.intake.plan.cutover')}</label>
          <input
            className="field"
            id="intake-cutover"
            type="date"
            value={cutoverDate}
            onChange={(e) => setCutoverDate(e.target.value)}
            aria-describedby="intake-cutover-hint"
          />
          <span id="intake-cutover-hint" className="intake-hint">{t('migration.intake.plan.cutoverHint')}</span>

          {planError !== null && (
            <ActionFeedback tone="error" message={t(`migration.intake.plan.err.${planError}`)} />
          )}

          <div className="intake-actions">
            <button type="button" className="btn btn--secondary intake-back" onClick={() => setPhase('files')}>{t('migration.intake.back')}</button>
            <button type="submit" className="btn btn--primary" disabled={busy || cutoverDate === ''}>
              {t('migration.intake.plan.create')}
            </button>
          </div>
        </form>
      )}

      {phase === 'scope' && (
        <div className="intake-scope">
          <h2>{t('migration.intake.scope.title')}</h2>
          <p className="intake-hint">{t('migration.intake.scope.body')}</p>
          <ul className="intake-scope-list">
            {offeredClasses.map((c) => (
              <li key={c}>
                <label>
                  <input type="checkbox" checked={selected.has(c)} onChange={() => toggle(c)} />
                  {classLabel(t, c)}
                </label>
              </li>
            ))}
          </ul>
          {unavailable.length > 0 && (
            <ul className="intake-unavailable">
              {unavailable.map((u) => (
                <li key={u.dataClass} role="note">
                  {t('migration.intake.scope.unavailable', { cls: classLabel(t, u.dataClass), owner: u.owner })}
                </li>
              ))}
            </ul>
          )}
          {scopeError !== null && (
            <ActionFeedback tone="error" message={t('migration.intake.scope.err.generic')} />
          )}
          <button type="button" className="btn btn--primary" disabled={busy || selected.size === 0} onClick={() => void saveScope()}>
            {t('migration.intake.scope.confirm')}
          </button>
        </div>
      )}
    </section>
  );
}

function adapterLabel(adapters: readonly AdapterDto[], id: string): string {
  return adapters.find((a) => a.id === id)?.label ?? id;
}

/** A data-class label, falling back to a humanised id when a class has no catalogue key yet. */
function classLabel(t: (key: string) => string, dataClass: string): string {
  const key = `migration.dataClass.${dataClass}`;
  const hit = t(key);
  return hit === key ? dataClass : hit;
}

export default SourceIntake;
