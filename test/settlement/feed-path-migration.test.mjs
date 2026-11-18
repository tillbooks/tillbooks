// A43 section 4: a book written before the feed_path column opens through the real store, gets the column
// (ADDITIVE_COLUMNS, applyAdditiveSchema), reads its source as the default path, and keeps its token when the
// default is saved again. SYNTHETIC DATA ONLY.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { setSettlementSource, getSettlementSource, SETTLEMENT_FEED_PATH } from '../../dist/core/settlement/index.js';
import { settlementWorld, must, SYSTEM, PROCESSOR } from './support.mjs';

const NOW = '2026-10-05T08:00:00.000Z';
const BASE = 'https://kurswerk.example';
const TOKEN = 'kw_test_token_0123456789abcdef';

const columns = (db) => db.prepare("SELECT name FROM pragma_table_info('settlement_source')").all().map((c) => c.name);

test('an old-shape book (no feed_path) opens, widens, reads the default path and keeps its token on a default re-save', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-feedpath-'));
  const file = join(dir, 'till.db');
  try {
    const tokens = new Map();
    const port = {
      secretStore: 'memory',
      storeToken: (ref, token) => (tokens.set(ref, token), { ok: true }),
      deleteToken: (ref) => (tokens.delete(ref), { ok: true }),
      hasToken: (ref) => tokens.has(ref),
      fetchFeed: () => ({ kind: 'no_token' }),
    };
    // A book with a saved source and its token, written by the current build.
    const t = settlementWorld({ location: file });
    const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: port });
    must(setSettlementSource(ctx, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, fromDate: '2026-07-01', feedToken: TOKEN, idempotencyKey: 'old-1' }));
    t.store.close();

    // Put the old shape back: the column did not exist.
    const raw = new Database(file);
    raw.exec('ALTER TABLE settlement_source DROP COLUMN feed_path');
    assert.equal(columns(raw).includes('feed_path'), false, 'the fixture really is the old shape');
    raw.close();

    // The real store opens it and widens it.
    const store = new SqliteStore({ location: file, clock: fixedClock(NOW) });
    try {
      assert.equal(columns(store.db).includes('feed_path'), true, 'the column exists after open');
      const reopened = makeContext(store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(NOW), ids: t.ids, settlementFeed: port });
      const source = must(getSettlementSource(reopened, {})).sources[0];
      assert.equal(source.feedPath, SETTLEMENT_FEED_PATH);
      assert.equal(source.baseUrl, BASE);
      assert.equal(source.tokenStored, true);
      // Saving the default again is no move: the token stays.
      const again = must(setSettlementSource(reopened, { system: SYSTEM, processor: PROCESSOR, baseUrl: BASE, feedPath: SETTLEMENT_FEED_PATH, fromDate: '2026-07-01', idempotencyKey: 'old-2' }));
      assert.equal(again.tokenDroppedUrlMoved, false);
      assert.equal(again.source.tokenStored, true);
      assert.equal(tokens.size, 1, 'the secret store item is still there');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
