/**
 * Deterministic on-disk mail-store fixtures for the E04 suites (and for E05/E06 when they land).
 *
 * Every fixture is BUILT in a temp directory by the test that uses it, never checked in as binary
 * blobs: the store shapes are simple enough that constructing them is clearer than freezing them,
 * and a constructed store can be mutated mid-test (delete a message, edit a body) to drive the
 * self-healing and staleness assertions.
 */

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh, empty fixture root. */
export function tempStoreDir(prefix = 'till-mailstore-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build one raw RFC-5322 message. Header order is stable so hashes are deterministic per input. */
export function rfc822({ from, to, subject, messageId, inReplyTo, references, date, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date ?? 'Wed, 15 Jul 2026 09:00:00 +0200'}`,
    `Message-ID: <${messageId}>`,
  ];
  if (inReplyTo !== undefined) lines.push(`In-Reply-To: <${inReplyTo}>`);
  if (references !== undefined) lines.push(`References: ${references.map((r) => `<${r}>`).join(' ')}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8');
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * A Thunderbird Maildir store: `<root>/INBOX/{cur,new}` with one file per message. Returns the
 * file path of each written message keyed by its messageId, so a test can delete or mutate one.
 */
export function makeMaildirStore(root, messages, folder = 'INBOX') {
  const cur = join(root, folder, 'cur');
  mkdirSync(cur, { recursive: true });
  mkdirSync(join(root, folder, 'new'), { recursive: true });
  const paths = {};
  messages.forEach((message, i) => {
    const file = join(cur, `${1000 + i}.fixture:2,S`);
    writeFileSync(file, message.raw);
    paths[message.id] = file;
  });
  return paths;
}

/** A Thunderbird mbox store: one `INBOX` file under the root, `From `-separated. */
export function makeMboxStore(root, messages, name = 'INBOX') {
  const file = join(root, name);
  writeFileSync(file, '');
  for (const message of messages) {
    appendFileSync(file, `From - Thu Jul 16 00:00:00 2026\n${message.raw.replace(/^From /gm, '>From ')}\n\n`);
  }
  return file;
}

/** An Apple Mail store: `.emlx` files (length prefix + message) under a Messages directory. */
export function makeAppleMailStore(root, messages) {
  const dir = join(root, 'INBOX.mbox', 'Messages');
  mkdirSync(dir, { recursive: true });
  const paths = {};
  messages.forEach((message, i) => {
    const file = join(dir, `${i + 1}.emlx`);
    writeFileSync(file, `${Buffer.byteLength(message.raw, 'utf8')}\n${message.raw}`);
    paths[message.id] = file;
  });
  return paths;
}

/** The standing three-message world: two inbound from a client, one outbound reply in between. */
export function sampleMessages(accountAddress = 'praxis@example.ch', clientAddress = 'klient@example.org') {
  const first = rfc822({
    from: `Klient Muster <${clientAddress}>`,
    to: accountAddress,
    subject: 'Terminverschiebung',
    messageId: 'thread-1-msg-1@example.org',
    date: 'Mon, 13 Jul 2026 08:00:00 +0200',
    body: 'Guten Tag\r\nKönnen wir den Termin verschieben?\r\nFreundliche Grüsse',
  });
  const reply = rfc822({
    from: accountAddress,
    to: clientAddress,
    subject: 'Re: Terminverschiebung',
    messageId: 'thread-1-msg-2@example.ch',
    inReplyTo: 'thread-1-msg-1@example.org',
    references: ['thread-1-msg-1@example.org'],
    date: 'Mon, 13 Jul 2026 10:00:00 +0200',
    body: 'Guten Tag\r\nJa, das geht.\r\nFreundliche Grüsse',
  });
  const second = rfc822({
    from: `Klient Muster <${clientAddress}>`,
    to: accountAddress,
    subject: 'Re: Terminverschiebung',
    messageId: 'thread-1-msg-3@example.org',
    inReplyTo: 'thread-1-msg-2@example.ch',
    references: ['thread-1-msg-1@example.org', 'thread-1-msg-2@example.ch'],
    date: 'Tue, 14 Jul 2026 09:30:00 +0200',
    body: 'Danke! Passt Donnerstag 14 Uhr?',
  });
  const unrelated = rfc822({
    from: 'newsletter@verlag.example',
    to: accountAddress,
    subject: 'Fachzeitschrift Juli',
    messageId: 'newsletter-7@verlag.example',
    date: 'Wed, 15 Jul 2026 06:00:00 +0200',
    body: 'Die Juli-Ausgabe ist da.',
  });
  return [
    { id: 'thread-1-msg-1@example.org', raw: first },
    { id: 'thread-1-msg-2@example.ch', raw: reply },
    { id: 'thread-1-msg-3@example.org', raw: second },
    { id: 'newsletter-7@verlag.example', raw: unrelated },
  ];
}
