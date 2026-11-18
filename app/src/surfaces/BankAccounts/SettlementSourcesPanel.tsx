/**
 * D198, the settlement feed on the Bankkonten screen: where TILL pulls a payment processor's settlement
 * feed from, its token, and "Jetzt abholen".
 *
 * WHY HERE. A source is a money channel like an EBICS connection: it says where facts about money come
 * from, and its payouts land on the accounts this screen registers. It is configuration, so it lives on
 * this settings screen and never on the bank inbox.
 *
 * THE TOKEN IS WRITE-ONLY. The field is a password field that is always empty; the engine says only
 * whether a token is stored (a key glyph), never the token. Saving a source is a PERSON's act
 * (`set_settlement_source` is human-only), which is why it exists in the Studio at all.
 *
 * A43 §3: every source is a row, whatever its door: a feed (a saved `settlement_source`), a table (a saved
 * table mapping) or a file (a booking template only). Each row carries its type glyph, the template edit
 * (`SettlementTemplateEditor`), and the export and import of its table mapping as a `till-import-profile/v1`
 * file.
 *
 * Low cognitive load (DESIGN.md rule 7): one row per source, icons with their words on hover, the
 * editor opens on demand. The pull answers in one line (booked, already there, skipped); a refusal is
 * worded by the engine's code through `refusalText`.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { NoteGlyph, StatusSuccessGlyph, StatusWarnGlyph, TextLinesGlyph, VOCABULARY } from '../../components/icons';
import { ErrorBanner, refusalText } from '../../components/states';
import { SettlementTemplateEditor } from './SettlementTemplateEditor';

export interface SettlementSourceDto {
  sourceId: string;
  system: string;
  processor: string;
  baseUrl: string;
  /** A43 §4: the path the feed is served under (the default when none was saved). */
  feedPath?: string;
  fromDate: string;
  tokenStored: boolean;
  watermark: string | null;
  lastPull: { outcome: 'ok' | 'incomplete' | 'failed'; errorCode: string | null; booked: number; at: string; to: string } | null;
  templateSaved: boolean;
}

/** A43 §3: the door a source came through. */
export type SourceType = 'feed' | 'table' | 'file';

export interface SourceRow {
  key: string;
  system: string;
  processor: string;
  type: SourceType;
  feed: SettlementSourceDto | null;
  /** The table mapping as its profile file, for the export; null without a saved mapping. */
  profile: Record<string, unknown> | null;
}

/** Merge the feeds, the templates and the table mappings into one row per (system, processor). */
export function sourceRowsOf(
  feeds: readonly SettlementSourceDto[],
  templates: readonly { system: string; processor: string }[],
  mappings: readonly { system: string; processor: string; profile: Record<string, unknown> }[],
): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  const ensure = (system: string, processor: string, type: SourceType): SourceRow => {
    const key = JSON.stringify([system, processor]);
    const found = rows.get(key);
    if (found !== undefined) return found;
    const row: SourceRow = { key, system, processor, type, feed: null, profile: null };
    rows.set(key, row);
    return row;
  };
  for (const f of feeds) ensure(f.system, f.processor, 'feed').feed = f;
  for (const m of mappings) ensure(m.system, m.processor, 'table').profile = m.profile;
  for (const tpl of templates) ensure(tpl.system, tpl.processor, 'file');
  return [...rows.values()].sort((a, b) => a.system.localeCompare(b.system) || a.processor.localeCompare(b.processor));
}

const TYPE_GLYPH = { feed: VOCABULARY.refresh.glyph, table: TextLinesGlyph, file: NoteGlyph } as const;

interface Draft {
  system: string;
  processor: string;
  baseUrl: string;
  /** Empty means the default path. */
  feedPath: string;
  fromDate: string;
  token: string;
}

/** A43 §4: the engine's default feed path (`SETTLEMENT_FEED_PATH`); an empty field sends it. */
export const DEFAULT_FEED_PATH = '/api/accounting/till-settlement';

const EMPTY: Draft = { system: '', processor: '', baseUrl: 'https://', feedPath: '', fromDate: '', token: '' };

/** The refusal codes this panel words itself (`settlementFeed.refusal.<code>`). */
const KNOWN = [
  'human_only',
  'settlement_source_missing',
  'settlement_template_missing',
  'token_missing',
  'feed_transport_missing',
  'secret_store_unavailable',
  'secret_store_failed',
  'feed_unreachable',
  'feed_unauthorized',
  'feed_bad_request',
  'feed_http_error',
  'feed_schema',
  'feed_source_mismatch',
  'no_actor',
  'unsupported_schema',
  'invalid_input',
] as const;

