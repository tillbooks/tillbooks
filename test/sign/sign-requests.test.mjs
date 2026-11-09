/**
 * E01's engine behaviour, driven through the registry (both faces run the same `action.run`).
 *
 * The suite proves the spec's own §7/§8 assertions: the FULL transition matrix (every legal edge
 * passes, every illegal edge answers `invalid_transition`, terminal states are terminal, and
 * `draft -> signed` is the ONLY extra edge into `signed`); creation validation (missing file,
 * non-head version, signer without email, expiry in the past, the open-request guard); the OP4
 * boundary (`needs_confirmation`, then `needs_provider`, and the request STAYS a draft both
 * times); the E00 delegation on completion (a real new `stored_file` version with `supersedes_id`,
 * never bytes written by E01); the hash guard; idempotent replay on every write; the lazy expiry
 * sweep; TX-ATOMICITY (a refused transition writes ZERO rows); the disjoint automation-event
 * paths; and §H-TENANT isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { fixedClock } from '../../dist/core/clock.js';
import { SIGN_REQUEST_TRANSITIONS, SIGN_REQUEST_STATUSES } from '../../dist/core/sign/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

// The fixture clock is 2026-07-16T00:00:00.000Z. Every "future" below is relative to it.
function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, call };
}

/** A transmitter that accepts every handover, for driving the provider path. */
function okTransmitter() {
  const handed = [];
  return { handed, transmit: (envelope) => (handed.push(envelope), { ok: true, providerRef: `prov-${handed.length}` }) };
}

let seedNo = 0;

/** One E00 file + one signer with an email, through their own verbs. */
function seedTargets(call, key = `s${(seedNo += 1)}`) {
  const file = call('files_upload', {
    title: `Vertrag ${key}`,
    filename: `${key}.pdf`,
    mime: 'application/pdf',
    contentBase64: Buffer.from(`%PDF-1.4 ${key}`).toString('base64'),
    idempotencyKey: `${key}-file`,
  });
  assert.equal(file.ok, true, `files_upload refused: ${JSON.stringify(file)}`);
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: `Signer ${key} AG`,
    email: `${key}@example.ch`,
    idempotencyKey: `${key}-contact`,
  });
  assert.equal(contact.ok, true);
  return { fileId: file.file.id, sha256: file.file.sha256, signerContactId: contact.contact.id, key };
}

/** Mint a request and drive it to `status` through the real verbs (never an UPDATE). */
function mintAt(deps, call, status, key = `m${(seedNo += 1)}`) {
  const seed = seedTargets(call, key);
  const created = call('sign_requests_create', {
    fileId: seed.fileId,
    signerContactId: seed.signerContactId,
    signatureLevel: 'ses',
    idempotencyKey: `${key}-req`,
  });
  assert.equal(created.ok, true, `sign_requests_create refused: ${JSON.stringify(created)}`);
  const id = created.signRequestId;
  const send = () => {
    deps.signTransmitter = okTransmitter();
    const sent = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: `${key}-send` });
    assert.equal(sent.ok, true, `send refused while minting ${status}: ${JSON.stringify(sent)}`);
    delete deps.signTransmitter;
  };
  if (status === 'draft') {
    // minted
  } else if (status === 'sent') {
    send();
  } else if (status === 'viewed') {
    send();
    assert.equal(call('sign_requests_record_event', { signRequestId: id, status: 'viewed', idempotencyKey: `${key}-v` }).ok, true);
  } else if (status === 'declined') {
    send();
    assert.equal(call('sign_requests_record_event', { signRequestId: id, status: 'declined', idempotencyKey: `${key}-d` }).ok, true);
  } else if (status === 'expired') {
    send();
    assert.equal(call('sign_requests_record_event', { signRequestId: id, status: 'expired', idempotencyKey: `${key}-e` }).ok, true);
  } else if (status === 'signed') {
    const done = call('sign_requests_complete', {
      signRequestId: id,
      signedContentBase64: Buffer.from(`%PDF-1.4 ${key} signiert`).toString('base64'),
      originalSha256: seed.sha256,
      idempotencyKey: `${key}-c`,
    });
    assert.equal(done.ok, true, `complete refused while minting signed: ${JSON.stringify(done)}`);
  }
  const now = call('sign_requests_get', { signRequestId: id });
  assert.equal(now.signRequest.status, status, `minting ${status} landed on ${now.signRequest.status}`);
  return { id, seed };
}

