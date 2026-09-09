/**
 * The creditor ERROR-CODE drift guard: the Studio's rejection map versus the live engine.
 *
 * Same family as `test/setup/profile-fixture.test.mjs` (response SHAPE) and
 * `test/vat/tax-codes-fixture.test.mjs` (response CONTENT). This one pins the third thing a client
 * assumes about a verb and nothing was checking: its set of REJECTION CODES.
 *
 * The sixth member of the assumed-shape bug family. M-2 made `setCreditorProfile` accept a plain
 * IBAN and renamed its refusal from `not_a_qr_iban` to `invalid_iban`. The Studio kept mapping
 * `not_a_qr_iban`, so a user typing a perfectly valid ordinary IBAN saw either nothing useful or the
 * generic fallback. The app suite MOCKED a 422 carrying `not_a_qr_iban` and asserted the message it
 * expected, which pinned the client's assumption against itself: 318 green app tests, one wrong
 * message on screen. A mocked error code proves nothing about the engine, so something has to
 * compare the two, and this is it.
 *
 * `app/src/surfaces/Setup/creditor-error-contract.json` is the single shared truth: the surface
 * imports it AS its error map (it does not restate the codes), and this test pins it BOTH ways.
 *   - every code in the contract is really emitted by a live `setCreditorProfile` call
 *     (catches a rename or a removal, which is exactly what happened),
 *   - every `err(...)` code in the verb's own source appears in the contract
 *     (catches an ADDITION, which a live drive alone would silently miss),
 *   - and the dead `not_a_qr_iban` never comes back, in the engine or in the Studio.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWorkspace, setCreditorProfile, getCompanyProfile } from '../../dist/core/setup/index.js';
import { setup } from './support.mjs';

const CONTRACT_PATH = new URL('../../app/src/surfaces/Setup/creditor-error-contract.json', import.meta.url);
const SOURCE_PATH = new URL('../../src/core/setup/companyProfile.ts', import.meta.url);
const SURFACE_PATH = new URL('../../app/src/surfaces/Setup/CompanyProfile.tsx', import.meta.url);

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

const ADDRESS = { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' };
/** A real QR-IBAN: QR-IID 31999, inside the reserved 30000-31999 range. */
const QR_IBAN = 'CH4431999123000889012';
/** An ORDINARY IBAN. Valid, and what a large share of Swiss SMEs actually have. */
const PLAIN_IBAN = 'CH9300762011623852957';

function freshCtx() {
  const { deps, ctxFor } = setup();
  return ctxFor(createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId);
}

/**
 * Every input that must be REFUSED, one per rejection branch, labelled with the code it is meant to
 * produce. The labels are the expectation; the live call is the evidence.
 */
const REFUSALS = [
  { code: 'invalid_name', input: { creditorName: '   ', address: ADDRESS, qrIban: QR_IBAN } },
  { code: 'needs_structured_address', input: { creditorName: 'Nomadik GmbH', address: { street: 'Bahnhofstrasse' } } },
  { code: 'invalid_iban', input: { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: 'CH93 not an iban' } },
  // The QR injection ingress: a CR+LF in the creditor block would inject a Swiss QR Code element.
  { code: 'illegal_character', input: { creditorName: 'Nomadik\r\nGmbH', address: ADDRESS, qrIban: QR_IBAN } },
];

test('the contract lists a code only if the LIVE engine really emits it', () => {
  const emitted = new Set();
  for (const { code, input } of REFUSALS) {
    const res = setCreditorProfile(freshCtx(), input);
    assert.equal(res.ok, false, `${code}: this input must be refused, got ${JSON.stringify(res)}`);
    assert.equal(res.error, code, `the refusal renamed itself: expected ${code}, engine sent ${res.error}`);
    emitted.add(res.error);
  }

  assert.deepEqual(
    Object.keys(contract.codes).sort(),
    [...emitted].sort(),
    'app/src/surfaces/Setup/creditor-error-contract.json drifted from setCreditorProfile: ' +
      'the Studio maps a code the engine does not send, or misses one it does',
  );
});

test('every err() code in the verb source is in the contract, so an ADDITION cannot slip past', () => {
  // A live drive can only find codes it already knows to provoke. Reading the source finds the ones
  // nobody thought to provoke, which is the half that would otherwise reach a user unmapped.
  //
  // The scan follows the verb into the LOCAL HELPERS it calls, transitively. It used to read the
  // verb body alone, and that was a hole big enough to walk the creditor charset guard through: the
  // QR injection ingress check rejects with `illegal_character` from `validateQrCharset`, two calls
  // deep, so the body-only scan saw no new code and stayed green while the Studio had nothing mapped
  // for it. A rejection does not stop being the verb's rejection because it was factored out.
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const declared = [...source.matchAll(/^(?:export )?function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
  const bodyOf = (name) =>
    new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm').exec(source)?.[0] ?? null;

  assert.notEqual(bodyOf('setCreditorProfile'), null, 'setCreditorProfile was renamed or reshaped: this guard needs updating');

  const reached = new Set();
  const queue = ['setCreditorProfile'];
  let scanned = '';
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const body = bodyOf(name);
    if (body === null) continue;
    scanned += body;
    for (const fn of declared) {
      if (fn !== name && !reached.has(fn) && new RegExp(`\\b${fn}\\(`).test(body)) queue.push(fn);
    }
  }
  assert.ok(reached.has('validateCreditorCharset'), 'the scan no longer reaches the charset guard: it would miss its codes');

  const codes = [...new Set([...scanned.matchAll(/\berr\(\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(codes.length > 0, 'no err() code found in setCreditorProfile: the extraction broke, not the verb');
  assert.deepEqual(
    codes,
    Object.keys(contract.codes).sort(),
    'setCreditorProfile emits a code the Studio does not map. Add it to ' +
      'app/src/surfaces/Setup/creditor-error-contract.json with an i18n key, or the user gets the fallback',
  );
});

test('M-2 holds at the contract level: an ORDINARY IBAN is accepted, only a malformed one is refused', () => {
  for (const iban of [PLAIN_IBAN, QR_IBAN]) {
    const ctx = freshCtx();
    const res = setCreditorProfile(ctx, { creditorName: 'Nomadik GmbH', address: ADDRESS, qrIban: iban });
    assert.ok(res.ok, `${iban} is a valid creditor IBAN and must be accepted: ${JSON.stringify(res)}`);
    assert.equal(getCompanyProfile(ctx).profile.creditorIban, iban, 'an accepted IBAN must actually be stored');
  }
});

test('not_a_qr_iban is dead in BOTH halves: the engine never sends it, the Studio never names it', () => {
  // The exact defect, asserted by name in both directions so it cannot quietly return on either side.
  assert.equal(
    readFileSync(SOURCE_PATH, 'utf8').includes("err('not_a_qr_iban'"),
    false,
    'the engine started refusing plain IBANs again: a business without a QR-IBAN could not invoice',
  );
  assert.equal(
    'not_a_qr_iban' in contract.codes,
    false,
    'the Studio contract still maps not_a_qr_iban, a code the engine stopped emitting',
  );
  // Quoted, so the surface's comment recording WHY the code is gone does not itself trip the guard.
  assert.equal(
    readFileSync(SURFACE_PATH, 'utf8').includes("'not_a_qr_iban'"),
    false,
    'CompanyProfile.tsx still branches on not_a_qr_iban',
  );
});
