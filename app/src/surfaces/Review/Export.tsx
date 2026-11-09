/**
 * A25 US-A25.4, Export (`/export`): the Treuhänder's filing exports.
 *
 * IA is decision D115 (1a + 3a): Export is Review's sibling screen with its OWN dates (a year-journal
 * export for the tax return must not force a period list), and it offers THREE independent artifacts,
 * journal / statements / MWST, each with its OWN format because the formats genuinely differ (journal
 * CSV, statements PDF or CSV, MWST CSV).
 *
 * D190 (the owner's ask, 09.11.2026: "from and to plus additional filters"): the journal and the
 * statements take a Von/Bis range with quick picks (Monat, Quartal, Jahr); the journal adds its filters
 * (Konto as a small field, Quelle as a chip under "+ Filter"). MWST keeps its fixed periods (MWSTG
 * Art. 35), so it shows the MWST period picker instead of the range. A filtered journal is a labelled
 * extract: the engine writes the filters into the file and its name, so the page does not repeat it.
 * `/export?period=YYYY-MM` (or `YYYY`) still opens on that month (or year), the range prefilled.
 *
 * THE MWST ROW IS A WORKING PAPER, AND SAYS SO. `export_vat` is the per-Ziffer CSV a Treuhänder lays
 * beside the annual accounts; it is NOT the ESTV ePortal upload file (that is A07's own
 * `vat_export_ech0217`). The page states this so the claim is never overstated.
 *
 * Every export is a READ that produces a downloadable artifact (Pattern OP4); nothing is transmitted.
 * An empty period is a NOTICE, not a failure: the engine returns a header-only file and `empty: true`,
 * so the page saves the file and says the period had no movements.
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
import { Segmented } from '../../components/Segmented';
import { FilterBar } from '../../components/FilterBar';
import { useCan, CAP } from '../../lib/capabilities';
import { RangeField, VatPeriodField } from './PeriodField';
import { DownloadGlyph } from './glyphs';
import {
  EXPORT_SOURCES,
  currentMonth,
  halfOf,
  parseArtifactPair,
  parseSingleArtifact,
  quarterOf,
  rangeFromLink,
  saveArtifact,
  vatPeriodValue,
  type DateRange,
  type ExportResult,
  type VatGranularity,
  type VatPeriodParts,
} from './model';
import './Review.css';
import './Export.css';

type Format = 'csv' | 'pdf';
type Kind = 'journal' | 'statements' | 'vat';
type RowOutcome =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; empty: boolean; notice: string | null }
  | { kind: 'needsVatConfig' }
  | { kind: 'badRange' }
  | { kind: 'unknownAccount'; account: string }
  | { kind: 'error' };

interface ExportKind {
  titleKey: string;
  descKey: string;
  /** The extra honesty line (the MWST working-paper pointer), or undefined. */
  noteKey?: string;
  action: 'export_journal' | 'export_statements' | 'export_vat';
  formats: readonly Format[];
  /** `export_statements` answers one artifact per statement; the others answer a single artifact. */
  pair: boolean;
  /** MWST alone can come back `needs_vat_config`, which is a CTA into A07, not a plain failure. */
  vatConfig: boolean;
}

const KINDS: Record<Kind, ExportKind> = {
  journal: { titleKey: 'export.journal', descKey: 'export.journalDesc', action: 'export_journal', formats: ['csv'], pair: false, vatConfig: false },
  statements: { titleKey: 'export.statements', descKey: 'export.statementsDesc', action: 'export_statements', formats: ['pdf', 'csv'], pair: true, vatConfig: false },
  vat: {
    titleKey: 'export.vat',
    descKey: 'export.vatDesc',
    noteKey: 'export.vatWorkingPaper',
    action: 'export_vat',
    formats: ['csv'],
    pair: false,
    vatConfig: true,
  },
};

const KIND_ORDER: readonly Kind[] = ['journal', 'statements', 'vat'];

/** The engine's named range refusals (D190): the page says "check Von and Bis", whichever it was. */
const RANGE_ERRORS: ReadonlySet<string> = new Set([
  'period_or_range_required',
  'period_and_range_conflict',
  'range_incomplete',
  'range_inverted',
]);

