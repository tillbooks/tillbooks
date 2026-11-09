/**
 * `displayName`: the one way to put a seat or an actor on screen (K-38, D137). Never a raw id.
 *
 * WHY. "user_1" stood in the first column of Aufgaben (8 times), Zeit (60), Perioden (531) and
 * Wareneingänge, because the engine stores the id and the surface printed it. Zugriff already knew
 * better ("Diese Installation", "MCP-Agent"); this lifts that knowledge out of the Members surface so
 * every surface names a seat the same way.
 *
 * THE ORDER, most specific first:
 *   1. a roster member matched by `userId` or `actorId`: their name, else their email;
 *   2. that member, when it is a seated actor with neither: the seat's own name ("Studio auf diesem
 *      Gerät", "MCP-Agent"), else "Diese Installation" (the local session identity);
 *   3. no roster row: a seated actor id by its seat name; a minted `user_<n>` as "Person <n>", so two
 *      unknown people still read as two; anything else as "Unbekannte Person".
 *
 * The raw id is never the label, but it is never lost either: `id` is returned beside the label, and
 * `resolved` says whether a real name was found, so a caller keeps the id as a tooltip exactly where
 * it helps (the `ActorLabel` pattern of `useMemberNames`).
 *
 * Pure: the caller hands in the roster (from `list_members`) and its `t`. The labels live in the
 * shared locale under `seat.*`.
 */

/** The roster fields this reads, the subset of `list_members` every surface already has. */
export interface SeatMember {
  readonly userId: string | null;
  readonly actorId: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
}

/** A seat, named for the screen. */
export interface SeatName {
  /** The raw id exactly as the engine stored it (empty for no id). Keep it as a tooltip, never a label. */
  readonly id: string;
  /** What the screen shows. Never the raw id. */
  readonly label: string;
  /** True when a person's name or email was found: the raw id then adds something as a tooltip. */
  readonly resolved: boolean;
}

/** The seated actors (D13) and their locale keys: transports, named for what they are. */
const SEATED_ACTOR_KEY: Readonly<Record<string, string>> = {
  studio: 'seat.studio',
  agent: 'seat.agent',
};

const MINTED_USER = /^user_(\d+)$/;

function nameOf(member: SeatMember): string | null {
  if (member.displayName !== null && member.displayName.trim() !== '') return member.displayName;
  if (member.email !== null && member.email.trim() !== '') return member.email;
  return null;
}

/** Name `id` for the screen from `members`. See the module doc for the order. */
export function displayName(
  id: string | null | undefined,
  members: readonly SeatMember[],
  t: (key: string, params?: Record<string, string | number>) => string,
): SeatName {
  if (id === null || id === undefined || id === '') return { id: '', label: '', resolved: false };

  const member = members.find((m) => m.userId === id || m.actorId === id);
  if (member !== undefined) {
    const name = nameOf(member);
    if (name !== null) return { id, label: name, resolved: true };
    const seatKey = member.actorId !== null ? SEATED_ACTOR_KEY[member.actorId] : undefined;
    return { id, label: t(seatKey ?? 'seat.local'), resolved: false };
  }

  const seatKey = SEATED_ACTOR_KEY[id];
  if (seatKey !== undefined) return { id, label: t(seatKey), resolved: false };
  const minted = MINTED_USER.exec(id);
  if (minted !== null) return { id, label: t('seat.person', { n: minted[1] as string }), resolved: false };
  return { id, label: t('seat.unknown'), resolved: false };
}