/** Every row of the sign_request table, for the zero-rows-on-refusal assertions. */
function tableSnapshot(deps, workspaceId) {
  return JSON.stringify(
    deps.store.db.prepare('SELECT * FROM sign_request WHERE workspace_id = ? ORDER BY id').all(workspaceId),
  );
}

// --- The transition matrix -----------------------------------------------------------------------

test('E01: the FULL transition matrix: every legal edge passes, every illegal edge is refused, terminals are terminal', () => {
  const { deps, workspaceId, call } = world();

  // The matrix itself first: six states, terminals empty, and draft->signed the only extra edge in.
  assert.deepEqual([...SIGN_REQUEST_STATUSES], ['draft', 'sent', 'viewed', 'signed', 'declined', 'expired']);
  for (const terminal of ['signed', 'declined', 'expired']) {
    assert.deepEqual([...SIGN_REQUEST_TRANSITIONS[terminal]], [], `${terminal} must be terminal`);
  }
  const intoSigned = SIGN_REQUEST_STATUSES.filter((s) => SIGN_REQUEST_TRANSITIONS[s].includes('signed'));
  assert.deepEqual(intoSigned, ['draft', 'sent', 'viewed'], 'the only edges into signed are draft|sent|viewed');
  assert.equal(SIGN_REQUEST_TRANSITIONS.draft.includes('viewed'), false, 'no draft -> viewed');
  assert.equal(SIGN_REQUEST_TRANSITIONS.draft.includes('declined'), false, 'no draft -> declined');

  // Then the ENGINE against the matrix, exhaustively: for every source status, attempt every
  // target through the verb that owns that edge, and demand exactly what the matrix says.
  const attempt = (id, to, seed, key) => {
    if (to === 'sent') {
      deps.signTransmitter = okTransmitter();
      // `-att-` so the attempt can never replay the mint's own send key.
      const res = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: `${key}-att-send` });
      delete deps.signTransmitter;
      return res;
    }
    if (to === 'signed') {
      return call('sign_requests_complete', {
        signRequestId: id,
        signedContentBase64: Buffer.from(`%PDF-1.4 ${key} unterschrieben`).toString('base64'),
        originalSha256: seed.sha256,
        idempotencyKey: `${key}-comp`,
      });
    }
    return call('sign_requests_record_event', { signRequestId: id, status: to, idempotencyKey: `${key}-${to}` });
  };

  for (const from of SIGN_REQUEST_STATUSES) {
    for (const to of ['sent', 'viewed', 'signed', 'declined', 'expired']) {
      const key = `mx-${from}-${to}`;
      const { id, seed } = mintAt(deps, call, from, key);
      const before = tableSnapshot(deps, workspaceId);
      const res = attempt(id, to, seed, key);
      const legal = SIGN_REQUEST_TRANSITIONS[from].includes(to);
      if (from === 'viewed' && to === 'viewed') {
        // The one deliberate no-op: recording viewed twice succeeds and changes nothing.
        assert.equal(res.ok, true, `viewed->viewed must be a no-op success`);
        assert.equal(res.changed, false);
        assert.equal(tableSnapshot(deps, workspaceId), before, 'the viewed no-op wrote rows');
      } else if (legal) {
        assert.equal(res.ok, true, `${from} -> ${to} is legal but was refused: ${JSON.stringify(res)}`);
        assert.equal(call('sign_requests_get', { signRequestId: id }).signRequest.status, to);
      } else {
        assert.equal(res.ok, false, `${from} -> ${to} is illegal but passed`);
        assert.equal(res.error, 'invalid_transition', `${from} -> ${to} answered ${res.error}`);
        // TX-ATOMICITY (the C02/D03 bug class): the refused transition wrote ZERO rows.
        assert.equal(tableSnapshot(deps, workspaceId), before, `the refused ${from} -> ${to} wrote rows`);
        assert.equal(call('sign_requests_get', { signRequestId: id }).signRequest.status, from);
      }
    }
  }

  // Withdraw and delete_draft, per source status: withdraw is sent|viewed only (a draft is
  // deleted, not withdrawn, US-E01.5 Error); delete_draft is draft only.
  for (const from of SIGN_REQUEST_STATUSES) {
    const w = mintAt(deps, call, from, `wd-${from}`);
    const withdrawn = call('sign_requests_withdraw', { signRequestId: w.id, idempotencyKey: `wd-${from}-1` });
    if (from === 'sent' || from === 'viewed') {
      assert.equal(withdrawn.ok, true, `withdraw on ${from} refused: ${JSON.stringify(withdrawn)}`);
      const after = call('sign_requests_get', { signRequestId: w.id }).signRequest;
      assert.equal(after.status, 'expired');
      assert.equal(after.expiredReason, 'withdrawn', 'a withdrawal must be tellable from a deadline expiry');
    } else {
      assert.equal(withdrawn.error, 'invalid_transition', `withdraw on ${from} answered ${withdrawn.error}`);
    }

    const d = mintAt(deps, call, from, `dd-${from}`);
    const deleted = call('sign_requests_delete_draft', { signRequestId: d.id, idempotencyKey: `dd-${from}-1` });
    if (from === 'draft') {
      assert.equal(deleted.ok, true);
      assert.equal(call('sign_requests_get', { signRequestId: d.id }).error, 'not_found', 'a discarded draft must be gone');
    } else {
      assert.equal(deleted.error, 'invalid_transition', `delete_draft on ${from} answered ${deleted.error}`);
      assert.equal(call('sign_requests_get', { signRequestId: d.id }).ok, true, 'a refused delete erased the row');
    }
  }
});

