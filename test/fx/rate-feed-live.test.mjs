// §H-FX, the LIVE drift guard for the ESTV/BAZG rate feed.
//
// Every other test in this repo runs offline against a captured payload, which is what keeps the
// money path deterministic. That has one blind spot, and it is the one that matters for a feed: the
// fixture cannot tell you the publisher changed the document under you. A renamed element, a dropped
// <gueltigkeit>, a unit that stops being a power of ten, and the offline suite stays green forever
// while the real import quietly returns nothing.
//
// So this file drives the LIVE endpoints, and it is careful about which failures are allowed to be
// failures:
//
//   - no network (offline laptop, sandboxed CI, the endpoint down) => SKIP, loudly labelled. An
//     external outage must never redden the ledger suite, and `TILL_OFFLINE=1` skips it outright.
//   - the document parses but its SHAPE has drifted => FAIL. That is the whole point of the file.
//
// It asserts structure and invariants, never today's numbers: a rate that changes daily is not a
// fact a test can pin, and pinning it would make the suite fail every morning for the wrong reason.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBazgFeed, fetchBazgFeed, BAZG_DAILY_URL, BAZG_MONTHLY_URL } from '../../dist/core/fx/index.js';

const TIMEOUT_MS = 8000;

/** Fetch, or report why we could not, so a skip always says which of the two happened. */
async function tryFetch(series) {
  if (process.env.TILL_OFFLINE === '1') return { reachable: false, why: 'TILL_OFFLINE=1' };
  try {
    const payload = await fetchBazgFeed(series, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { reachable: true, payload };
  } catch (error) {
    return { reachable: false, why: String(error?.message ?? error) };
  }
}

/** The shape assertions, run against whichever series is live. Drift here is a real failure. */
function assertShape(parsed, expected, endpoint) {
  assert.equal(parsed.ok, true, `the live ${expected} payload no longer parses: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.series, expected, 'the endpoint now serves a different series');
  assert.equal(parsed.endpoint, endpoint);
  assert.ok(parsed.validFor.length > 0, 'a payload with no validity date cannot date a single rate');
  for (const date of parsed.validFor) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(parsed.rates.length > 20, `only ${parsed.rates.length} currencies: the document shrank unexpectedly`);

  const eur = parsed.rates.find((r) => r.currency === 'EUR');
  assert.ok(eur !== undefined, 'EUR is gone from the published series');
  assert.equal(eur.unit, 1, 'EUR is quoted per one unit');
  assert.ok(Number(eur.rate) > 0.5 && Number(eur.rate) < 2, `EUR/CHF ${eur.rate} is outside any plausible band`);

  for (const rate of parsed.rates) {
    assert.match(rate.currency, /^[A-Z]{3}$/);
    assert.ok(
      [1, 10, 100, 1000, 10000, 100000].includes(rate.unit),
      `${rate.currency} is quoted per ${rate.unit}, which the importer does not scale`,
    );
    assert.notEqual(rate.reason, 'unsupported_quotation_unit', `${rate.currency}: unscalable quotation unit`);
  }
}

test('LIVE: the BAZG daily series still has the shape the importer reads', async (t) => {
  const got = await tryFetch('daily');
  if (!got.reachable) {
    t.skip(`live rate feed not reachable, drift unchecked: ${got.why}`);
    return;
  }
  const parsed = parseBazgFeed(got.payload);
  assertShape(parsed, 'daily', BAZG_DAILY_URL);
  // <datum> is the DETERMINATION day and <gueltigkeit> the days the rate is valid FOR, so the
  // validity window is forward of the determination. If that ever inverts, the importer would date
  // every row a day wrong, which is exactly the failure the foundation refused to risk.
  assert.match(parsed.determinedOn, /^\d{4}-\d{2}-\d{2}$/);
  for (const date of parsed.validFor) {
    assert.ok(date > parsed.determinedOn, `validity ${date} is not forward of determination ${parsed.determinedOn}`);
  }
});

test('LIVE: the BAZG Monatsmittelkurs series still has the shape the importer reads', async (t) => {
  const got = await tryFetch('monthly_avg');
  if (!got.reachable) {
    t.skip(`live rate feed not reachable, drift unchecked: ${got.why}`);
    return;
  }
  const parsed = parseBazgFeed(got.payload);
  assertShape(parsed, 'monthly_avg', BAZG_MONTHLY_URL);
  assert.match(parsed.month, /^\d{4}-\d{2}$/);
  assert.deepEqual(parsed.validFor, [`${parsed.month}-01`]);
});
