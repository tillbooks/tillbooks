/**
 * The era-scoped Saldo eligibility limits (MWSTG Art. 37 Abs. 1) and the `vat_saldo_eligibility`
 * read. The boundary assertion exists because the design's own critic caught a filing-grade
 * misdate: the raised limits took effect 1.1.2024 (they rode the Steuersatzerhöhung), NOT 1.1.2025
 * (the N-rate model, a different change). Encoded on the wrong boundary, a lookup would return the
 * old limit for the whole 2024 Steuerperiode and the no-digit lint would propagate it everywhere
 * while making it impossible to correct by hand.
 *
 * The verb's three honest states (design rows 3.5 / 4.3): measured, no-turnover-yet, and
 * unavailable-with-the-refusal-named. The limits return in ALL of them: they are constants, and a
 * failed measurement must not take the law down with it. NEVER a fabricated zero: `measured` is
 * null on the unavailable path, not `{turnoverMinor: 0}`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SALDO_ELIGIBILITY_ERAS, saldoEligibilityOn } from '../../dist/core/vat/rateEras.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

test('the era table pins the verified fedlex values and the 1.1.2024 boundary', () => {
  assert.equal(SALDO_ELIGIBILITY_ERAS.length, 2);

  const before = saldoEligibilityOn('2023-12-31');
  assert.ok(before !== null);
  assert.equal(before.turnoverLimitMinor, 500_500_000, 'CHF 5\'005\'000 (fedlex consolidation 20230101)');
  assert.equal(before.taxDueLimitMinor, 10_300_000, 'CHF 103\'000 (fedlex consolidation 20230101)');

  const after = saldoEligibilityOn('2024-01-01');
  assert.ok(after !== null);
  assert.equal(after.effectiveFrom, '2024-01-01', 'the raise rode the Steuersatzerhöhung of 1.1.2024, not 1.1.2025');
  assert.equal(after.turnoverLimitMinor, 502_400_000, 'CHF 5\'024\'000 (fedlex consolidation 20240101)');
  assert.equal(after.taxDueLimitMinor, 10_800_000, 'CHF 108\'000 (fedlex consolidation 20240101)');

  // Today and every later day resolve to the open-ended 2024 era.
  assert.equal(saldoEligibilityOn('2026-08-17'), after);

  // Before the earliest VERIFIED consolidation the answer is null (cannot state), never a guess.
  assert.equal(saldoEligibilityOn('2022-12-31'), null);
});

test('unconfigured workspace: limits still return, measurement is unavailable with the refusal named, and no zero is fabricated', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const r = getAction('vat_saldo_eligibility').run(deps, { workspaceId });
  assert.equal(r.ok, true);
  assert.ok(r.limits !== null && r.limits.turnoverLimitMinor === 502_400_000);
  assert.equal(r.measured, null, 'no measurement means NO figure, never CHF 0.00');
  assert.equal(r.unavailable?.error, 'needs_vat_config');
  deps.store.close();
});

test('Ist timing: the measurement is unavailable with the SAME reason code A07 refuses with', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  getAction('vat_configure').run(deps, {
    workspaceId,
    method: 'effektiv',
    timing: 'ist',
    registered: true,
    idempotencyKey: 'vse-ist',
  });
  const r = getAction('vat_saldo_eligibility').run(deps, { workspaceId });
  assert.equal(r.ok, true);
  assert.equal(r.measured, null);
  assert.equal(r.unavailable?.error, 'unsupported');
  assert.ok(r.limits !== null, 'the limits are constants and do not depend on the read');
  deps.store.close();
});

test('configured Soll workspace with no turnover: measured.empty is true (the no-turnover state, not a zero)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  getAction('vat_configure').run(deps, {
    workspaceId,
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    idempotencyKey: 'vse-soll',
  });
  const r = getAction('vat_saldo_eligibility').run(deps, { workspaceId, year: '2025' });
  assert.equal(r.ok, true);
  assert.equal(r.year, '2025');
  assert.equal(r.unavailable, null);
  assert.equal(r.measured.empty, true, 'an empty year renders the no-turnover sentence, never CHF 0.00');
  deps.store.close();
});

test('a malformed year is refused', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const r = getAction('vat_saldo_eligibility').run(deps, { workspaceId, year: '20-25' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_input');
  deps.store.close();
});
