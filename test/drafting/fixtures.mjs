/**
 * Deterministic E06 fixtures over the E04/E05 fixture shapes: a recording OP6 adapter (so a test
 * can assert what the PROMPT contained, which is how "no ledger fact reaches an ungrounded prompt"
 * becomes a measurement), and an inbound client message to draft against.
 */

import { rfc822 } from '../mail/fixtures.mjs';
import { stubAdapter } from '../voice/fixtures.mjs';

/**
 * A stub adapter whose `complete` RECORDS every prompt it is handed and answers a reply that
 * quotes the prompt's tail (so containment tests can prove that even a completion carrying source
 * material never reaches the database). Deterministic, offline, no socket.
 */
export function recordingAdapter() {
  const prompts = [];
  const adapter = stubAdapter({
    complete: (prompt) => {
      prompts.push(prompt);
      return `Guten Tag\r\nENTWURF ${prompts.length}: ${prompt.slice(-220)}\r\nFreundliche Grüsse`;
    },
  });
  return { adapter, prompts };
}

/** One inbound client message, its own thread, addressed to the fixture account. */
export function inboundAsk({
  id = 'ask-1@example.org',
  subject = 'Frage zur Rechnung',
  body = 'Guten Tag, wie ist der Stand meiner Rechnung? Freundliche Grüsse',
  clientAddress = 'klient@example.org',
  accountAddress = 'praxis@example.ch',
  date = 'Wed, 29 Jul 2026 08:00:00 +0200',
} = {}) {
  return {
    id,
    raw: rfc822({
      from: `Klient Muster <${clientAddress}>`,
      to: accountAddress,
      subject,
      messageId: id,
      date,
      body,
    }),
  };
}
