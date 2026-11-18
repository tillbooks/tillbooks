// A43 section 5: the published schema. A drift test (the committed file is what the generator writes) and a
// parity test: one fixture corpus through the schema (the bespoke subset validator AND ajv in strict mode, a
// test-only use of the repo's own copy) and through readSettlementDocument must agree.
// SYNTHETIC DATA ONLY (see contract-corpus.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

import { readSettlementDocument, SETTLEMENT_KINDS, SETTLEMENT_MAX_EVENTS } from '../../dist/core/settlement/format.js';
import { buildSettlementJsonSchema, settlementJsonSchemaText, SETTLEMENT_READER_ONLY_CHECKS } from '../../dist/core/settlement/contract.js';
import { validate } from './schema-validate.mjs';
import { CASES } from './contract-corpus.mjs';

const FILE = new URL('../../schemas/till-settlement-v1.schema.json', import.meta.url);
const schema = buildSettlementJsonSchema();

test('drift: the committed schema is exactly what the generator writes (run npm run generate:schemas)', () => {
  assert.equal(readFileSync(FILE, 'utf8'), settlementJsonSchemaText());
});

test('the schema carries the format constants, not copies of them', () => {
  assert.deepEqual(schema.$defs.event.properties.kind.enum, [...SETTLEMENT_KINDS]);
  assert.equal(schema.properties.events.maxItems, SETTLEMENT_MAX_EVENTS);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('the schema is parseable JSON with no function or undefined value', () => {
  assert.deepEqual(JSON.parse(settlementJsonSchemaText()), schema);
});

test('the schema uses neither format nor multipleOf (annotation-only, and float division)', () => {
  const text = settlementJsonSchemaText();
  assert.doesNotMatch(text, /"format"|"multipleOf"/);
});

const ajv = new Ajv2020({ strict: true });
const ajvValidate = ajv.compile(schema);

test('the schema compiles in ajv strict mode', () => {
  assert.equal(typeof ajvValidate, 'function');
});

for (const c of CASES) {
  test(`parity: ${c.name}`, () => {
    const bespoke = validate(schema, c.doc);
    const ajvAccepts = ajvValidate(c.doc);
    const read = readSettlementDocument(c.doc, 'CHF');
    const readerAccepts = read.ok && read.document.refused.length === 0;
    const code = read.ok ? read.document.refused[0]?.code ?? null : read.error;
    assert.equal(code, c.refusal, 'the reader gives the code the corpus names');
    assert.equal(bespoke.length === 0, ajvAccepts, `the bespoke validator and ajv agree: ${JSON.stringify(bespoke.slice(0, 2))} vs ${JSON.stringify(ajvValidate.errors?.slice(0, 2))}`);
    if (typeof c.readerOnly === 'string') {
      const check = SETTLEMENT_READER_ONLY_CHECKS[c.readerOnly];
      assert.ok(check, `${c.readerOnly} is declared as a reader-only check`);
      assert.equal(check.code, c.refusal, 'the declared check gives this code');
      assert.equal(ajvAccepts, true, 'a reader-only check is invisible to the schema');
      assert.equal(readerAccepts, false);
    } else {
      assert.equal(ajvAccepts, readerAccepts, `ajv ${JSON.stringify(ajvValidate.errors?.slice(0, 3))} vs reader ${code}`);
    }
  });
}

test('every refusal code of the reader appears in the corpus', () => {
  const codes = new Set(CASES.map((c) => c.refusal).filter((c) => c !== null));
  for (const code of ['invalid_event', 'missing_id', 'duplicate_id', 'invalid_day', 'currency_mismatch', 'unknown_kind', 'invalid_amount', 'amount_mismatch', 'unsupported_schema', 'invalid_settlement']) {
    assert.ok(codes.has(code), `the corpus has no case for ${code}`);
  }
});

test('the reader-only list names exactly the checks the corpus marks readerOnly', () => {
  const marked = new Set(CASES.filter((c) => typeof c.readerOnly === 'string').map((c) => c.readerOnly));
  assert.deepEqual([...marked].sort(), Object.keys(SETTLEMENT_READER_ONLY_CHECKS).sort());
});

test('the schema description lists every reader-only check', () => {
  for (const id of Object.keys(SETTLEMENT_READER_ONLY_CHECKS)) assert.ok(schema.description.includes(id), id);
});
