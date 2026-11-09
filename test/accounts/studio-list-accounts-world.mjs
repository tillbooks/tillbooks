/**
 * The one world behind `app/src/surfaces/Accounts/list-accounts.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-list-accounts.mjs`, a sibling of this file, run as
 * `npm run build && node test/accounts/capture-studio-list-accounts.mjs`) and by the drift guard
 * (`studio-list-accounts-fixture.test.mjs`), so the fixture is a RECORDING of this function and the
 * guard replays exactly the same function. Two copies of the world would let the recording and the
 * assertion drift apart, which is the failure this whole file exists to prevent.
 *
 * The world is the shipped KMU chart plus ONE posted entry, debit 1000 (Kassenbestand) against
 * credit 3000 (Erlöse aus eigener Produktion). That single posting is what makes `inUse` mean
 * something: without it every row comes back `inUse: false`, the Studio's Archive-XOR-Delete choice
 * has only one arm to test, and the destructive path would be the only one a fixture ever exercised.
 */

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';

export const AT = '2026-07-19T00:00:00.000Z';
export const DATE = '2026-07-19';

/** The account the single posting debits, and the one it credits. Both end up `inUse: true`. */
export const POSTED_DEBIT = '1000';
export const POSTED_CREDIT = '3000';

/** The live `list_accounts` response for that world. */
export function liveListAccounts() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Muster Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });

  const seeded = listAccounts(ctx, {});
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  assert.ok(seeded.accounts.length > 0, 'the workspace was created without a chart of accounts');

  const idOf = (number) => {
    const row = seeded.accounts.find((account) => account.number === number);
    assert.ok(row !== undefined, `the shipped chart has no account ${number}`);
    return row.id;
  };

  const posted = postEntry(ctx, {
    date: DATE,
    ref: 'B-001',
    description: 'Barverkauf',
    source: 'manual',
    idempotencyKey: 'studio-accounts-1',
    lines: [
      { account: idOf(POSTED_DEBIT), debit: 100000 },
      { account: idOf(POSTED_CREDIT), credit: 100000 },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const live = listAccounts(ctx, {});
  assert.equal(live.ok, true, JSON.stringify(live));
  return live;
}
