// A36: the EBICS 3.0 (H005) transport SEAM, contract version 2. Proves it degrades honestly with no live
// wire (D108), requests exactly the one statement BTF, reads a ZIP container from its CENTRAL DIRECTORY
// byte-for-byte (stored, deflated, and written with data descriptors, the shape the old local-header walk
// stopped at silently), refuses a container that fails its count or CRC checks as `untrusted_response`,
// refuses a download success without a TransactionID (W2), hands the receipt the TransactionID and an
// explicit receipt code, and has no upload or SPR method at all. Offline: it opens NO socket.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEbicsHttpsTransport, readZipContainer, STATEMENT_BTF } from '../../dist/core/banking/ebics/transport-https.js';
import { zip, container, camt053, syntheticIban } from './ebics-support.mjs';

const CONN = { hostUrl: 'https://ebics.example/ebics', hostId: 'H', partnerId: 'P', userIdEbics: 'U', protocolVersion: 'H005', keyRef: 'k' };
const TX = '0123456789ABCDEF0123456789ABCDEF';

test('readZipContainer reads DEFLATE, STORED and data-descriptor members byte-for-byte from the central directory', () => {
  const a = '<Document>the bank wrote exactly these bytes</Document>';
  const b = '<Document>and these</Document>';
  for (const opts of [{ deflate: true }, { deflate: false }, { deflate: true, dataDescriptor: true }, { deflate: false, dataDescriptor: true }]) {
    const read = readZipContainer(zip([{ name: 'one.xml', data: Buffer.from(a) }, { name: 'dir/two.xml', data: Buffer.from(b) }], opts));
    assert.equal(read.ok, true, JSON.stringify({ opts, read }));
    assert.deepEqual(read.members.map((m) => [m.name, m.bytes.toString('utf8')]), [['one.xml', a], ['dir/two.xml', b]], JSON.stringify(opts));
  }
});

test('readZipContainer refuses a CRC mismatch, a truncated archive, an unclean name, a duplicate and a bare XML', () => {
  const data = Buffer.from('<Document/>');
  assert.equal(readZipContainer(zip([{ name: 'a.xml', data }], { corruptCrc: true })).reason, 'member_crc_mismatch');
  const good = zip([{ name: 'a.xml', data }]);
  assert.equal(readZipContainer(good.subarray(0, good.length - 10)).ok, false, 'a cut archive has no end record');
  assert.equal(readZipContainer(zip([{ name: '../evil.xml', data }])).reason, 'unclean_member_name');
  assert.equal(readZipContainer(zip([{ name: '/abs.xml', data }])).reason, 'unclean_member_name');
  assert.equal(readZipContainer(zip([{ name: 'A.xml', data }, { name: 'a.XML', data }])).reason, 'duplicate_member_name');
  assert.equal(readZipContainer(Buffer.from('<Document>not a zip</Document>')).ok, false, 'a bare XML is not a statement container');
});

test('with NO wire every step degrades to needs_bank_transport and opens no socket (D108); there is no upload or SPR', () => {
  const t = createEbicsHttpsTransport();
  for (const r of [
    t.hostVersions({ connection: CONN }),
    t.sendKeyLeg({ connection: CONN, leg: 'INI' }),
    t.fetchBankKeys({ connection: CONN }),
    t.download({ connection: CONN, service: 'statements' }),
    t.acknowledge({ connection: CONN, transactionId: TX, receiptCode: 0 }),
  ]) {
    assert.deepEqual(r, { ok: false, reason: 'needs_bank_transport' });
  }
  assert.equal('upload' in t, false, 'D-A36.11: no upload method exists');
  assert.equal('suspend' in t, false, 'D-A36.12: no SPR method exists');
});

