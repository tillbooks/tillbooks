// A36 §7 R0: the PRIVATE wire's stateful H005 mock bank, served behind a real loopback HTTPS server in
// its own worker thread, for `ebics-r0-wire.test.mjs`. The core's sync wire blocks the main thread
// while a request is in flight (worker plus Atomics.wait), so the bank must answer from another thread.
//
// The mock bank is NOT part of this repository: it lives in the private `ebics-wire` checkout the test
// was pointed at (`workerData.mockBankUrl`), and the TLS pair is that checkout's test pair. This file
// only relays: HTTPS requests to the bank's handler, and the test's control messages (offer a
// container, activate, rotate the keys, inject a code, replay an earlier answer, read the receipts).

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { createMockBank } = await import(workerData.mockBankUrl);
const bank = createMockBank({
  freshKeys: true,
  hostId: workerData.hostId,
  subscriber: { partnerId: workerData.partnerId, userId: workerData.userId },
  requireActivation: workerData.requireActivation === true,
});

const server = createServer({ key: readFileSync(workerData.keyPath), cert: readFileSync(workerData.certPath) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let out;
    try {
      out = bank.handle(Buffer.concat(chunks));
    } catch (err) {
      res.destroy(err);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' });
    res.end(Buffer.from(out));
  });
});

parentPort.on('message', (msg) => {
  const reply = (value) => parentPort.postMessage({ id: msg.id, value });
  switch (msg.cmd) {
    case 'offer':
      bank.offerStatements(Buffer.from(msg.containerBase64, 'base64'));
      return reply(true);
    case 'activate':
      bank.activate();
      return reply(bank.state.subscriber);
    case 'rotate':
      bank.rotateKeys();
      return reply(true);
    case 'nextCode':
      bank.nextCode(msg.kind, msg.codes);
      return reply(true);
    case 'replayLastInit': {
      const last = bank.state.initResponses[bank.state.initResponses.length - 1];
      if (last === undefined) return reply(false);
      bank.replayNextInit(last.bytes);
      return reply(last.transactionId);
    }
    case 'bankHashes':
      return reply(bank.bankHashes());
    case 'receipts':
      return reply(bank.state.receipts.map((r) => ({ ...r })));
    case 'log':
      return reply(bank.state.log.map((e) => ({ seq: e.seq, kind: e.kind })));
    default:
      return reply(null);
  }
});

server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ ready: true, port: server.address().port });
});