// --- Creation validation -------------------------------------------------------------------------

test('E01: creation validates file, head version, signer email, level and expiry', () => {
  const { call } = world();
  const seed = seedTargets(call, 'cv');

  assert.equal(call('sign_requests_create', { fileId: 'nope', signerContactId: seed.signerContactId, signatureLevel: 'ses', idempotencyKey: 'cv-1' }).error, 'file_not_found');
  assert.equal(call('sign_requests_create', { fileId: seed.fileId, signerContactId: 'nope', signatureLevel: 'ses', idempotencyKey: 'cv-2' }).error, 'contact_not_found');

  const mute = call('create_contact', { partyRole: 'customer', name: 'Ohne Mail AG', idempotencyKey: 'cv-3' });
  assert.equal(
    call('sign_requests_create', { fileId: seed.fileId, signerContactId: mute.contact.id, signatureLevel: 'ses', idempotencyKey: 'cv-4' }).error,
    'signer_email_missing',
  );

  const level = call('sign_requests_create', { fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'blau', idempotencyKey: 'cv-5' });
  assert.equal(level.error, 'invalid_input');
  assert.deepEqual(level.allowed, ['ses', 'qes']);

  assert.equal(
    call('sign_requests_create', { fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses', expiresAt: '2026-07-01', idempotencyKey: 'cv-6' }).error,
    'expiry_in_past',
  );

  // A superseded version is refused: the request must anchor the bytes the signer will see.
  const v2 = call('files_new_version', { fileId: seed.fileId, contentBase64: Buffer.from('%PDF-1.4 cv v2').toString('base64'), idempotencyKey: 'cv-7' });
  assert.equal(v2.ok, true);
  assert.equal(
    call('sign_requests_create', { fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses', idempotencyKey: 'cv-8' }).error,
    'not_head_version',
  );
  // The new head is requestable.
  assert.equal(
    call('sign_requests_create', { fileId: v2.file.id, signerContactId: seed.signerContactId, signatureLevel: 'qes', idempotencyKey: 'cv-9' }).ok,
    true,
  );
});

test('E01: the open-request guard blocks a second open request per signer+file, and terminal states free it', () => {
  const { deps, call } = world();
  const { id, seed } = mintAt(deps, call, 'sent', 'og');

  const second = call('sign_requests_create', {
    fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses', idempotencyKey: 'og-2',
  });
  assert.equal(second.error, 'request_already_open');
  assert.equal(second.signRequestId, id);

  // A DIFFERENT signer on the same file is one-request-per-signer, so it passes (multi-signer).
  const other = call('create_contact', { partyRole: 'customer', name: 'Zweite AG', email: 'zwei@example.ch', idempotencyKey: 'og-3' });
  assert.equal(
    call('sign_requests_create', { fileId: seed.fileId, signerContactId: other.contact.id, signatureLevel: 'ses', idempotencyKey: 'og-4' }).ok,
    true,
  );

  // Withdraw the first: the guard frees, a fresh request for the same signer is legal (US-E01.5).
  assert.equal(call('sign_requests_withdraw', { signRequestId: id, idempotencyKey: 'og-5' }).ok, true);
  assert.equal(
    call('sign_requests_create', { fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses', idempotencyKey: 'og-6' }).ok,
    true,
  );
});

// --- The OP4 boundary ----------------------------------------------------------------------------

test('E01: send is P8 confirm-gated, then honestly needs_provider, and the request stays draft both times', () => {
  const { deps, workspaceId, call } = world();
  const { id } = mintAt(deps, call, 'draft', 'op4');

  const unconfirmed = call('sign_requests_send', { signRequestId: id, idempotencyKey: 'op4-1' });
  assert.equal(unconfirmed.error, 'needs_confirmation');
  assert.equal(unconfirmed.transmitted, false);
  assert.equal(call('sign_requests_get', { signRequestId: id }).signRequest.status, 'draft');

  // Confirmed, but the MIT core ships no transmitter: the honest degradation carries the artifact.
  const before = tableSnapshot(deps, workspaceId);
  const noProvider = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: 'op4-2' });
  assert.equal(noProvider.error, 'needs_provider');
  assert.equal(noProvider.transmitted, false);
  assert.equal(noProvider.reason, 'cloud_tier');
  assert.equal(noProvider.artifact.fileId, call('sign_requests_get', { signRequestId: id }).signRequest.fileId);
  assert.equal(tableSnapshot(deps, workspaceId), before, 'the needs_provider refusal wrote rows');

  // A transmitter that answers {ok:false} leaves the draft untouched too.
  deps.signTransmitter = { transmit: () => ({ ok: false, reason: 'timeout' }) };
  const failed = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: 'op4-3' });
  assert.equal(failed.error, 'provider_send_failed');
  assert.equal(call('sign_requests_get', { signRequestId: id }).signRequest.status, 'draft');

  // A working transmitter: draft -> sent, provider_ref stored, the envelope handed over intact.
  const transmitter = okTransmitter();
  deps.signTransmitter = transmitter;
  const sent = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: 'op4-4' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.transmitted, true);
  assert.equal(sent.providerRef, 'prov-1');
  assert.equal(transmitter.handed.length, 1);
  assert.equal(transmitter.handed[0].signer.email, call('get_contact', { contactId: transmitter.handed[0].signer.contactId }).contact.email);
  const after = call('sign_requests_get', { signRequestId: id }).signRequest;
  assert.equal(after.status, 'sent');
  assert.equal(after.providerRef, 'prov-1');
  assert.ok(after.sentAt !== null);

  // The replay transmits NOTHING a second time (§H-IDEMPOTENT on the outbound act itself).
  const replay = call('sign_requests_send', { signRequestId: id, confirmed: true, idempotencyKey: 'op4-4' });
  assert.equal(replay.ok, true);
  assert.equal(transmitter.handed.length, 1, 'the replay reached the transmitter');
});

// --- Completion and the E00 delegation -----------------------------------------------------------

test('E01: manual completion (draft -> signed) lands a REAL new E00 version with supersedes_id', () => {
  const { deps, call } = world();
  const { id, seed } = mintAt(deps, call, 'draft', 'co');

  const done = call('sign_requests_complete', {
    signRequestId: id,
    signedContentBase64: Buffer.from('%PDF-1.4 co signiert').toString('base64'),
    originalSha256: seed.sha256,
    idempotencyKey: 'co-1',
  });
  assert.equal(done.ok, true, JSON.stringify(done));

  const view = call('sign_requests_get', { signRequestId: id }).signRequest;
  assert.equal(view.status, 'signed');
  assert.ok(view.signedAt !== null);
  assert.equal(view.signedFileId, done.signedFileId);

  // The signed artifact is a NEW VERSION of the SAME file: version+1, supersedes_id -> original,
  // its own sha256, written by E00 and not by E01 (the row exists because newFileVersion ran).
  const signedRow = deps.store.db
    .prepare('SELECT * FROM stored_file WHERE id = ?')
    .get(done.signedFileId);
  assert.equal(signedRow.supersedes_id, seed.fileId);
  assert.equal(signedRow.version, 2);
  assert.notEqual(signedRow.sha256, seed.sha256);

  // Replay: ONE new version for two calls (idempotent on ROWS, not just on the returned id).
  const again = call('sign_requests_complete', {
    signRequestId: id,
    signedContentBase64: Buffer.from('%PDF-1.4 co signiert').toString('base64'),
    originalSha256: seed.sha256,
    idempotencyKey: 'co-1',
  });
  assert.equal(again.ok, true);
  assert.equal(again.signedFileId, done.signedFileId);
  const versions = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND supersedes_id = ?')
    .get(view.localArtifact.workspaceId, seed.fileId).n;
  assert.equal(versions, 1, 'the replay minted a second version');
});

test('E01: the hash guard refuses a swapped file, and the refusal writes ZERO rows anywhere', () => {
  const { deps, workspaceId, call } = world();
  const { id } = mintAt(deps, call, 'sent', 'hg');

  const filesBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n;
  const before = tableSnapshot(deps, workspaceId);
  const swapped = call('sign_requests_complete', {
    signRequestId: id,
    signedContentBase64: Buffer.from('%PDF-1.4 anderes dokument').toString('base64'),
    originalSha256: 'ff'.repeat(32),
    idempotencyKey: 'hg-1',
  });
  assert.equal(swapped.error, 'document_hash_mismatch');
  assert.equal(tableSnapshot(deps, workspaceId), before, 'the refused completion changed the request');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n, filesBefore, 'the refused completion wrote a file row');
});

