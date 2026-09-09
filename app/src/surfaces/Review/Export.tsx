/**
 * A25 US-A25.4, Export (`/export`): the Treuhänder's filing exports for one period.
 *
 * IA is decision D115 (1a + 3a): Export is Review's sibling screen with its OWN period (a year-journal
 * export for the tax return must not force a period list), and it is THREE independent artifact rows,
 * journal / statements / MWST, each with its OWN format control because the formats genuinely differ
 * (journal CSV, statements PDF or CSV, MWST CSV). One global toggle would misdescribe two of the three
 * files.
 *
 * THE MWST ROW IS A WORKING PAPER, AND SAYS SO. `export_vat` is the per-Ziffer CSV a Treuhänder lays
 * beside the annual accounts; it is NOT the ESTV ePortal upload file (that is A07's own
 * `vat_export_ech0217`). The row states this so the claim is never overstated.
 *
 * Every export is a READ that produces a downloadable artifact (Pattern OP4); nothing is transmitted.
 * An empty period is a NOTICE, not a failure: the engine returns a header-only file and `empty: true`,
 * so the row saves the file and says the period had no movements.
 */
import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { NoWorkspaceState, PermissionDenied } from '../../components/states';
import { ActionFeedback } from '../../components/ActionFeedback';
import { useCan, CAP } from '../../lib/capabilities';
import { PeriodField } from './PeriodField';
import { DownloadGlyph } from './glyphs';
import {
  currentMonth,
  currentYear,
  parseArtifactPair,
  parseSingleArtifact,
  periodValue,
  saveArtifact,
  type ExportResult,
  type Granularity,
} from './model';
import './Review.css';

type Format = 'csv' | 'pdf';
type RowOutcome =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; empty: boolean }
  | { kind: 'needsVatConfig' }
  | { kind: 'error' };

interface ExportRowProps {
  titleKey: string;
  descKey: string;
  /** The extra honesty line (the MWST working-paper pointer), or null. */
  noteKey?: string;
  action: 'export_journal' | 'export_statements' | 'export_vat';
  formats: readonly Format[];
  /** `export_statements` answers one artifact per statement; the others answer a single artifact. */
  pair: boolean;
  workspaceId: string;
  period: string;
  /** MWST alone can come back `needs_vat_config`, which is a CTA into A07, not a plain failure. */
  vatConfig: boolean;
}

function ExportRow({
  titleKey,
  descKey,
  noteKey,
  action,
  formats,
  pair,
  workspaceId,
  period,
  vatConfig,
}: ExportRowProps) {
  const t = useT();
  const client = useClient();
  const [format, setFormat] = useState<Format>(formats[0] as Format);
  const [outcome, setOutcome] = useState<RowOutcome>({ kind: 'idle' });

  const run = useCallback(async () => {
    setOutcome({ kind: 'working' });
    const { body } = await client.call(action, { workspaceId, period, format });
    if (isErr(body)) {
      if (vatConfig && body.error === 'needs_vat_config') setOutcome({ kind: 'needsVatConfig' });
      else setOutcome({ kind: 'error' });
      return;
    }
    const result: ExportResult | null = pair ? parseArtifactPair(body) : parseSingleArtifact(body);
    if (result === null) {
      setOutcome({ kind: 'error' });
      return;
    }
    for (const artifact of result.artifacts) saveArtifact(artifact);
    setOutcome({ kind: 'done', empty: result.empty });
  }, [client, action, workspaceId, period, format, pair, vatConfig]);

  const working = outcome.kind === 'working';

  return (
    <div className="ex-row panel">
      <div className="ex-row-main">
        <h2 className="ex-row-title">{t(titleKey)}</h2>
        <p className="ex-row-desc">{t(descKey)}</p>
        {noteKey !== undefined && <p className="ex-row-note">{t(noteKey)}</p>}
      </div>

      <div className="ex-row-controls">
        {formats.length > 1 ? (
          <div className="rv-period-toggle" role="radiogroup" aria-label={t('export.formatLabel')}>
            {formats.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                className={`rv-seg ${format === f ? 'rv-seg--on' : ''}`}
                onClick={() => setFormat(f)}
              >
                {t(`export.format.${f}`)}
              </button>
            ))}
          </div>
        ) : (
          <span className="ex-format-static">{t(`export.format.${formats[0]}`)}</span>
        )}
        <button
          type="button"
          className="btn btn--secondary rv-action ex-download"
          disabled={working}
          onClick={() => void run()}
        >
          <DownloadGlyph size={16} aria-hidden="true" />
          {working ? t('export.working') : t('export.download')}
        </button>
      </div>

      {outcome.kind === 'done' && outcome.empty && (
        <ActionFeedback tone="info" role="note" message={t('export.empty')} />
      )}
      {outcome.kind === 'needsVatConfig' && (
        <ActionFeedback tone="error" message={t('export.needsVatConfig')}>
          <Link className="btn btn--secondary btn--sm ex-notice-cta" to="/vat">
            {t('export.needsVatConfigCta')}
          </Link>
        </ActionFeedback>
      )}
      {outcome.kind === 'error' && (
        <ActionFeedback tone="error" message={t('export.error')}>
          <button type="button" className="btn btn--secondary btn--sm ex-notice-cta" onClick={() => void run()}>
            {t('export.retry')}
          </button>
        </ActionFeedback>
      )}
    </div>
  );
}

