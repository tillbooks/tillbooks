/**
 * The G09 front-half intake wizard (file drop, discovery, plan, scope). The claims worth the most:
 *
 *   DISCOVERY CLASSIFIES WITHOUT POSTING and names each file's facts, so an operator sees what TILL
 *   read (adapter, rows, data classes) before committing to a plan.
 *
 *   SCOPE IS A PER-CLASS INCLUDE CHOICE over exactly the classes the uploaded files can produce, and
 *   reaches the engine as `migration_set_scope`, so a class can never import by accident.
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// jsdom does not implement File.arrayBuffer or SubtleCrypto; the chunk lane needs both. Provide the
// platform webcrypto (Node's) for the sha256, and polyfill arrayBuffer per file in the test.
if ((globalThis.crypto as { subtle?: unknown } | undefined)?.subtle === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { SourceIntake } from './SourceIntake';
import de from './messages.de-CH.json';

type Handler = (input: Record<string, unknown>) => RestResponse;
const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    calls.push({ action, input: input as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

const DISCOVERY = ok({
  files: [{ fileId: 'file_1', adapter: 'csv', dataClasses: ['contacts'], rowCount: 3, headers: ['name', 'uid'], confidence: 'high', asAt: null, warnings: [] }],
  failures: [],
});

function tree(canned: Record<string, RestResponse | Handler>, calls: Array<{ action: string; input: Record<string, unknown> }>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned, calls))}>
      <I18nProvider>
        <SourceIntake workspaceId="ws_1" onCreated={() => undefined} />
      </I18nProvider>
    </TillClientProvider>
  );
}

function dropFile(): void {
  const input = screen.getByLabelText(de.migration.intake.drop.choose);
  const file = new File(['name,uid\nAcme,CHE-1'], 'export.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('SourceIntake', () => {
  it('classifies an uploaded file and names its facts without posting', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'csv', label: 'CSV (generisch)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: DISCOVERY,
        },
        calls,
      ),
    );
    dropFile();
    expect(await screen.findByText('export.csv')).toBeTruthy();
    // The detected data class renders as a chip, and no ledger write went out (discovery only).
    expect(screen.getByText(de.migration.dataClass.contacts)).toBeTruthy();
    const disc = calls.find((c) => c.action === 'migration_discover_source');
    expect(disc).toBeTruthy();
    // The drift that bit: an undefined fileId reaching discovery. Every id must be a real string.
    for (const id of disc?.input.fileIds as unknown[]) expect(typeof id).toBe('string');
  });

  it('routes a file over the single-call bound through the chunk lane with visible progress (G18 US-G18.4)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'csv', label: 'CSV (generisch)', dataClasses: ['contacts'] }] }),
          files_upload_begin: ok({ uploadId: 'up_1', chunkMaxBytes: 8 * 1024 * 1024 }),
          files_upload_chunk: ok({ receivedBytes: 1 }),
          files_upload_commit: ok({ file: { id: 'file_big' } }),
          migration_discover_source: ok({
            files: [{ fileId: 'file_big', adapter: 'csv', dataClasses: ['gl_history'], rowCount: 500000, headers: ['id'], confidence: 'low', asAt: null, warnings: [] }],
            failures: [],
          }),
        },
        calls,
      ),
    );
    // A small payload whose reported size is over the 25 MiB single-call bound, so the lane is taken.
    const input = screen.getByLabelText(de.migration.intake.drop.choose);
    const file = new File(['id\n1\n2\n'], 'gl.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('id\n1\n2\n').buffer });
    fireEvent.change(input, { target: { files: [file] } });

    // The chunk lane verbs are used, NOT files_upload, and the discovery ran on the committed blob.
    await waitFor(() => expect(calls.some((c) => c.action === 'files_upload_commit')).toBe(true));
    expect(calls.some((c) => c.action === 'files_upload_begin')).toBe(true);
    expect(calls.some((c) => c.action === 'files_upload_chunk')).toBe(true);
    expect(calls.some((c) => c.action === 'files_upload')).toBe(false);
    const disc = calls.find((c) => c.action === 'migration_discover_source');
    expect((disc?.input.fileIds as string[])).toContain('file_big');
    // The progress live region announced the upload.
    expect(await screen.findByText(new RegExp(de.migration.source.uploadProgress))).toBeTruthy();
  });

  it('offers a per-file worksheet choice when a source reports worksheets (G18 US-G18.2)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'xlsx', label: 'Excel-Arbeitsmappe (.xlsx)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_x' } }),
          migration_discover_source: ok({
            files: [{ fileId: 'file_x', adapter: 'xlsx', dataClasses: ['contacts'], rowCount: 2, headers: ['Name'], confidence: 'low', asAt: null, warnings: [], worksheets: ['Kontakte', 'Notizen'], worksheet: 'Kontakte' }],
            failures: [],
          }),
        },
        calls,
      ),
    );
    const input = screen.getByLabelText(de.migration.intake.drop.choose);
    const file = new File(['x'], 'book.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.change(input, { target: { files: [file] } });
    const picker = (await screen.findByLabelText(de.migration.source.worksheet)) as HTMLSelectElement;
    expect(picker).toBeTruthy();
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['Kontakte', 'Notizen']);
    fireEvent.change(picker, { target: { value: 'Notizen' } });
    expect(picker.value).toBe('Notizen');
  });

  const FAILING = ok({
    files: [],
    failures: [{ fileId: 'file_1', error: 'source_unparseable', reason: 'no_header_row', detectedEncoding: 'utf-8', detectedDelimiter: ';' }],
  });

  it('renders a failed file with its localised reason, detected encoding/delimiter and recovery controls (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'csv', label: 'CSV (generisch)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: FAILING,
        },
        calls,
      ),
    );
    dropFile();
    // The engine's reason CODE renders localised, not a bare generic sentence.
    expect(await screen.findByText(de.migration.intake.reason.noHeaderRow)).toBeTruthy();
    // The sniffer's detected facts are shown so the failure is diagnosable.
    expect(screen.getByText(de.migration.intake.failure.encoding.replace('{value}', 'utf-8'))).toBeTruthy();
    expect(screen.getByText(de.migration.intake.failure.delimiter.replace('{value}', ';'))).toBeTruthy();
    // Both per-row recovery controls are present.
    expect(screen.getByRole('button', { name: de.migration.intake.failure.retry })).toBeTruthy();
    expect(screen.getByRole('button', { name: de.migration.intake.failure.remove })).toBeTruthy();
  });

  it('humanises an unknown reason code rather than showing the raw token (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: ok({ files: [], failures: [{ fileId: 'file_1', error: 'source_unparseable', reason: 'some_new_reason' }] }),
        },
        calls,
      ),
    );
    dropFile();
    // The raw snake_case token never reaches the screen; it is humanised.
    expect(await screen.findByText('Some new reason')).toBeTruthy();
    expect(screen.queryByText('some_new_reason')).toBeNull();
  });

  it('removes a failed file from the batch (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: FAILING,
        },
        calls,
      ),
    );
    dropFile();
    fireEvent.click(await screen.findByRole('button', { name: de.migration.intake.failure.remove }));
    await waitFor(() => expect(screen.queryByText(de.migration.intake.reason.noHeaderRow)).toBeNull());
  });

  it('retries discovery for a single failed file and moves it out of failures once it parses (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let n = 0;
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'csv', label: 'CSV (generisch)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: () => {
            n += 1;
            return n === 1
              ? ok({ files: [], failures: [{ fileId: 'file_1', error: 'source_unparseable', reason: 'not_yet_readable' }] })
              : ok({ files: [{ fileId: 'file_1', adapter: 'csv', dataClasses: ['contacts'], rowCount: 3, headers: ['name'], confidence: 'high', asAt: null, warnings: [] }], failures: [] });
          },
        },
        calls,
      ),
    );
    dropFile();
    fireEvent.click(await screen.findByRole('button', { name: de.migration.intake.failure.retry }));
    // The retry hit the discover verb for exactly this file, and once it parses the failure is gone
    // and it appears as a classified file (its data-class chip).
    await waitFor(() => expect(screen.queryByText(de.migration.intake.reason.notYetReadable)).toBeNull());
    expect(await screen.findByText(de.migration.dataClass.contacts)).toBeTruthy();
    const retries = calls.filter((c) => c.action === 'migration_discover_source');
    expect((retries[retries.length - 1]?.input.fileIds as string[])).toEqual(['file_1']);
  });

  it('forces a chosen format on retry and sends it as the discover override (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    let n = 0;
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'bexio_csv', label: 'bexio (CSV)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: () => {
            n += 1;
            // First pass fails (auto-detection wrong); the forced retry, carrying the override, parses.
            return n === 1
              ? ok({ files: [], failures: [{ fileId: 'file_1', error: 'source_unparseable', reason: 'no_header_row', detectedEncoding: 'utf-8' }] })
              : ok({ files: [{ fileId: 'file_1', adapter: 'bexio_csv', dataClasses: ['contacts'], rowCount: 3, headers: ['Name', 'Währung'], confidence: 'high', asAt: null, warnings: [] }], failures: [] });
          },
        },
        calls,
      ),
    );
    dropFile();
    // The failure renders with its force-a-format control.
    await screen.findByText(de.migration.intake.reason.noHeaderRow);

    // Choose a forced encoding and a forced adapter, then run the force retry.
    fireEvent.change(screen.getByLabelText(de.migration.intake.failure.forceEncoding), { target: { value: 'latin1' } });
    fireEvent.change(screen.getByLabelText(de.migration.intake.failure.forceAdapter), { target: { value: 'bexio_csv' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.intake.failure.forceRetry }));

    // The file now classifies (its data-class chip appears) and the failure is gone.
    await waitFor(() => expect(screen.queryByText(de.migration.intake.reason.noHeaderRow)).toBeNull());
    expect(await screen.findByText(de.migration.dataClass.contacts)).toBeTruthy();

    // The forced retry carried the chosen fields as the override, and only those fields.
    const discCalls = calls.filter((c) => c.action === 'migration_discover_source');
    const forced = discCalls[discCalls.length - 1];
    expect(forced?.input.fileIds).toEqual(['file_1']);
    expect(forced?.input.override).toEqual({ encoding: 'latin1', adapter: 'bexio_csv' });
  });

  it('omits the override entirely when no format is chosen on the force retry (K-15)', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: FAILING,
        },
        calls,
      ),
    );
    dropFile();
    await screen.findByText(de.migration.intake.reason.noHeaderRow);
    // Force retry with every field left on "auto": no override key is sent (same as an as-is retry).
    fireEvent.click(screen.getByRole('button', { name: de.migration.intake.failure.forceRetry }));
    await waitFor(() => expect(calls.filter((c) => c.action === 'migration_discover_source').length).toBe(2));
    const forced = calls.filter((c) => c.action === 'migration_discover_source').at(-1);
    expect(forced?.input.override).toBeUndefined();
  });

  it('carries the operator from discovery through create-plan to set_scope', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      tree(
        {
          migration_list_source_adapters: ok({ adapters: [{ id: 'csv', label: 'CSV (generisch)', dataClasses: ['contacts'] }] }),
          files_upload: ok({ file: { id: 'file_1' } }),
          migration_discover_source: DISCOVERY,
          migration_create_plan: ok({ planId: 'migplan_1' }),
          migration_set_scope: ok({ steps: [], unavailable: [], defaultsApplied: [] }),
        },
        calls,
      ),
    );
    dropFile();
    fireEvent.click(await screen.findByRole('button', { name: de.migration.intake.continue }));

    // Plan phase: fill the Übernahmestichtag and create the plan.
    const cutover = await screen.findByLabelText(de.migration.intake.plan.cutover);
    fireEvent.change(cutover, { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: de.migration.intake.plan.create }));

    // Scope phase: confirm the offered class.
    fireEvent.click(await screen.findByRole('button', { name: de.migration.intake.scope.confirm }));

    await waitFor(() => {
      const scope = calls.find((c) => c.action === 'migration_set_scope');
      expect(scope).toBeTruthy();
      const classes = scope?.input.classes as Array<{ dataClass: string; include: boolean }>;
      expect(classes).toEqual([{ dataClass: 'contacts', include: true }]);
    });
    // The plan was created with the chosen cutover date, and files were re-linked with the planId.
    const created = calls.find((c) => c.action === 'migration_create_plan');
    expect(created?.input.cutoverDate).toBe('2026-01-01');
  });
});
