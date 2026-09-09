/**
 * E04's two §H-ENUM points, single-sourced here so no adapter, verb, or surface redeclares them.
 *
 * `MAIL_ADAPTERS` is the closed set of local stores TILL can read. Adding an adapter is one enum
 * line + one module + a fixture (spec §4) and adds no verb. There is deliberately no `imap`, no
 * `gmail`, no provider of any kind: an adapter reads a FILE another application already wrote, and
 * anything that would need a socket is out of scope permanently (OP6, spec §3).
 *
 * `MAIL_DIRECTIONS` is derived at index time (a message whose From matches the account address is
 * outbound, everything else inbound) and stored, because the needs-reply read model keys on it.
 */

export const MAIL_ADAPTERS = ['apple_mail', 'thunderbird'] as const;
export type MailAdapterKind = (typeof MAIL_ADAPTERS)[number];

export function isMailAdapter(value: unknown): value is MailAdapterKind {
  return typeof value === 'string' && (MAIL_ADAPTERS as readonly string[]).includes(value);
}

export const MAIL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

export function isMailDirection(value: unknown): value is MailDirection {
  return typeof value === 'string' && (MAIL_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The thread-queue buckets, derived AT QUERY TIME from newest-message direction versus newest
 * draft (P5, spec §2 US-E04.3): never a stored column, so they cannot go stale.
 */
export const MAIL_BUCKETS = ['needs_reply', 'drafted', 'done', 'recent', 'all'] as const;
export type MailBucket = (typeof MAIL_BUCKETS)[number];

export function isMailBucket(value: unknown): value is MailBucket {
  return typeof value === 'string' && (MAIL_BUCKETS as readonly string[]).includes(value);
}
