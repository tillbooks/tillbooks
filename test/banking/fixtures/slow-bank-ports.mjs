// D142 test support: the ports module the `till up` sync worker loads instead of the private wire
// (`resolveWorkerPorts`, see `src/api/bank-sync-worker.ts`). It puts the SYNTHETIC in-process bank of
// `ebics-support.mjs` behind the worker and makes every download BLOCK the thread for `delayMs` with
// `Atomics.wait`, exactly the way the real synchronous wire blocks while it waits on the bank. If the
// sync ran on the main thread, the HTTP server would be frozen for that long; the suite proves it is not.
//
// Synthetic by construction (CLAUDE.md, private data never ships): the containers are built by the test
// from `ebics-support.mjs` (invented IBANs over clearing number 09999, invented amounts and references).

import { mockBank } from '../ebics-support.mjs';

// `gate` (a SharedArrayBuffer, shared with the test thread through workerData): the download blocks until
// the test opens it, so a suite asserts what happens WHILE the wire waits without racing a timer.
// `crash`: the worker thread dies inside the download, with no answer posted (an OOM kill, a native crash).
// `hpbDelayMs` (D143 critic F1): the HPB blocks its thread that long, then answers `hpbAnswer` (default:
// the bank's keys), the way the wire parks a thread while ZKB takes its time.
export function resolveWorkerPorts({ delayMs = 0, gate, crash = false, containersBase64 = [], hpbDelayMs = 0, hpbAnswer } = {}) {
  const bank = mockBank();
  for (const c of containersBase64) bank.offer(Buffer.from(c, 'base64'));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const download = bank.port.download.bind(bank.port);
  const fetchBankKeys = bank.port.fetchBankKeys.bind(bank.port);
  const ebicsTransport = {
    ...bank.port,
    fetchBankKeys(req) {
      if (hpbDelayMs > 0) Atomics.wait(cell, 0, 0, hpbDelayMs);
      return hpbAnswer ?? fetchBankKeys(req);
    },
    download(req) {
      if (crash) process.exit(3);
      if (gate !== undefined) Atomics.wait(new Int32Array(gate), 0, 0, 120_000);
      else if (delayMs > 0) Atomics.wait(cell, 0, 0, delayMs);
      return download(req);
    },
  };
  return { ebicsTransport };
}