/** The MWST picker's start: the linked month or year, else the current quarter. */
function vatStart(linked: string | null): { granularity: VatGranularity; parts: VatPeriodParts } {
  const month = linked !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(linked) ? linked : null;
  const year = linked !== null && /^\d{4}$/.test(linked) ? linked : null;
  const anchor = month ?? currentMonth();
  const parts: VatPeriodParts = {
    year: year ?? anchor.slice(0, 4),
    quarter: quarterOf(anchor),
    half: halfOf(anchor),
    month: anchor,
  };
  return { granularity: month !== null ? 'month' : year !== null ? 'year' : 'quarter', parts };
}

export function Export() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const canExport = useCan(CAP.export);

  // D115 bridged the one lost click after locking with a link straight to Export, and F-07 (J4.3)
  // makes that link carry the period: `/export?period=YYYY-MM` (or `YYYY`) opens on the period just
  // locked instead of the current month, so nothing is typed a second time. D190: it prefills Von/Bis.
  const [params] = useSearchParams();
  const linked = params.get('period');
  const [range, setRange] = useState<DateRange>(() => rangeFromLink(linked));
  const [vatGranularity, setVatGranularity] = useState<VatGranularity>(() => vatStart(linked).granularity);
  const [vatParts, setVatParts] = useState<VatPeriodParts>(() => vatStart(linked).parts);
  const [account, setAccount] = useState('');
  const [source, setSource] = useState<string | null>(null);

  // D187 (the owner's pick "Berichte A"): one bar on top (what, which format, the one action), the
  // dates under it, and the chosen export described beneath. It replaces a panel per export.
  const [kind, setKind] = useState<Kind>('journal');
  const spec = KINDS[kind];
  const [format, setFormat] = useState<Format>(spec.formats[0] as Format);
  const [outcome, setOutcome] = useState<RowOutcome>({ kind: 'idle' });

  const pick = (next: Kind) => {
    setKind(next);
    setFormat(KINDS[next].formats[0] as Format);
    setOutcome({ kind: 'idle' });
  };

  const run = useCallback(async () => {
    if (workspaceId === null) return;
    setOutcome({ kind: 'working' });
    const trimmedAccount = account.trim();
    const input: Record<string, unknown> =
      kind === 'vat'
        ? { workspaceId, period: vatPeriodValue(vatGranularity, vatParts), format }
        : {
            workspaceId,
            from: range.from,
            to: range.to,
            format,
            ...(kind === 'journal' && trimmedAccount !== '' ? { account: trimmedAccount } : {}),
            ...(kind === 'journal' && source !== null ? { source } : {}),
          };
    const { body } = await client.call(spec.action, input);
    if (isErr(body)) {
      if (spec.vatConfig && body.error === 'needs_vat_config') setOutcome({ kind: 'needsVatConfig' });
      else if (RANGE_ERRORS.has(body.error) || (body.error === 'invalid_input' && (body.field === 'from' || body.field === 'to'))) {
        setOutcome({ kind: 'badRange' });
      } else if (body.error === 'unknown_account') setOutcome({ kind: 'unknownAccount', account: trimmedAccount });
      else setOutcome({ kind: 'error' });
      return;
    }
    const result: ExportResult | null = spec.pair ? parseArtifactPair(body) : parseSingleArtifact(body);
    if (result === null) {
      setOutcome({ kind: 'error' });
      return;
    }
    for (const artifact of result.artifacts) saveArtifact(artifact);
    setOutcome({ kind: 'done', empty: result.empty, notice: result.notice });
  }, [client, spec, kind, workspaceId, range, vatGranularity, vatParts, account, source, format]);

  if (workspaceId === null) return <NoWorkspaceState />;

  if (!canExport) {
    return (
      <section className="rv" aria-labelledby="export-title">
        <SurfaceHeader title={t('export.title')} titleId="export-title" help={<SurfaceHelp surface="Export" />} />
        <PermissionDenied body={t('export.permission')} />
      </section>
    );
  }

  const working = outcome.kind === 'working';
  const emptyMessage =
    outcome.kind === 'done' && outcome.empty
      ? t(outcome.notice === 'empty_extract' ? 'export.emptyExtract' : 'export.empty')
      : null;

  return (
    <section className="rv ex" aria-labelledby="export-title">
      <SurfaceHeader
        title={t('export.title')}
        titleId="export-title"
        help={<SurfaceHelp surface="Export" />}
        actions={
          <>
            {spec.formats.length > 1 ? (
              // K-11: one of a few sibling formats is the shared Segmented, never a bespoke toggle.
              <Segmented
                label={t('export.formatLabel')}
                options={spec.formats.map((f) => ({ value: f, label: t(`export.format.${f}`) }))}
                value={format}
                onChange={setFormat}
              />
            ) : (
              <span className="ex-format-static">{t(`export.format.${spec.formats[0]}`)}</span>
            )}
            <button type="button" className="btn btn--primary ex-download" disabled={working} onClick={() => void run()}>
              <DownloadGlyph size={16} aria-hidden="true" />
              {working ? t('export.working') : t('export.download')}
            </button>
          </>
        }
        toolbar={
          <>
            <Segmented
              label={t('export.kindLabel')}
              options={KIND_ORDER.map((k) => ({ value: k, label: t(KINDS[k].titleKey) }))}
              value={kind}
              onChange={pick}
            />
            {kind === 'vat' ? (
              <VatPeriodField
                granularity={vatGranularity}
                parts={vatParts}
                onGranularity={setVatGranularity}
                onParts={setVatParts}
              />
            ) : (
              <RangeField range={range} onRange={setRange} />
            )}
            {kind === 'journal' && (
              // D187 list pattern: the account is a small field (a chart has too many accounts for a
              // menu), the source a chip under "+ Filter". The engine writes both into the file.
              <FilterBar
                searchValue={account}
                onSearchChange={setAccount}
                searchLabel={t('export.filter.account')}
                searchPlaceholder={t('export.filter.accountPlaceholder')}
                onClear={() => {
                  setAccount('');
                  setSource(null);
                }}
                clearLabel={t('export.filter.clear')}
                facets={[
                  {
                    key: 'source',
                    label: t('export.filter.source'),
                    options: EXPORT_SOURCES.map((s) => ({ value: s, label: t(`journal.source.${s}`) })),
                    value: source,
                    onChange: setSource,
                  },
                ]}
              />
            )}
          </>
        }
      />

      <div className="ex-doc" aria-live="polite">
        <h2 className="ex-doc-title">{t(spec.titleKey)}</h2>
        <p className="ex-doc-desc">{t(spec.descKey)}</p>
        {/* The honesty line stays on the page (the money critic's rule): what this file is, and is not. */}
        {spec.noteKey !== undefined && <p className="ex-doc-note">{t(spec.noteKey)}</p>}

        {emptyMessage !== null && <ActionFeedback tone="info" role="note" message={emptyMessage} />}
        {outcome.kind === 'done' && outcome.notice === 'range_not_whole_months' && (
          <ActionFeedback tone="info" role="note" message={t('export.notWholeMonths')} />
        )}
        {outcome.kind === 'needsVatConfig' && (
          <ActionFeedback tone="error" message={t('export.needsVatConfig')}>
            <Link className="btn btn--secondary btn--sm ex-notice-cta" to="/vat">
              {t('export.needsVatConfigCta')}
            </Link>
          </ActionFeedback>
        )}
        {outcome.kind === 'badRange' && <ActionFeedback tone="error" message={t('export.badRange')} />}
        {outcome.kind === 'unknownAccount' && (
          <ActionFeedback tone="error" message={t('export.unknownAccount', { account: outcome.account })} />
        )}
        {outcome.kind === 'error' && (
          <ActionFeedback tone="error" message={t('export.error')}>
            <button type="button" className="btn btn--secondary btn--sm ex-notice-cta" onClick={() => void run()}>
              {t('export.retry')}
            </button>
          </ActionFeedback>
        )}
      </div>
    </section>
  );
}

export default Export;