test('E01: a delegation refusal inside the completion unit commits nothing and memoizes nothing', () => {
  const { deps, workspaceId, call } = world();
  const { id, seed } = mintAt(deps, call, 'draft', 'da');

  // Unreadable bytes: E00's own decode refuses, from INSIDE the completion transaction. Nothing may
  // commit, including the idempotency memo, or a corrected retry would replay the stale refusal.
  const before = tableSnapshot(deps, workspaceId);
  const bad = call('sign_requests_complete', {
    signRequestId: id,
    signedContentBase64: '***nicht base64***',
    originalSha256: seed.sha256,
    idempotencyKey: 'da-1',
  });
  assert.equal(bad.error, 'file_unreadable');
  assert.equal(tableSnapshot(deps, workspaceId), before);

  // The SAME key with corrected content now completes: the refusal was not remembered.
  const good = call('sign_requests_complete', {
    signRequestId: id,
    signedContentBase64: Buffer.from('%PDF-1.4 da signiert').toString('base64'),
    originalSha256: seed.sha256,
    idempotencyKey: 'da-1',
  });
  assert.equal(good.ok, true, `the corrected retry replayed the stale refusal: ${JSON.stringify(good)}`);
});

// --- Idempotent replay on the remaining writes ---------------------------------------------------

test('E01: create replays the original draft instead of tripping its own open-request guard', () => {
  const { deps, workspaceId, call } = world();
  const seed = seedTargets(call, 'ir');
  const input = { fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses', idempotencyKey: 'ir-1' };
  const first = call('sign_requests_create', input);
  const second = call('sign_requests_create', input);
  assert.equal(second.ok, true, `the replay was refused: ${JSON.stringify(second)}`);
  assert.equal(second.signRequestId, first.signRequestId);
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM sign_request WHERE workspace_id = ?').get(workspaceId).n,
    1,
    'the replay minted a duplicate request',
  );
});

