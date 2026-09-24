/**
 * ImportModal, C00's CSV import with its duplicate-review step (spec C00 §6, US-C00.5).
 *
 * The engine takes ALREADY-PARSED rows and does no file I/O: the OSS core never reads a path and
 * never enriches from a network. So the parsing happens here, in the browser, on text the operator
 * pastes or a file they pick, and what crosses the wire is rows.
 *
 * The result is a REVIEW, not a silent success. `duplicates[]` comes back with the candidate ids and
 * is shown as such, because a contact matched on email, UID or name+postcode is exactly the case
 * where auto-merging would create the mess US-C00.4 then has to clean up.
 */
import { useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ErrorBanner } from '../../components/states';
import type { Err } from '../../lib/client';
import { idemKey } from './model';

interface ImportOutcome {
  created: number;
  skipped: number;
  duplicates: { row: number; candidateIds: string[] }[];
}

export interface ImportModalProps {
  workspaceId: string;
  onClose: () => void;
  onImported: () => void;
}

/**
 * Parse pasted CSV into contact rows. The header names the columns, so an export from another package
 * can be pasted as-is once its headers are mapped. Unknown columns are ignored rather than refused: a
 * real export carries more than TILL stores, and refusing the whole file for one extra column would
 * make the feature unusable on real data.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0] as string).map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      const value = (cells[i] ?? '').trim();
      if (value !== '') row[h] = value;
    });
    if (Object.keys(row).length > 0) out.push(row);
  }
  return out;
}

/** Split one CSV line, honouring double-quoted cells that contain a comma. */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Map the parsed CSV columns onto the engine's row shape. */
function toContactRows(parsed: Record<string, string>[]) {
  return parsed.map((r) => {
    const zip = r.plz ?? r.zip ?? '';
    const city = r.ort ?? r.city ?? '';
    const row: Record<string, unknown> = {
      partyRole: r.rolle ?? r.partyrole ?? 'customer',
      name: r.name ?? '',
    };
    if (r.kind !== undefined || r.art !== undefined) row.kind = r.kind ?? r.art;
    if (r.email !== undefined) row.email = r.email;
    if (r.mwst !== undefined || r.vatnumber !== undefined) row.vatNumber = r.mwst ?? r.vatnumber;
    if (zip !== '' || city !== '') row.address = { zip, city };
    return row;
  });
}

export function ImportModal({ workspaceId, onClose, onImported }: ImportModalProps) {
  const t = useT();
  const client = useClient();
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = parseCsv(text);

  async function run() {
    setSaving(true);
    setError(null);
    const resp = await client.call('contacts_import', {
      workspaceId,
      rows: toContactRows(rows),
      idempotencyKey: idemKey('import'),
    });
    setSaving(false);
    if (isErr(resp.body)) {
      setError(resp.body);
      return;
    }
    const body = resp.body as unknown as ImportOutcome;
    setOutcome({
      created: body.created ?? 0,
      skipped: body.skipped ?? 0,
      duplicates: Array.isArray(body.duplicates) ? body.duplicates : [],
    });
    onImported();
  }

  const footer = (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        {outcome === null ? t('contact.cancel') : t('contact.close')}
      </button>
      {outcome === null && (
        <>
          <button
            type="button"
            className="btn btn--primary"
            disabled={saving || rows.length === 0}
            onClick={() => void run()}
          >
            {t('contact.import.action')}
          </button>
          {/* D15: a disabled primary action names what is missing rather than sitting dead. */}
          {rows.length === 0 && <span className="ct-field-hint">{t('contact.import.emptyHint')}</span>}
        </>
      )}
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t('contact.action.import')}
      closeLabel={t('contact.close')}
      footer={footer}
    >
      <div className="ct-import-body">
        {error !== null && <ErrorBanner error={error} />}

        {outcome === null ? (
            <>
              <label className="ct-field-inner">
                <span className="ct-field-label">{t('contact.import.paste')}</span>
                <textarea
                  className="field ct-textarea"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <span className="ct-field-hint">{t('contact.import.hint')}</span>
              {/* The parse happens before the call, so the count is honest about what WOULD be sent. */}
              {rows.length > 0 && (
                <p className="ct-field-hint">{t('contact.import.parsed', { n: String(rows.length) })}</p>
              )}
            </>
          ) : (
            // The review step: what landed, what was held back, and why.
            <div className="ct-import-review">
              <p>{t('contact.import.created', { n: String(outcome.created) })}</p>
              {outcome.duplicates.length > 0 ? (
                <>
                  <p className="ct-warn-text">
                    {t('contact.import.duplicates', { n: String(outcome.duplicates.length) })}
                  </p>
                  <ul className="ct-people">
                    {outcome.duplicates.map((d) => (
                      <li key={d.row}>{t('contact.import.duplicateRow', { row: String(d.row + 1) })}</li>
                    ))}
                  </ul>
                  <p className="ct-field-hint">{t('contact.import.duplicatesHint')}</p>
                </>
              ) : (
                <p className="ct-field-hint">{t('contact.import.noDuplicates')}</p>
              )}
            </div>
          )}
      </div>
    </Modal>
  );
}