test('download requests exactly EOP/CH/ZIP/camt.053 v08 and returns the TransactionID and the members verbatim', () => {
  const xml = camt053({ iban: syntheticIban(1), seq: 1, date: '2026-10-01', opening: 100 });
  const seen = [];
  const wire = (req) => {
    seen.push(req);
    return { ok: true, responseBase64: container([xml], { dataDescriptor: true }).toString('base64'), transactionId: TX.toLowerCase() };
  };
  const res = createEbicsHttpsTransport({ wire }).download({ connection: CONN, service: 'statements' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(seen[0].btf, { serviceName: 'EOP', msgName: 'camt.053', scope: 'CH', msgVersion: '08', containerType: 'ZIP' });
  assert.deepEqual({ ...STATEMENT_BTF }, seen[0].btf);
  assert.equal(seen[0].orderType, 'BTD');
  assert.equal(res.transactionId, TX, 'normalised to uppercase (hexBinary is case-insensitive)');
  assert.equal(res.files.length, 1);
  assert.equal(Buffer.from(res.files[0].contentBase64, 'base64').toString('utf8'), xml, 'byte-for-byte');
  assert.ok(res.containerBase64.length > 0, 'the container travels too, for the E00 copy');
});

test('W2: a BTD success without a 32-hex TransactionID is ebics_wire_contract_error, never a minted token', () => {
  const body = container(['<Document/>']).toString('base64');
  for (const transactionId of [undefined, '', 'btd-statements-1234', 'XYZ', '0123456789ABCDEF0123456789ABCDE']) {
    const wire = () => ({ ok: true, responseBase64: body, ...(transactionId !== undefined ? { transactionId } : {}) });
    const res = createEbicsHttpsTransport({ wire }).download({ connection: CONN, service: 'statements' });
    assert.deepEqual([res.ok, res.reason], [false, 'ebics_wire_contract_error'], String(transactionId));
  }
});

test('a verified container that fails the core ZIP checks is untrusted_response; a wire refusal travels raw', () => {
  const bad = zip([{ name: 'a.xml', data: Buffer.from('<Document/>') }], { corruptCrc: true }).toString('base64');
  const res = createEbicsHttpsTransport({ wire: () => ({ ok: true, responseBase64: bad, transactionId: TX }) }).download({ connection: CONN, service: 'statements' });
  assert.deepEqual([res.ok, res.reason], [false, 'untrusted_response']);
  assert.match(res.detail, /order_data_integrity/);
  const codes = { technical: '000000', business: '090005' };
  const refused = createEbicsHttpsTransport({ wire: () => ({ ok: false, reason: 'bank_code', codes, phase: 'Initialisation' }) }).download({
    connection: CONN,
    service: 'statements',
  });
  assert.deepEqual(refused, { ok: false, reason: 'bank_code', codes, phase: 'Initialisation' });
});

test('the legs, HEV and the receipt travel as their own orders; the receipt carries the TransactionID and the code', () => {
  const seen = [];
  const wire = (req) => {
    seen.push(req);
    return { ok: true, responseBase64: '' };
  };
  const t = createEbicsHttpsTransport({ wire });
  assert.equal(t.hostVersions({ connection: CONN }).ok, true);
  assert.equal(t.sendKeyLeg({ connection: CONN, leg: 'INI' }).ok, true);
  assert.equal(t.sendKeyLeg({ connection: CONN, leg: 'HIA' }).ok, true);
  assert.equal(t.acknowledge({ connection: CONN, transactionId: TX, receiptCode: 1 }).ok, true);
  assert.deepEqual(seen.map((r) => r.orderType), ['HEV', 'INI', 'HIA', 'BTD-ACK']);
  assert.deepEqual([seen[3].transactionId, seen[3].receiptCode], [TX, 1]);
  // A drifted wire that returns anything but the result union is a contract error, not a success.
  const drifted = createEbicsHttpsTransport({ wire: () => undefined });
  assert.deepEqual(drifted.sendKeyLeg({ connection: CONN, leg: 'INI' }), { ok: false, reason: 'ebics_wire_contract_error' });
});