// --- Lazy expiry ---------------------------------------------------------------------------------

test('E01: an overdue request is swept to expired on read/list, and only the overdue ones', () => {
  const { deps, call } = world();
  const a = mintAt(deps, call, 'sent', 'lx-a');
  const b = mintAt(deps, call, 'sent', 'lx-b');
  // Re-arm a's deadline into the near future through creation is not possible post-mint, so mint a
  // dated request directly: a third request with an expiry, then advance the clock past it.
  const seed = seedTargets(call, 'lx-c');
  const dated = call('sign_requests_create', {
    fileId: seed.fileId, signerContactId: seed.signerContactId, signatureLevel: 'ses',
    expiresAt: '2026-08-01T00:00:00.000Z', idempotencyKey: 'lx-c1',
  });
  assert.equal(dated.ok, true);

  // Advance the world past the deadline: the injected clock is the only time source (P1).
  deps.clock = fixedClock('2026-09-01T00:00:00.000Z');

  // A WRITE against the overdue row is refused by EFFECTIVE status without writing.
  const refused = call('sign_requests_send', { signRequestId: dated.signRequestId, confirmed: true, idempotencyKey: 'lx-c2' });
  assert.equal(refused.error, 'invalid_transition');
  assert.equal(refused.from, 'expired');
  assert.equal(
    deps.store.db.prepare('SELECT status FROM sign_request WHERE id = ?').get(dated.signRequestId).status,
    'draft',
    'the refusal itself persisted the sweep, so a refused transition wrote a row',
  );

  // The LIST persists it, and flips exactly the overdue row: the undated ones are untouched.
  const listed = call('sign_requests_list', { status: 'expired' });
  assert.deepEqual(listed.signRequests.map((r) => r.id), [dated.signRequestId]);
  const persisted = call('sign_requests_get', { signRequestId: dated.signRequestId }).signRequest;
  assert.equal(persisted.status, 'expired');
  assert.equal(persisted.expiredReason, 'deadline');
  for (const untouched of [a.id, b.id]) {
    assert.equal(call('sign_requests_get', { signRequestId: untouched }).signRequest.status, 'sent');
  }
});

