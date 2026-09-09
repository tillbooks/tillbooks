/**
 * G19 §6, the EXTRACTION CHECKLIST: the first mile of a migration, rendered as the opening phase of
 * the Datenübernahme surface (getting data OUT of the old system, before Quellen). One row per
 * manifest item, merged from the shipped guide (what, source area, tactic-ladder rung, quirks, the
 * module question) and the plan's manifest (status, evidence, counts, date range).
 *
 * WHAT THIS SURFACE IS CAREFUL ABOUT (D46: the deep UX polish is a later pass; the WORKING states
 * are here):
 *   - The deletion clock spends colour only when it is the problem: 14 days orange, past-due danger,
 *     otherwise neutral text with the days remaining (never colour alone, WCAG 2.2 AA).
 *   - A rung-3/4 item shows the gate note ("vorgesehen, noch nicht verfügbar") rather than a working
 *     companion control: the browser companion is proposed and gated, never promised (US-G19.4).
 *   - The status is glyph PLUS text, and the last rung (the Datenherausgabe letter) is reachable
 *     from the checklist without a mouse.
 *   - A complete manifest renders one neutral line ("Alle Exporte erfasst"); passing state spends no
 *     colour (brand law).
 *   - Nothing is minted that is not in the registry: it wires migration_get_manifest,
 *     migration_get_extraction_guide, migration_set_manifest and migration_set_manifest_item.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const STATUSES = ['open', 'exported', 'not_used', 'blocked'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_GLYPH: Record<Status, string> = {
  open: '○',
  exported: '●',
  not_used: '–',
  blocked: '▲',
};

interface GuideItem {
  id: string;
  what: string;
  sourceArea: string;
  formats: string[];
  rung: number;
  rungGated: boolean;
  quirks: string[];
  statutory: boolean;
  moduleQuestion?: string;
}
interface GuideLetterLocale {
  subject: string;
  body: string[];
  limitsParagraph: string;
}
interface Guide {
  sourceSystem: string;
  label: string;
  items: GuideItem[];
  letterTemplate: Record<string, GuideLetterLocale>;
}
interface ManifestItem {
  itemId: string;
  status: Status;
  fileIds: string[];
  rowCount?: number;
  dateFrom?: string;
  dateTo?: string;
  note?: string;
}
interface Completeness {
  denominator: number;
  open: number;
  blocked: number;
  complete: boolean;
}
interface Deadline {
  sourceAccessUntil: string;
  daysRemaining: number;
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty'; guide: Guide }
  | { status: 'loaded'; guide: Guide; items: ManifestItem[]; completeness: Completeness; deadline: Deadline | null };

export function ExtractionChecklist(props: {
  workspaceId: string;
  planId: string;
  sourceSystem: string | null;
  canManageImport: boolean;
}): React.ReactElement {
  const { workspaceId, planId, sourceSystem, canManageImport } = props;
  const client = useClient();
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [letterOpen, setLetterOpen] = useState(false);
  const [company, setCompany] = useState<{ name: string; address: string }>({ name: '', address: '' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const guideRes = (await client.call('migration_get_extraction_guide', { sourceSystem: sourceSystem ?? undefined })).body;
    if (isErr(guideRes)) {
      setState({ status: 'error' });
      return;
    }
    const guide = guideRes.guide as unknown as Guide;
    const manRes = (await client.call('migration_get_manifest', { workspaceId, planId })).body;
    if (isErr(manRes)) {
      setState({ status: 'error' });
      return;
    }
    if (manRes.manifest === null) {
      setState({ status: 'empty', guide });
      return;
    }
    setState({
      status: 'loaded',
      guide,
      items: (manRes.items ?? []) as ManifestItem[],
      completeness: manRes.completeness as unknown as Completeness,
      deadline: (manRes.deadline ?? null) as Deadline | null,
    });
  }, [client, workspaceId, planId, sourceSystem]);

  useEffect(() => {
    void load();
  }, [load]);

  // The A00 profile the letter is pre-filled from (spec §4: the verb carries no workspace of its own).
  useEffect(() => {
    if (!letterOpen) return;
    void (async () => {
      const p = (await client.call('get_company_profile', { workspaceId })).body;
      if (!isErr(p)) {
        const profile = p.profile as { name?: string; address?: string } | undefined;
        setCompany({ name: profile?.name ?? '', address: profile?.address ?? '' });
      }
    })();
  }, [letterOpen, client, workspaceId]);

  async function createManifest(): Promise<void> {
    await client.call('migration_set_manifest', { workspaceId, planId, idempotencyKey: newIdempotencyKey() });
    await load();
  }

  async function setItemStatus(itemId: string, status: Status): Promise<void> {
    await client.call('migration_set_manifest_item', { workspaceId, planId, itemId, status, idempotencyKey: newIdempotencyKey() });
    await load();
  }

  if (state.status === 'loading') {
    return (
      <section className="extraction" aria-busy="true" aria-label={t('migration.extraction.title')}>
        <h2>{t('migration.extraction.title')}</h2>
        <div className="extraction-skeleton" aria-hidden="true">
          <div className="extraction-skeleton-row" />
          <div className="extraction-skeleton-row" />
          <div className="extraction-skeleton-row" />
        </div>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="extraction" aria-label={t('migration.extraction.title')}>
        <h2>{t('migration.extraction.title')}</h2>
        <p className="extraction-error" role="alert">{t('migration.error')}</p>
      </section>
    );
  }

  if (state.status === 'empty') {
    return (
      <section className="extraction" aria-label={t('migration.extraction.title')}>
        <h2>{t('migration.extraction.title')}</h2>
        <div className="extraction-empty">
          <p>{t('migration.extraction.empty')}</p>
          {canManageImport && (
            <button type="button" className="migration-primary" onClick={() => void createManifest()}>
              {t('migration.extraction.create')}
            </button>
          )}
        </div>
      </section>
    );
  }

  const { guide, items, completeness, deadline } = state;
  const byId = new Map(items.map((it) => [it.itemId, it]));
  const source = guide.label;

  return (
    <section className="extraction" aria-label={t('migration.extraction.title')}>
      <h2>{t('migration.extraction.title')}</h2>

      {deadline !== null && (
        <p
          className="extraction-deadline"
          data-tone={deadline.daysRemaining < 0 ? 'danger' : deadline.daysRemaining <= 14 ? 'warn' : undefined}
        >
          {deadline.daysRemaining < 0
            ? t('migration.extraction.deadlineExpired', { source, date: deadline.sourceAccessUntil })
            : t('migration.extraction.deadline', { source, n: deadline.daysRemaining })}
          {' '}
          <span className="extraction-verify">{t('migration.extraction.verifyTerms')}</span>
        </p>
      )}

      {completeness.complete ? (
        <p className="extraction-complete" role="status">{t('migration.extraction.complete')}</p>
      ) : null}

      <ul className="extraction-items">
        {guide.items.map((gi) => {
          const rec = byId.get(gi.id);
          const status: Status = (rec?.status ?? 'open') as Status;
          return (
            <li key={gi.id} className="extraction-item" data-attention={status === 'blocked' ? 'true' : undefined}>
              <span className="extraction-item-status">
                <span aria-hidden="true">{STATUS_GLYPH[status]}</span> {t(`migration.extraction.item.${statusKey(status)}`)}
              </span>
              <span className="extraction-item-what">{gi.what}</span>
              <span className="extraction-item-area">{gi.sourceArea}</span>
              <span className="extraction-item-rung">{t(`migration.extraction.rung.${gi.rung}`)}</span>

              {gi.moduleQuestion !== undefined && (
                <span className="extraction-item-question">{gi.moduleQuestion}</span>
              )}

              {gi.rungGated && (
                <span className="extraction-item-gated" role="note">{t('migration.extraction.rungGated')}</span>
              )}

              {rec !== undefined && typeof rec.rowCount === 'number' && (
                <span className="extraction-item-count">{t('migration.extraction.rowCount', { n: rec.rowCount })}</span>
              )}
              {rec !== undefined && rec.dateFrom !== undefined && rec.dateTo !== undefined && (
                <span className="extraction-item-range">{t('migration.extraction.dateRange', { from: rec.dateFrom, to: rec.dateTo })}</span>
              )}
              {rec !== undefined && rec.fileIds.length > 0 && (
                <span className="extraction-item-files">{t('migration.extraction.files', { n: rec.fileIds.length })}</span>
              )}

              {canManageImport && (
                <select
                  className="extraction-item-control"
                  aria-label={gi.what}
                  value={status}
                  onChange={(e) => void setItemStatus(gi.id, e.target.value as Status)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{t(`migration.extraction.item.${statusKey(s)}`)}</option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>

      <div className="extraction-letter">
        <button type="button" onClick={() => setLetterOpen((v) => !v)} aria-expanded={letterOpen}>
          {t('migration.extraction.letter.create')}
        </button>
        {letterOpen && <LetterView locale={guide.letterTemplate['de-CH']} company={company} source={source} />}
      </div>
    </section>
  );
}

/** Render the pre-filled Datenherausgabe letter (de-CH), placeholders replaced from the A00 profile. */
function LetterView(props: {
  locale: GuideLetterLocale;
  company: { name: string; address: string };
  source: string;
}): React.ReactElement {
  const { locale, company, source } = props;
  const fill = (s: string): string =>
    s
      .replaceAll('{company}', company.name || '[Firma]')
      .replaceAll('{address}', company.address || '[Adresse]')
      .replaceAll('{source}', source);
  return (
    <article className="extraction-letter-body">
      <p className="extraction-letter-subject">{fill(locale.subject)}</p>
      {locale.body.map((para, i) => (
        <p key={i}>{fill(para)}</p>
      ))}
      <p className="extraction-letter-limits">{fill(locale.limitsParagraph)}</p>
    </article>
  );
}

/** Engine statuses are snake_case; the catalogue keys are camelCase. */
function statusKey(status: Status): string {
  return status === 'not_used' ? 'notUsed' : status;
}

export default ExtractionChecklist;
