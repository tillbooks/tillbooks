/**
 * The G22 checklist run behind the shown period (D127): what the JourneyStrip renders "exportiert
 * am" and "bestätigt am" from, and what completes the export item after a successful export.
 *
 * Two reads (`checklist_list` filtered to the `vat_period` template, then `checklist_get` for the
 * matching run) and one write (`checklist_item_complete` for `ech0217_exported`, behind
 * `manage_checklists`). A refusal on either read means "no run": the strip then renders exactly as it
 * did before G22, which is the honest state for a workspace without checklists or without the right.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import type { JourneyRun } from './JourneyStrip';

const TEMPLATE_ID = 'vat_period';
const EXPORT_ITEM_ID = 'ech0217_exported';
const ATTEST_ITEM_ID = 'eportal_filed';

interface RunRow {
  runId: string;
  periodStart: string;
  status: string;
}

interface ItemRow {
  itemId: string;
  status: string;
  completedAt: string | null;
  signoff: { evidenceRef: string; actorKind?: string; actorName?: string | null } | null;
}

export interface ChecklistRunState {
  run: JourneyRun | null;
  reload: () => Promise<void>;
  /** Complete the export item on the run, when one exists and the actor may. Silent otherwise. */
  completeExport: () => Promise<void>;
}

export function useChecklistRun(workspaceId: string | null, periodStart: string | null, canManage: boolean): ChecklistRunState {
  const client = useClient();
  const [run, setRun] = useState<JourneyRun | null>(null);

  const reload = useCallback(async () => {
    if (workspaceId === null || periodStart === null || periodStart === '') {
      setRun(null);
      return;
    }
    const listed = await client.call('checklist_list', { workspaceId, templateId: TEMPLATE_ID });
    if (isErr(listed.body)) {
      setRun(null);
      return;
    }
    const runs = Array.isArray(listed.body.runs) ? (listed.body.runs as RunRow[]) : [];
    const match = runs.find((r) => r.periodStart === periodStart && r.status !== 'abandoned');
    if (match === undefined) {
      setRun(null);
      return;
    }
    const got = await client.call('checklist_get', { workspaceId, runId: match.runId });
    if (isErr(got.body)) {
      setRun(null);
      return;
    }
    const items = Array.isArray(got.body.items) ? (got.body.items as ItemRow[]) : [];
    const exported = items.find((i) => i.itemId === EXPORT_ITEM_ID);
    const attested = items.find((i) => i.itemId === ATTEST_ITEM_ID);
    setRun({
      runId: match.runId,
      exportedAt: exported?.status === 'done' && typeof exported.completedAt === 'string' ? exported.completedAt.slice(0, 10) : null,
      attestedAt: attested?.status === 'done' && attested.signoff !== null ? attested.signoff.evidenceRef : null,
      attestedBy:
        attested?.status === 'done' && attested.signoff !== null
          ? { kind: typeof attested.signoff.actorKind === 'string' ? attested.signoff.actorKind : 'unknown', name: typeof attested.signoff.actorName === 'string' ? attested.signoff.actorName : null }
          : null,
    });
  }, [client, workspaceId, periodStart]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const completeExport = useCallback(async () => {
    if (run === null || !canManage || workspaceId === null) return;
    await client.call('checklist_item_complete', { workspaceId, runId: run.runId, itemId: EXPORT_ITEM_ID, idempotencyKey: crypto.randomUUID() });
    await reload();
  }, [client, run, canManage, workspaceId, reload]);

  return { run, reload, completeExport };
}
