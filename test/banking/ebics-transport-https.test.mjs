// A36: the EBICS 3.0 HTTPS transport SEAM. Proves it degrades honestly with no live wire (D108),
// unpacks a ZIP container BYTE-FOR-BYTE (stored + deflate), and, given a runtime wire, hands the
// engine the bank bytes verbatim with the download/acknowledge split intact. Offline: it opens NO
// socket (E07 holds when wired), which is exactly what "the live wire is runtime" means.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { createEbicsHttpsTransport, unpackContainer, BTF_DOWNLOAD_SERVICES } from '../../dist/core/banking/ebics/transport-https.js';

const CONN = { hostUrl: 'https://ebics.example/ebics', hostId: 'H', partnerId: 'P', userIdEbics: 'U', protocolVersion: 'H005', keyRef: 'k' };

/** Build a minimal ZIP with one entry (stored or deflated). */
function zipOne(name, content, { stored = false } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const data = stored ? raw : deflateRawSync(raw);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(stored ? 0 : 8, 8); // method
  h.writeUInt32LE(data.length, 18); // compressed size
  h.writeUInt32LE(raw.length, 22); // uncompressed size
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf, data]);
}

test('unpackContainer inflates a DEFLATE entry byte-for-byte', () => {
  const xml = '<Document>the bank wrote exactly these bytes</Document>';
  const files = unpackContainer(zipOne('camt053.xml', xml));
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'camt053.xml');
  assert.equal(files[0].bytes.toString('utf8'), xml, 'inflated bytes match the bank original exactly');
});

test('unpackContainer copies a STORED entry and passes a bare (non-ZIP) XML through unchanged', () => {
  const xml = '<Document>stored</Document>';
  assert.equal(unpackContainer(zipOne('s.xml', xml, { stored: true }))[0].bytes.toString('utf8'), xml);
  const bare = Buffer.from('<Document>not a zip</Document>', 'utf8');
  const passed = unpackContainer(bare);
  assert.equal(passed.length, 1);
  assert.deepEqual(passed[0].bytes, bare, 'a bare XML is one member, unchanged');
});

test('with NO wire the transport degrades to needs_bank_transport and opens no socket (D108)', () => {
  const t = createEbicsHttpsTransport();
  assert.deepEqual(t.download({ connection: CONN, service: 'statements' }), { ok: false, reason: 'needs_bank_transport' });
  assert.deepEqual(t.acknowledge({ connection: CONN, ackToken: 'x' }), { ok: false, reason: 'needs_bank_transport' });
  assert.deepEqual(t.upload({ connection: CONN, orderRef: 'o', payloadBase64: 'AA==', btf: { serviceName: 'MCT', msgName: 'pain.001' } }), {
    ok: false,
    reason: 'needs_bank_transport',
  });
});

test('given a runtime wire, download returns the unpacked bank bytes with an ackToken (split intact)', () => {
  const xml = '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">morning</Document>';
  const wire = (req) => {
    if (req.orderType === 'BTD') return { ok: true, responseBase64: zipOne('camt.xml', xml).toString('base64') };
    return { ok: true, responseBase64: '' };
  };
  const t = createEbicsHttpsTransport({ wire });
  const res = t.download({ connection: CONN, service: 'statements' });
  assert.equal(res.ok, true);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].msgName, BTF_DOWNLOAD_SERVICES.statements.msgName);
  assert.equal(Buffer.from(res.files[0].contentBase64, 'base64').toString('utf8'), xml, 'byte-for-byte');
  assert.ok(typeof res.ackToken === 'string' && res.ackToken.length > 0, 'an ackToken is returned, receipt not yet sent');
  // The acknowledge is a SEPARATE step (A36 §4).
  assert.equal(t.acknowledge({ connection: CONN, ackToken: res.ackToken }).ok, true);
});
