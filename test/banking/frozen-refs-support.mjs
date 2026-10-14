// A18 F9: the pain.001 references a camt.053 reports back are the ones FROZEN on the rows, never a value
// derived from a database id (a restore or env_copy re-mints ids, and a disambiguated reference carries a
// `-<n>` suffix no id derives). Tests that spell a camt line naming a TILL run read them from here.

/** The PmtInfId the run's file carried: `payment_batch.pmt_inf_id`. */
export function frozenPmtInfId(t, batchId) {
  const row = t.store.db.prepare('SELECT pmt_inf_id FROM payment_batch WHERE workspace_id = ? AND id = ?').get(t.workspaceId, batchId);
  if (row?.pmt_inf_id == null) throw new Error(`no frozen PmtInfId for ${batchId}`);
  return row.pmt_inf_id;
}

/** The EndToEndId the item's transaction carried: `payment_batch_item.end_to_end_id`. */
export function frozenEndToEndId(t, itemId) {
  const row = t.store.db.prepare('SELECT end_to_end_id FROM payment_batch_item WHERE workspace_id = ? AND id = ?').get(t.workspaceId, itemId);
  if (row?.end_to_end_id == null) throw new Error(`no frozen EndToEndId for ${itemId}`);
  return row.end_to_end_id;
}