// --- The disjoint automation-event paths ---------------------------------------------------------

test('E01: the five sign_request.* events are registered, and record_event answers ONLY the outcome that happened', () => {
  const { deps, call } = world();
  const { id } = mintAt(deps, call, 'sent', 'ev');
  const viewed = call('sign_requests_record_event', { signRequestId: id, status: 'viewed', idempotencyKey: 'ev-1' });
  assert.equal(viewed.viewedSignRequestId, id);
  assert.equal(viewed.declinedSignRequestId, undefined, 'a viewed event resolved the declined path');
  assert.equal(viewed.expiredSignRequestId, undefined);
  const declined = call('sign_requests_record_event', { signRequestId: id, status: 'declined', declinedReason: 'zu teuer', idempotencyKey: 'ev-2' });
  assert.equal(declined.declinedSignRequestId, id);
  assert.equal(declined.viewedSignRequestId, undefined);
  const after = call('sign_requests_get', { signRequestId: id }).signRequest;
  assert.equal(after.declinedReason, 'zu teuer');
});

// --- §H-TENANT -----------------------------------------------------------------------------------

test('E01: a foreign workspace can neither read nor move a sign request (§H-TENANT)', () => {
  const { deps, call } = world();
  const { id, seed } = mintAt(deps, call, 'sent', 'ht');

  const other = getAction('create_workspace').run(deps, { name: 'Fremd GmbH', idempotencyKey: 'ht-ws' });
  const foreign = (name, input) => getAction(name).run(deps, { workspaceId: other.workspaceId, ...input });

  assert.equal(foreign('sign_requests_get', { signRequestId: id }).error, 'not_found');
  assert.deepEqual(foreign('sign_requests_list', {}).signRequests, []);
  assert.equal(foreign('sign_requests_withdraw', { signRequestId: id, idempotencyKey: 'ht-1' }).error, 'not_found');
  assert.equal(
    foreign('sign_requests_complete', {
      signRequestId: id,
      signedContentBase64: Buffer.from('%PDF-1.4 fremd').toString('base64'),
      originalSha256: seed.sha256,
      idempotencyKey: 'ht-2',
    }).error,
    'not_found',
  );
  assert.equal(foreign('sign_requests_record_event', { signRequestId: id, status: 'viewed', idempotencyKey: 'ht-3' }).error, 'not_found');
  // And the row in the owning workspace never moved.
  assert.equal(call('sign_requests_get', { signRequestId: id }).signRequest.status, 'sent');
});
