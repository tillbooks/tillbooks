/**
 * R-S8, the export: this surface's single primary action, and the one legitimate spinner in A08.
 *
 * WHY A PURE-READ SURFACE GETS A PRIMARY ACTION AT ALL, when the A16/A19 slice ruled that one should
 * not. Because the export is a real act with a real artifact, and it is the reason this screen exists
 * at close time. A16's surface answers a question the operator then acts on somewhere else; A08's
 * surface produces a document the operator hands to someone. `export_statement` is `kind: 'read'` in
 * the registry because it mutates nothing, but from the operator's side it is the one thing here that
 * produces something they keep. DESIGN.md's rule is "one obvious primary action per surface", and
 * here there genuinely is one.
 *
 * ONE CLICK, NOT A MENU. PDF is the button because it is the artifact you hand to a Treuhänder or a
 * bank; CSV sits in the overflow because re-import is the specialist case. A menu would make the
 * common case two clicks to buy the rare case one.
 *
 * THE ENGINE WRITES NO FILE. `exportStatement` returns the bytes base64-encoded inside the response,
 * so the browser decodes them into a Blob with the ENGINE's `mediaType` and saves them under the
 * ENGINE's `filename` (`saldenbilanz-2026-01-01-bis-2026-03-31.pdf`, ISO throughout and deliberately
 * not a de-CH display date). A surface that built its own filename would produce two naming schemes
 * for one artifact.
 *
 * THE EXPORT FORWARDS THE EXACT PARAMETERS THE SCREEN USED, `compareTo` included (R32). `modelFor`
 * re-runs the same four verbs, and the toolbar state is the single source: there is no second
 * parameter set anywhere in this surface. That is what makes "the file and the screen cannot
 * disagree" true in the GUI as well as in the engine.
 *
 * `kind: 'ledger'` NEEDS AN `accountId`, so on the Kontoblatt tab with no account chosen the control
 * is DISABLED with the reason inline beside it, never as a hover-only tooltip (D15/C3). Prevented at
 * the control, not at validation: the engine's refusal is unreachable from here.
 *
 * A FAILED EXPORT RENDERS WHERE THE OPERATOR CLICKED, with a retry, and is NOT a toast. A toast that
 * vanishes is how an operator comes to believe they have a file they do not have. A SUCCESSFUL one
 * gets no confirmation at all: the file arriving is the feedback, per DESIGN.md.
 *
 * WHAT THIS NEVER CLAIMS ABOUT THE ARTIFACT. Not archival, not complete, not signed. One quiet line
 * says the PDF is a print file with no PDF/A profile, because `pdfaProfile: null` is the engine's own
 * honesty and dropping it here would be the Studio making a claim the engine refused to make. The
 * words "revisionssicher" and "archivierungssicher" appear nowhere.
 *
 * AN EXPORT IS NOT BLOCKED WHEN A CHECK FAILS. `exportStatement` copies the model's verdict onto the
 * artifact and the PDF prints "Abstimmung: NICHT erfüllt" as its last line, so exporting a statement
 * that does not reconcile is a legitimate act: you send it to the person who can explain it, and the
 * file says so itself. Blocking it would be the GUI overruling the engine's own design.
 */
import { useCallback, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { OverflowMenu } from '../../components/OverflowMenu';
import { artifactBlob, parseArtifact } from './model';

export interface ExportActionProps {
  /** Everything `export_statement` needs except `format`: kind plus that statement's own parameters. */
  params: Record<string, unknown>;
  /** The inline sentence explaining why the control is off, or null when it is live (R30). */
  blockedReason: string | null;
}

/** Hand the bytes to the browser under the engine's own filename. */
function save(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ExportAction({ params, blockedReason }: ExportActionProps) {
  const t = useT();
  const client = useClient();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = useCallback(
    async (format: 'pdf' | 'csv') => {
      setWorking(true);
      setFailed(false);
      const response = await client.call('export_statement', { ...params, format });
      if (isErr(response.body)) {
        setFailed(true);
        setWorking(false);
        return;
      }
      const artifact = parseArtifact(response.body);
      if (artifact === null) {
        setFailed(true);
        setWorking(false);
        return;
      }
      save(artifact.filename, artifactBlob(artifact));
      setWorking(false);
    },
    [client, params],
  );

  const blocked = blockedReason !== null;

  return (
    <div className="rp-export">
      <div className="rp-export-controls">
        <OverflowMenu
          label={t('reports.headerActions')}
          disabled={blocked || working}
          items={[
            {
              key: 'csv',
              label: t('reports.export.csv'),
              onSelect: () => {
                void run('csv');
              },
            },
          ]}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={blocked || working}
          onClick={() => {
            void run('pdf');
          }}
        >
          {working ? t('reports.export.working') : t('reports.export.pdf')}
        </button>
      </div>

      {/* Inline, beside the control, never a hover-only tooltip (D15/C3). */}
      {blocked && <p className="rp-export-note">{blockedReason}</p>}
      <p className="rp-export-note">{t('reports.export.notArchival')}</p>

      {failed && (
        <p className="rp-export-error" role="alert">
          <span>{t('reports.error.export')}</span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              void run('pdf');
            }}
          >
            {t('reports.error.exportRetry')}
          </button>
        </p>
      )}
    </div>
  );
}
