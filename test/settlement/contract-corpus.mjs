// The shared fixture corpus of the till-settlement/v1 contract (A43 section 5). SYNTHETIC BY CONSTRUCTION:
// the system, the processor and every id, day and amount are invented. Valid documents and every refusal
// code of the reader, used by the schema parity test and by the validate_settlement test.
//
// `refusal` is the code the reader gives (a file-level error code, or the per-event refusal code);
// `readerOnly` marks the checks JSON Schema cannot state (the schema accepts, the reader refuses).

const sale = (id, extra = {}) => ({ id, kind: 'sale', day: '2026-07-03', currency: 'CHF', amount: 108.1, net: 100, vat: { amount: 8.1, code: 'X', rate: 8.1 }, ...extra });
const doc = (events, top = {}) => ({ schema: 'till-settlement/v1', source: { system: 'Demoshop', processor: 'Demopay' }, events, ...top });

export const CASES = [
  { name: 'minimal valid document, no events', doc: doc([]), refusal: null },
  { name: 'one sale', doc: doc([sale('s1')]), refusal: null },
  {
    name: 'every kind, string and number amounts, vat null, a document and refs, unknown fields',
    doc: doc(
      [
        sale('a1', { amount: '108.10', net: '100.00', document: { type: 'invoice', number: 'R-1' }, refs: { chargeId: 'ch_1' }, counterparty: 'Erika Muster', description: 'Kurs', somethingNew: true }),
        { id: 'a2', kind: 'refund', day: '2026-07-04', currency: 'CHF', amount: -10.81, net: -10, vat: { amount: -0.81 } },
        { id: 'a3', kind: 'processing_fee', day: '2026-07-04', currency: 'CHF', amount: -3, net: -3, vat: null },
        { id: 'a4', kind: 'service_fee', day: '2026-07-04', currency: 'CHF', amount: '-1.5', net: '-1.5' },
        { id: 'a5', kind: 'third_party_payout', day: '2026-07-05', currency: 'CHF', amount: -50, net: -50, vat: null },
        { id: 'a6', kind: 'third_party_payout_reversal', day: '2026-07-05', currency: 'CHF', amount: 50, net: 50, vat: null },
        { id: 'a7', kind: 'reserve', day: '2026-07-06', currency: 'CHF', amount: -5, net: -5, vat: null },
        { id: 'a8', kind: 'bank_payout', day: '2026-07-07', currency: 'CHF', amount: -20, net: -20, vat: null },
        { id: 'a9', kind: 'bank_payout_summary', day: '2026-07-07', currency: 'CHF', amount: -1, net: -1, vat: null },
        { id: 'a10', kind: 'other', day: '2026-07-08', currency: 'CHF', amount: 0, net: 0, vat: null, date: '2026-07-08T10:00:00.000Z', month: '2026-07' },
      ],
      { generatedAt: '2026-08-01T06:00:00.000Z', period: { from: '2026-07-01', to: '2026-07-31' }, currency: 'CHF', clearingAccount: '9999', signConvention: 'amount = effect on the balance', warnings: ['a note'], source: { system: 'Demoshop', processor: 'Demopay', entity: 'Muster GmbH' }, futureField: 1 },
    ),
    refusal: null,
  },
  { name: 'a negative amount of a refund', doc: doc([sale('r1', { kind: 'refund', amount: -108.1, net: -100, vat: { amount: -8.1 } })]), refusal: null },

  // The whole file refuses.
  { name: 'not an object', doc: [], refusal: 'invalid_settlement' },
  { name: 'wrong schema string', doc: doc([], { schema: 'till-settlement/v2' }), refusal: 'unsupported_schema' },
  { name: 'no schema', doc: { source: { system: 'a', processor: 'b' }, events: [] }, refusal: 'unsupported_schema' },
  { name: 'no source', doc: { schema: 'till-settlement/v1', events: [] }, refusal: 'invalid_settlement' },
  { name: 'source.system blank', doc: doc([], { source: { system: '  ', processor: 'p' } }), refusal: 'invalid_settlement' },
  { name: 'source.processor missing', doc: doc([], { source: { system: 's' } }), refusal: 'invalid_settlement' },
  { name: 'source.system too long', doc: doc([], { source: { system: 'x'.repeat(101), processor: 'p' } }), refusal: 'invalid_settlement' },
  { name: 'events is not an array', doc: doc([], { events: {} }), refusal: 'invalid_settlement' },
  { name: 'no events field', doc: { schema: 'till-settlement/v1', source: { system: 's', processor: 'p' } }, refusal: 'invalid_settlement' },
  { name: 'too many events', doc: doc(Array.from({ length: 20_001 }, (_, i) => ({ id: `e${i}`, kind: 'other', day: '2026-07-01', currency: 'CHF', amount: 0, net: 0 }))), refusal: 'invalid_settlement' },

  // One event refuses.
  { name: 'event is not an object', doc: doc([42]), refusal: 'invalid_event' },
  { name: 'event without id', doc: doc([{ kind: 'other', day: '2026-07-01', currency: 'CHF', amount: 0, net: 0 }]), refusal: 'missing_id' },
  { name: 'event with a blank id', doc: doc([sale('   ')]), refusal: 'missing_id' },
  { name: 'event with an id over 200 characters', doc: doc([sale('i'.repeat(201))]), refusal: 'missing_id' },
  { name: 'event with a numeric id', doc: doc([sale(7)]), refusal: 'missing_id' },
  { name: 'two events with one id', doc: doc([sale('dup'), sale('dup')]), refusal: 'duplicate_id', readerOnly: 'duplicate_id' },
  { name: 'day is not a real date', doc: doc([sale('d1', { day: '2026-02-30' })]), refusal: 'invalid_day', readerOnly: 'calendar_date' },
  { name: 'day in the wrong form', doc: doc([sale('d2', { day: '03.07.2026' })]), refusal: 'invalid_day' },
  { name: 'another currency than the workspace', doc: doc([sale('c1', { currency: 'EUR' })]), refusal: 'currency_mismatch', readerOnly: 'currency_mismatch' },
  { name: 'lower case currency', doc: doc([sale('c2', { currency: 'chf' })]), refusal: 'currency_mismatch' },
  { name: 'unknown kind', doc: doc([sale('k1', { kind: 'chargeback' })]), refusal: 'unknown_kind' },
  { name: 'three decimals as numbers', doc: doc([sale('m1', { amount: 108.105, net: 100, vat: { amount: 8.105 } })]), refusal: 'invalid_amount', readerOnly: 'number_decimals' },
  { name: 'three decimals as strings', doc: doc([sale('m1s', { amount: '108.105', net: '100', vat: { amount: '8.105' } })]), refusal: 'invalid_amount' },
  { name: 'a number spelled with an exponent after parsing', doc: doc([sale('m1e', { amount: 1e-7, net: 1e-7, vat: null })]), refusal: 'invalid_amount', readerOnly: 'number_decimals' },
  { name: 'cents that float division gets wrong, as numbers', doc: doc([sale('n1', { amount: 19.99, net: 19.99, vat: null }), sale('n2', { amount: 0.07, net: 0.07, vat: null }), sale('n3', { amount: 1.15, net: 1.15, vat: null }), sale('n4', { amount: -4.35, net: -4.35, vat: null })]), refusal: null },
  { name: 'an id of 101 characters outside the basic plane (202 UTF-16 units)', doc: doc([sale('\u{1F600}'.repeat(101))]), refusal: 'missing_id', readerOnly: 'text_length' },
  { name: 'exponent spelling', doc: doc([sale('m2', { amount: '1e-3', net: '1e-3', vat: null })]), refusal: 'invalid_amount' },
  { name: 'a plus sign', doc: doc([sale('m3', { amount: '+5', net: '+5', vat: null })]), refusal: 'invalid_amount' },
  { name: 'more than 13 integer digits', doc: doc([sale('m4', { amount: '12345678901234', net: '12345678901234', vat: null })]), refusal: 'invalid_amount' },
  { name: 'net missing', doc: doc([{ id: 'm5', kind: 'sale', day: '2026-07-01', currency: 'CHF', amount: 5 }]), refusal: 'invalid_amount' },
  { name: 'amount missing', doc: doc([{ id: 'm6', kind: 'sale', day: '2026-07-01', currency: 'CHF', net: 5 }]), refusal: 'invalid_amount' },
  { name: 'vat is not an object', doc: doc([sale('v1', { vat: 5 })]), refusal: 'invalid_amount' },
  { name: 'vat without an amount', doc: doc([sale('v2', { vat: { code: 'X' } })]), refusal: 'invalid_amount' },
  { name: 'amount is not net plus VAT', doc: doc([sale('q1', { amount: 109 })]), refusal: 'amount_mismatch', readerOnly: 'amount_mismatch' },
];