export function SettlementSourcesPanel({ workspaceId, canPost }: { workspaceId: string; canPost: boolean }) {
  const t = useT();
  const client = useClient();
  const id = useId();
  const [sources, setSources] = useState<SettlementSourceDto[] | null>(null);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [templateOf, setTemplateOf] = useState<SourceRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const importFor = useRef<SourceRow | null>(null);
  const profileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [feed, tpl, map] = await Promise.all([
      client.call('get_settlement_source', { workspaceId }),
      client.call('get_settlement_template', { workspaceId }),
      client.call('get_settlement_table_mapping', { workspaceId }),
    ]);
    if (isErr(feed.body)) {
      setError(feed.body);
      return;
    }
    const feeds = (feed.body as unknown as { sources?: SettlementSourceDto[] }).sources ?? [];
    // A template or mapping read that fails leaves its rows out; the feeds still show.
    const templates = isErr(tpl.body) ? [] : ((tpl.body as unknown as { templates?: { system: string; processor: string }[] }).templates ?? []);
    const mappings = isErr(map.body) ? [] : ((map.body as unknown as { mappings?: { system: string; processor: string; profile: Record<string, unknown> }[] }).mappings ?? []);
    setSources(feeds);
    setRows(sourceRowsOf(feeds, templates, mappings));
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (sources === null) return error === null ? null : <ErrorBanner message={refusalText(t, error, { own: 'settlementFeed.refusal', known: KNOWN })} />;

  const word = (e: Err): string => refusalText(t, e, { own: 'settlementFeed.refusal', known: KNOWN });

  const save = async () => {
    if (editing === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const { body } = await client.call('set_settlement_source', {
      workspaceId,
      system: editing.system,
      processor: editing.processor,
      baseUrl: editing.baseUrl,
      // Empty is the default path, sent as such: omitting it would keep a custom path saved before.
      feedPath: editing.feedPath.trim() === '' ? DEFAULT_FEED_PATH : editing.feedPath.trim(),
      fromDate: editing.fromDate,
      ...(editing.token.length > 0 ? { feedToken: editing.token } : {}),
      // D198 re-cut R7: a fresh key per save, so a second save with another token is never a replay.
      idempotencyKey: `d198-source-${crypto.randomUUID()}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setEditing(null);
    void load();
  };

  const pull = async (s: SettlementSourceDto) => {
    setBusy(true);
    setError(null);
    setDone(null);
    const { body } = await client.call('pull_settlement', {
      workspaceId,
      system: s.system,
      processor: s.processor,
      idempotencyKey: `d198-pull-${s.sourceId}-${crypto.randomUUID()}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    const r = body as unknown as { complete?: boolean; import: { booked: number; alreadyImported: number; skipped: number; refused: number } | null };
    // D198 re-cut R3: an incomplete document books nothing (import is null).
    if (r.import === null || r.complete === false) setDone(t('settlementFeed.incomplete'));
    else setDone(t('settlementFeed.pulled', { booked: r.import.booked, already: r.import.alreadyImported, skipped: r.import.skipped, refused: r.import.refused }));
    void load();
  };

  /** A43 §2: the saved table mapping as a `till-import-profile/v1` file. */
  const exportProfile = (row: SourceRow) => {
    if (row.profile === null) return;
    const blob = new Blob([`${JSON.stringify(row.profile, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${row.system}.${row.processor}.till-import-profile.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /** A43 §2: a profile file saved as the table mapping of the row's source (the engine checks it). */
  const importProfile = async (list: FileList | null) => {
    const row = importFor.current;
    const picked = list?.[0];
    if (row === null || picked === undefined) return;
    setError(null);
    setDone(null);
    let profile: unknown;
    try {
      profile = JSON.parse(await picked.text());
    } catch {
      setError({ ok: false, error: 'invalid_input' } as Err);
      return;
    }
    setBusy(true);
    const { body } = await client.call('set_settlement_table_mapping', {
      workspaceId,
      system: row.system,
      processor: row.processor,
      profile,
      idempotencyKey: `a43-profile-${crypto.randomUUID()}`,
    });
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    setDone(t('settlementFeed.profileImported'));
    void load();
  };

  const valid = editing !== null && editing.system.trim() !== '' && editing.processor.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(editing.fromDate) && editing.baseUrl.length > 8;

  return (
    <section className="bank-settlement" aria-labelledby={`${id}-title`}>
      <div className="bank-settlement-head">
        <h2 id={`${id}-title`} className="bank-settlement-title">
          {t('settlementFeed.title')}
        </h2>
        <IconButton icon="info" small context={t('settlementFeed.hint')} />
        {canPost && editing === null && <IconButton icon="add" context={t('settlementFeed.add')} onClick={() => setEditing({ ...EMPTY })} />}
      </div>

      {error !== null && <ErrorBanner message={word(error)} />}
      {done !== null && (
        <p className="bank-settlement-done" role="status">
          {done}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="bank-settlement-list">
          {rows.map((row) => {
            const s = row.feed;
            const Glyph = TYPE_GLYPH[row.type];
            const typeWord = t(`settlementFeed.type.${row.type}`);
            return (
              <li key={row.key} className="bank-settlement-row" data-testid={`settlement-source-${row.system}-${row.processor}`} data-type={row.type}>
                <Tooltip content={typeWord}>
                  <span className="bank-settlement-token" role="img" aria-label={typeWord} tabIndex={0}>
                    <Glyph size={16} />
                  </span>
                </Tooltip>
                <span className="bank-settlement-name">
                  {row.system} · {row.processor}
                </span>
                {s !== null && (
                  <>
                    <span className="bank-settlement-url">{s.baseUrl}</span>
                    <span className="bank-settlement-token" title={s.tokenStored ? t('settlementFeed.tokenStored') : t('settlementFeed.tokenMissing')}>
                      {s.tokenStored ? <StatusSuccessGlyph size={16} /> : <StatusWarnGlyph size={16} />}
                      <span className="visually-hidden">{s.tokenStored ? t('settlementFeed.tokenStored') : t('settlementFeed.tokenMissing')}</span>
                    </span>
                    <span className="bank-settlement-last">
                      {s.lastPull === null
                        ? t('settlementFeed.neverPulled')
                        : s.lastPull.outcome === 'ok'
                          ? t('settlementFeed.lastOk', { day: formatDate(s.lastPull.to) })
                          : s.lastPull.outcome === 'incomplete'
                            ? t('settlementFeed.incomplete')
                            : t('settlementFeed.lastFailed', { why: word({ ok: false, error: s.lastPull.errorCode ?? 'unknown' } as Err) })}
                    </span>
                  </>
                )}
                {canPost && (
                  <>
                    {s !== null && (
                      <>
                        <IconButton
                          icon="refresh"
                          context={s.templateSaved ? t('settlementFeed.pull') : t('settlementFeed.refusal.settlement_template_missing')}
                          disabled={busy || !s.templateSaved || !s.tokenStored}
                          onClick={() => void pull(s)}
                        />
                        <IconButton
                          icon="edit"
                          context={t('settlementFeed.edit')}
                          disabled={busy}
                          onClick={() =>
                            setEditing({
                              system: s.system,
                              processor: s.processor,
                              baseUrl: s.baseUrl,
                              feedPath: s.feedPath === undefined || s.feedPath === DEFAULT_FEED_PATH ? '' : s.feedPath,
                              fromDate: s.fromDate,
                              token: '',
                            })
                          }
                        />
                      </>
                    )}
                    <IconButton icon="settings" context={t('settlementFeed.editTemplate')} disabled={busy} onClick={() => setTemplateOf(row)} />
                    {row.profile !== null && <IconButton icon="download" context={t('settlementFeed.exportMapping')} disabled={busy} onClick={() => exportProfile(row)} />}
                    <IconButton
                      icon="import"
                      context={t('settlementFeed.importMapping')}
                      disabled={busy}
                      onClick={() => {
                        importFor.current = row;
                        profileInput.current?.click();
                      }}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={profileInput}
        type="file"
        accept=".json,application/json"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="settlement-profile-input"
        onChange={(e) => {
          void importProfile(e.target.files);
          e.target.value = '';
        }}
      />

      {templateOf !== null && (
        <SettlementTemplateEditor
          workspaceId={workspaceId}
          system={templateOf.system}
          processor={templateOf.processor}
          canPost={canPost}
          onSaved={() => {
            setTemplateOf(null);
            setDone(t('settlementFeed.templateSaved'));
            void load();
          }}
          onCancel={() => setTemplateOf(null)}
        />
      )}

      {editing !== null && (
        <form
          className="bank-settlement-editor"
          aria-label={t('settlementFeed.editorLabel')}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${id}-system`}>{t('settlementFeed.field.system')}</label>
          <input id={`${id}-system`} className="field" value={editing.system} disabled={busy} onChange={(e) => setEditing({ ...editing, system: e.target.value })} />
          <label htmlFor={`${id}-processor`}>{t('settlementFeed.field.processor')}</label>
          <input id={`${id}-processor`} className="field" value={editing.processor} disabled={busy} onChange={(e) => setEditing({ ...editing, processor: e.target.value })} />
          <label htmlFor={`${id}-url`}>{t('settlementFeed.field.baseUrl')}</label>
          <input id={`${id}-url`} className="field" type="url" value={editing.baseUrl} disabled={busy} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} />
          <span className="bank-settlement-label">
            <label htmlFor={`${id}-path`}>{t('settlementFeed.field.feedPath')}</label>
            <IconButton icon="info" small context={t('settlementFeed.field.feedPathHint', { path: DEFAULT_FEED_PATH })} />
          </span>
          <input
            id={`${id}-path`}
            className="field"
            value={editing.feedPath}
            placeholder={DEFAULT_FEED_PATH}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setEditing({ ...editing, feedPath: e.target.value })}
          />
          <label htmlFor={`${id}-from`}>{t('settlementFeed.field.fromDate')}</label>
          <input id={`${id}-from`} className="field" type="date" value={editing.fromDate} disabled={busy} onChange={(e) => setEditing({ ...editing, fromDate: e.target.value })} />
          <label htmlFor={`${id}-token`}>{t('settlementFeed.field.token')}</label>
          <input
            id={`${id}-token`}
            className="field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={editing.token}
            disabled={busy}
            onChange={(e) => setEditing({ ...editing, token: e.target.value })}
          />
          <div className="bank-settlement-actions">
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !valid}>
              {t('settlementFeed.save')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setEditing(null)}>
              {t('settlementFeed.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