export function Export() {
  const t = useT();
  const workspaceId = useWorkspaceId();
  const canExport = useCan(CAP.export);

  // D115 bridged the one lost click after locking with a link straight to Export, and F-07 (J4.3)
  // makes that link carry the period: `/export?period=YYYY-MM` (or `YYYY`) opens on the period just
  // locked instead of the current month, so nothing is typed a second time.
  const [params] = useSearchParams();
  const linked = params.get('period');
  const linkedMonth = linked !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(linked) ? linked : null;
  const linkedYear = linked !== null && /^\d{4}$/.test(linked) ? linked : null;
  const [granularity, setGranularity] = useState<Granularity>(linkedYear !== null ? 'year' : 'month');
  const [month, setMonth] = useState(linkedMonth ?? currentMonth());
  const [year, setYear] = useState(linkedYear ?? currentYear());
  const period = periodValue(granularity, month, year);

  if (workspaceId === null) return <NoWorkspaceState />;

  if (!canExport) {
    return (
      <section className="rv" aria-labelledby="export-title">
        <SurfaceHeader
          title={t('export.title')}
          titleId="export-title"
          help={<SurfaceHelp surface="Export" />}
        />
        <PermissionDenied body={t('export.permission')} />
      </section>
    );
  }

  return (
    <section className="rv" aria-labelledby="export-title">
      <SurfaceHeader
        title={t('export.title')}
        titleId="export-title"
        subtitle={t('export.subtitle')}
        help={<SurfaceHelp surface="Export" />}
        actions={
          <PeriodField
            granularity={granularity}
            month={month}
            year={year}
            onGranularity={setGranularity}
            onMonth={setMonth}
            onYear={setYear}
          />
        }
      />

      <div className="ex-rows">
        <ExportRow
          titleKey="export.journal"
          descKey="export.journalDesc"
          action="export_journal"
          formats={['csv']}
          pair={false}
          workspaceId={workspaceId}
          period={period}
          vatConfig={false}
        />
        <ExportRow
          titleKey="export.statements"
          descKey="export.statementsDesc"
          action="export_statements"
          formats={['pdf', 'csv']}
          pair
          workspaceId={workspaceId}
          period={period}
          vatConfig={false}
        />
        <ExportRow
          titleKey="export.vat"
          descKey="export.vatDesc"
          noteKey="export.vatWorkingPaper"
          action="export_vat"
          formats={['csv']}
          pair={false}
          workspaceId={workspaceId}
          period={period}
          vatConfig
        />
      </div>
    </section>
  );
}

export default Export;
