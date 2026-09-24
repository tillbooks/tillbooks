// A stand-in for the PRIVATE @tillbooks/ebics-wire module, used to test the host-runtime seam
// (host-runtime.ts) hermetically, WITHOUT the private package. It exposes exactly the two exports the
// seam expects (createEbicsWire + createEbicsTransport) and records what it was handed, so the test
// can assert the seam builds the keystore, loads the module, and composes the transport correctly.
//
// The real wire opens sockets; this one never does. It only proves the ATTACHMENT, which is all the
// OSS-side seam is responsible for (the wire's own behaviour is proven in the ebics-wire repo).

/** Records every createEbicsWire call so the test can assert the keystore reached the wire. */
export const calls = { wire: [], transport: [] };

/** Set the fingerprints the fake HPB parser returns, so a test can vary them. */
export const bankHashes = { authentication: 'auth-fingerprint', encryption: 'enc-fingerprint' };

export function createEbicsWire(opts) {
  calls.wire.push(opts);
  // A trivial synchronous wire: every order type "succeeds" with an empty body. Enough to prove the
  // transport is composed and reachable; the real protocol is exercised in the wire's own tests.
  return (_req) => ({ ok: true, responseBase64: '' });
}

export function createEbicsTransport(opts) {
  calls.transport.push(opts);
  return {
    wire: opts.wire,
    fetchBankKeys(_req) {
      return { ok: true, bankKeyHashes: { ...bankHashes } };
    },
  };
}
