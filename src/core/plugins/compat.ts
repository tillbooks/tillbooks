/**
 * The compat contract (spec §4): resolve a manifest's `compat_range` against `CORE_CONTRACT_VERSION`
 * with STANDARD semver range semantics (exact, caret, tilde, comparator sets, x-ranges, OR sets).
 *
 * A FOCUSED PURE COMPARATOR RATHER THAN THE `semver` PACKAGE, on purpose. The engine ships exactly
 * two runtime dependencies (`better-sqlite3`, the MCP SDK); `semver` is present only transitively, and
 * a clean-room MIT accounting engine should not grow a range dependency it can express in forty lines.
 * Being pure and self-contained is also what lets spec §8's table test exercise every range shape
 * against a fuzzed `CORE_CONTRACT_VERSION` with no database and no I/O.
 *
 * SCOPE: MAJOR.MINOR.PATCH only. Prerelease/build metadata is not modelled, because a plugin compat
 * range never needs it and admitting it would widen the surface a critic has to trust. A version or
 * comparand carrying anything past the third numeric segment is rejected as unparseable, which fails
 * CLOSED (an unreadable range is treated as not-satisfied, so a malformed manifest degrades to
 * `incompatible`, never to accidentally-compatible).
 */

type Triple = readonly [number, number, number];

/** Parse `MAJOR.MINOR.PATCH` into a numeric triple, or `null` when it is not a clean version. */
export function parseVersion(v: unknown): Triple | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) return null;
  const maj = m[1];
  const min = m[2];
  const pat = m[3];
  if (maj === undefined || min === undefined || pat === undefined) return null;
  return [Number(maj), Number(min), Number(pat)];
}

function cmp(a: Triple, b: Triple): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

interface Comparator {
  op: '<' | '<=' | '>' | '>=' | '=';
  v: Triple;
}

/** Is `n` a run of digits (an x-range segment is `x`, `X`, `*`, or absent)? */
function isNumeric(seg: string | undefined): seg is string {
  return seg !== undefined && /^\d+$/.test(seg);
}

/**
 * Expand one range TOKEN (a single comparator, a caret/tilde range, an x-range, or a bare version)
 * into the primitive `>=`/`<`/`=` comparators it stands for. Returns `null` when the token is
 * unparseable, which propagates to "not satisfied" (fail closed).
 */
function expandToken(token: string): Comparator[] | null {
  const t = token.trim();
  if (t === '' || t === '*' || t === 'x' || t === 'X') return []; // matches anything

  const opMatch = /^(<=|>=|<|>|=)\s*(.+)$/.exec(t);
  if (opMatch !== null) {
    const op = opMatch[1] as Comparator['op'];
    const v = parseVersion(opMatch[2]);
    if (v === null) return null;
    return [{ op, v }];
  }

  const caret = t.startsWith('^');
  const tilde = t.startsWith('~');
  const body = caret || tilde ? t.slice(1) : t;
  const parts = body.split('.');
  const majS = parts[0];
  const minS = parts[1];
  const patS = parts[2];

  // An x-range or partial version (e.g. `1`, `1.2`, `1.x`) with no caret/tilde: [floor, next).
  const partial = !isNumeric(patS) || !isNumeric(minS);
  if (!caret && !tilde && partial) {
    // A lone `x`/`X`/`*` major was already handled as match-anything above; anything else non-numeric
    // here is garbage, so it is unparseable (fail closed), never a silent match-all.
    if (!isNumeric(majS)) return null;
    const maj = Number(majS);
    if (!isNumeric(minS)) {
      return [{ op: '>=', v: [maj, 0, 0] }, { op: '<', v: [maj + 1, 0, 0] }];
    }
    const min = Number(minS);
    return [{ op: '>=', v: [maj, min, 0] }, { op: '<', v: [maj, min + 1, 0] }];
  }

  if (!isNumeric(majS)) return null;
  const maj = Number(majS);
  const min = isNumeric(minS) ? Number(minS) : 0;
  const pat = isNumeric(patS) ? Number(patS) : 0;
  const floor: Triple = [maj, min, pat];

  if (tilde) {
    // ~1.2.3 -> >=1.2.3 <1.3.0 ; ~1.2 -> >=1.2.0 <1.3.0 ; ~1 -> >=1.0.0 <2.0.0
    const upper: Triple = isNumeric(minS) ? [maj, min + 1, 0] : [maj + 1, 0, 0];
    return [{ op: '>=', v: floor }, { op: '<', v: upper }];
  }
  if (caret) {
    // ^ allows changes that do not modify the left-most NON-ZERO segment.
    let upper: Triple;
    if (maj > 0) upper = [maj + 1, 0, 0];
    else if (min > 0) upper = [0, min + 1, 0];
    else upper = [0, 0, pat + 1];
    return [{ op: '>=', v: floor }, { op: '<', v: upper }];
  }
  // A bare exact version.
  return [{ op: '=', v: floor }];
}

function satisfiesOne(version: Triple, c: Comparator): boolean {
  const r = cmp(version, c.v);
  switch (c.op) {
    case '<':
      return r < 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '>=':
      return r >= 0;
    case '=':
      return r === 0;
  }
}

/**
 * Does `version` satisfy `range`? `range` is one or more comparator SETS separated by `||` (OR);
 * within a set, whitespace-separated comparators are AND-ed. An unparseable version or range is
 * NOT satisfied (fail closed).
 */
export function satisfies(version: unknown, range: unknown): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  if (typeof range !== 'string') return false;
  const orSets = range.split('||');
  for (const set of orSets) {
    const tokens = set.trim().split(/\s+/).filter((t) => t.length > 0);
    // An empty set (e.g. the range was just whitespace) matches anything.
    if (tokens.length === 0) return true;
    let all = true;
    for (const token of tokens) {
      const comps = expandToken(token);
      if (comps === null) {
        all = false;
        break;
      }
      for (const c of comps) {
        if (!satisfiesOne(v, c)) {
          all = false;
          break;
        }
      }
      if (!all) break;
    }
    if (all) return true;
  }
  return false;
}

/** Is `range` itself a well-formed range this comparator can read? Used to reject `invalid_manifest`. */
export function isValidRange(range: unknown): boolean {
  if (typeof range !== 'string') return false;
  let tokenCount = 0;
  const orSets = range.split('||');
  for (const set of orSets) {
    const tokens = set.trim().split(/\s+/).filter((t) => t.length > 0);
    for (const token of tokens) {
      if (expandToken(token) === null) return false;
      tokenCount += 1;
    }
  }
  // An empty range (`''` or whitespace) is NOT a valid manifest range: it would mean "compatible with
  // everything", a silent loosening a manifest must state deliberately as `*` if it means it.
  return tokenCount > 0;
}
