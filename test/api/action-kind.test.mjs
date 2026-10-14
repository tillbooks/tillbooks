// @ts-check
/**
 * D159/D160, THE REVERSIBILITY MAP ON THE REGISTRY: every write declares its class and its consequence tag
 * on its registration line (`write:<class>:<tag>`), and `ctxAction` / `depsAction` split it so
 * `ActionDef.kind` stays `'read' | 'write'` for every existing reader.
 *
 * What is held here: the split and its runtime refusal of a bare, untagged or malformed kind; that the
 * registry carries a class and a tag on every write and nothing on a read (the parity with the reviewed map
 * is `test/planning/reversibility-map-parity.test.mjs`, private because the map is); that the load assert bites on a hand-built unclassified write; that the
 * way-back map follows the D161 method rulings; and that the MCP tool takes `destructiveHint` and its
 * `_meta` from the declared class and tag. The negative TYPE test beside this is
 * `test/types/write-kind.neg.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction, listUnclassifiedWrites, assertEveryWriteIsClassified, splitActionKind } from '../../dist/api/registry.js';
import { toolFor, CONSEQUENCE_META_KEY, REVERSIBILITY_META_KEY, DESTRUCTIVE_DESPITE_CLASS } from '../../dist/api/mcp.js';
import { LAPSES_BY_ITSELF, SELF_CORRECTABLE, WAY_BACK, WAY_BACK_SELF, wayBackProblems } from '../../dist/core/agent/wayBack.js';
import { REVERSIBILITY_LEVELS } from '../../dist/core/agent/consequences.js';
import { CONSEQUENCE_TAGS, EXEMPT_CONSEQUENCE_TAGS, GATED_CONSEQUENCE_TAGS } from '../../dist/core/agent/consequenceTag.js';

test('split: a read carries nothing; write:<class>:<tag> splits into kind + reversibility + consequenceTag', () => {
  const read = splitActionKind('probe_read', 'read');
  assert.deepEqual(read, { kind: 'read' });
  assert.equal('reversibility' in read || 'consequenceTag' in read, false, 'a read carries no class or tag key at all');
  for (const level of REVERSIBILITY_LEVELS) {
    for (const tag of CONSEQUENCE_TAGS) {
      assert.deepEqual(splitActionKind('probe', `write:${level}:${tag}`), { kind: 'write', reversibility: level, consequenceTag: tag });
    }
  }
});

test('split: a bare, untagged or malformed kind THROWS, naming the verb', () => {
  const bad = [
    'write', 'write:final', 'write:maybe:books', 'write:final:money', 'write:final:', 'write::books', 'write:books:final',
    'Write:final:books', 'write:final:books ', 'write:final:books:extra', 'read:final:books', '', 'writes',
  ];
  for (const kind of bad) {
    assert.throws(
      // A plain-JS caller can pass anything; the cast is what such a caller would do.
      () => splitActionKind('probe_verb', /** @type {any} */ (kind)),
      (e) => e instanceof Error && e.message.includes("'probe_verb'") && e.message.includes('D159'),
      `${JSON.stringify(kind)} must be refused`,
    );
  }
  for (const kind of [undefined, null, 1, {}]) {
    assert.throws(() => splitActionKind('probe_verb', /** @type {any} */ (kind)), /probe_verb/);
  }
});

test('the tag unions are closed and disjoint: five gated tags (D160.1), six exemption reasons (D160.2)', () => {
  assert.deepEqual([...GATED_CONSEQUENCE_TAGS], ['books', 'statutory', 'outbound', 'access', 'erase']);
  assert.deepEqual([...EXEMPT_CONSEQUENCE_TAGS], ['internal', 'ui-state', 'derived', 'pre-workspace', 'stop', 'human-only']);
  assert.equal(new Set(CONSEQUENCE_TAGS).size, GATED_CONSEQUENCE_TAGS.length + EXEMPT_CONSEQUENCE_TAGS.length);
});

test('every write carries a class and a tag from the closed sets, and no read carries either', () => {
  for (const a of ACTIONS) {
    assert.ok(a.kind === 'read' || a.kind === 'write', `${a.name}: kind ${a.kind}`);
    if (a.kind === 'read') {
      assert.equal(a.reversibility, undefined, `${a.name}: a read carries no class`);
      assert.equal(a.consequenceTag, undefined, `${a.name}: a read carries no tag`);
      continue;
    }
    assert.ok(REVERSIBILITY_LEVELS.includes(/** @type {any} */ (a.reversibility)), `${a.name}: class ${a.reversibility}`);
    assert.ok(CONSEQUENCE_TAGS.includes(/** @type {any} */ (a.consequenceTag)), `${a.name}: tag ${a.consequenceTag}`);
  }
});

test('the load assert: no write is unclassified today, and a hand-built write without a class or tag throws', () => {
  assert.deepEqual(listUnclassifiedWrites(), []);
  assert.doesNotThrow(() => assertEveryWriteIsClassified(ACTIONS));

  const base = getAction('post_entry');
  assert.ok(base !== undefined && base.kind === 'write');
  const { reversibility: _r, consequenceTag: _t, ...bare } = base;
  const { reversibility: _r2, ...classless } = base;
  const { consequenceTag: _t2, ...tagless } = base;
  const noClass = { ...classless, name: 'probe_no_class' };
  const noTag = { ...tagless, name: 'probe_no_tag' };
  const taggedRead = { ...base, name: 'probe_tagged_read', kind: /** @type {const} */ ('read') };
  const plainRead = { ...bare, name: 'probe_read', kind: /** @type {const} */ ('read') };
  assert.deepEqual(listUnclassifiedWrites([base, { ...bare, name: 'probe_bare' }, noClass, noTag, plainRead]), ['probe_bare', 'probe_no_class', 'probe_no_tag']);
  assert.throws(() => assertEveryWriteIsClassified([...ACTIONS, { ...bare, name: 'probe_bare' }]), /probe_bare: a write without/);
  assert.throws(() => assertEveryWriteIsClassified([noTag]), /probe_no_tag/);
  assert.throws(() => assertEveryWriteIsClassified([taggedRead]), /probe_tagged_read: a read carries no/);
  assert.doesNotThrow(() => assertEveryWriteIsClassified([base, plainRead]));
});

test('the way-back map is sound: every reversible and correctable write has one, no final write does', () => {
  assert.deepEqual(wayBackProblems(ACTIONS), []);
  for (const a of ACTIONS.filter((x) => x.kind === 'write')) {
    const ways = WAY_BACK[a.name];
    if (a.reversibility === 'final') assert.equal(ways, undefined, `${a.name}: a final write lists no way back`);
    else assert.ok(Array.isArray(ways), `${a.name}: a ${a.reversibility} write names its way back`);
  }
  // The explicit empty way back belongs to the lapsing upload sessions alone.
  const empty = Object.entries(WAY_BACK).filter(([, ways]) => ways.length === 0).map(([verb]) => verb).sort();
  assert.deepEqual(empty, [...LAPSES_BY_ITSELF].sort());
  // `'self'` on a correctable write only where it is marked.
  for (const [verb, ways] of Object.entries(WAY_BACK)) {
    if (ways.includes(WAY_BACK_SELF) && getAction(verb)?.reversibility === 'correctable') {
      assert.ok(SELF_CORRECTABLE.includes(verb), `${verb}: a correctable 'self' is marked`);
    }
  }
});

test('way-back check: each D161 ruling bites on a fixture', () => {
  /** @type {import('../../dist/core/agent/wayBack.js').WayBackAction[]} */
  const actions = [
    { name: 'a_set', kind: 'write', reversibility: 'reversible' },
    { name: 'a_post', kind: 'write', reversibility: 'correctable' },
    { name: 'a_reverse', kind: 'write', reversibility: 'correctable' },
    { name: 'a_note', kind: 'write', reversibility: 'correctable' },
    { name: 'a_upload', kind: 'write', reversibility: 'reversible' },
    { name: 'a_send', kind: 'write', reversibility: 'final' },
    { name: 'a_read', kind: 'read' },
  ];
  const marks = { selfCorrectable: ['a_note'], lapsesByItself: ['a_upload'] };
  const sound = { a_set: [WAY_BACK_SELF], a_post: ['a_reverse'], a_reverse: ['a_post'], a_note: [WAY_BACK_SELF], a_upload: [] };
  assert.deepEqual(wayBackProblems(actions, sound, marks), []);

  /** @type {[Record<string, string[]>, { selfCorrectable: string[], lapsesByItself: string[] }, RegExp][]} */
  const cases = [
    // every named verb exists and is a write
    [{ ...sound, nope: ['a_reverse'] }, marks, /nope: not a registered write/],
    [{ ...sound, a_read: ['a_reverse'] }, marks, /a_read: not a registered write/],
    [{ ...sound, a_post: ['nope'] }, marks, /way back 'nope' is not a registered write/],
    [{ ...sound, a_post: ['a_read'] }, marks, /way back 'a_read' is not a registered write/],
    [{ ...sound, a_post: ['a_post'] }, marks, /names itself/],
    [{ ...sound, a_post: ['a_reverse', 'a_reverse'] }, marks, /same way back twice/],
    // 'self': a reversible setter, or a marked correctable write, and nothing else
    [{ ...sound, a_post: [WAY_BACK_SELF] }, marks, /a_post: 'self' is only for a write classed reversible, or a correctable one in SELF_CORRECTABLE/],
    [sound, { ...marks, selfCorrectable: [] }, /a_note: 'self' is only for/],
    [sound, { ...marks, selfCorrectable: ['a_note', 'a_set'] }, /a_set: in SELF_CORRECTABLE, but not a correctable write/],
    // an explicit empty way back only for a lapsing upload session
    [{ ...sound, a_post: [] }, marks, /a_post: an empty way back, which only an upload session that lapses by itself may carry/],
    [sound, { ...marks, lapsesByItself: [] }, /a_upload: an empty way back/],
    [sound, { ...marks, lapsesByItself: ['a_upload', 'a_set'] }, /a_set: in LAPSES_BY_ITSELF, but not a write with an explicit empty way back/],
    // a final write lists nothing, not even an empty list
    [{ ...sound, a_send: ['a_reverse'] }, marks, /a_send: classed final, yet has a way-back entry/],
    [{ ...sound, a_send: [] }, marks, /a_send: classed final, yet has a way-back entry/],
    // every reversible and correctable write has a way back
    [(({ a_reverse: _drop, ...rest }) => rest)(sound), marks, /a_reverse: classed correctable, yet has no way back/],
    [(({ a_set: _drop, ...rest }) => rest)(sound), marks, /a_set: classed reversible, yet has no way back/],
  ];
  for (const [map, m, pattern] of cases) {
    const problems = wayBackProblems(actions, map, m);
    assert.ok(problems.some((p) => pattern.test(p)), `${JSON.stringify(map)} ${JSON.stringify(m)}: expected ${pattern}, got ${JSON.stringify(problems)}`);
  }
  assert.ok(
    wayBackProblems([...actions, { name: 'a_bare', kind: 'write' }], sound, marks).some((p) => /a_bare: an unclassified write/.test(p)),
    'an unclassified write is named',
  );
});

test('MCP: every write takes destructiveHint, the reversibility key and the consequence tag from its own declaration; reads are untouched', () => {
  for (const a of ACTIONS) {
    const tool = /** @type {any} */ (toolFor(a));
    if (a.kind === 'read') {
      assert.deepEqual(tool.annotations, { readOnlyHint: true }, `${a.name}: a read`);
      assert.equal(tool._meta, undefined, `${a.name}: a read carries no class and no consequence`);
      continue;
    }
    // MCP: `destructiveHint: false` means additive-only, which only an append-only `correctable` write is.
    // Critic B1: a correctable write with a non-additive edge (DESTRUCTIVE_DESPITE_CLASS) claims nothing either.
    assert.equal(tool.annotations.destructiveHint, a.reversibility !== 'correctable' || DESTRUCTIVE_DESPITE_CLASS[a.name] !== undefined, `${a.name}: destructiveHint`);
    assert.equal(tool._meta[REVERSIBILITY_META_KEY], a.reversibility, `${a.name}: _meta reversibility`);
    const consequence = tool._meta[CONSEQUENCE_META_KEY];
    assert.equal(consequence.tag, a.consequenceTag, `${a.name}: _meta consequence tag`);
    assert.ok(CONSEQUENCE_TAGS.includes(consequence.tag), `${a.name}: a closed tag`);
    if (consequence.en !== undefined) assert.equal(consequence.reversibility, a.reversibility, `${a.name}: the sentence rides with the declared class`);
  }
});

test('DESTRUCTIVE_DESPITE_CLASS names only correctable writes, each with its reason, and transition_document is one (critic B1)', () => {
  for (const [verb, why] of Object.entries(DESTRUCTIVE_DESPITE_CLASS)) {
    const a = ACTIONS.find((x) => x.name === verb);
    assert.ok(a && a.kind === 'write' && a.reversibility === 'correctable', `${verb}: a correctable write (any other class is destructive already)`);
    assert.ok(typeof why === 'string' && why.length > 20, `${verb}: the reason in words`);
    assert.equal(/** @type {any} */ (toolFor(a)).annotations.destructiveHint, true, `${verb}: advertised as destructive`);
  }
  assert.ok(DESTRUCTIVE_DESPITE_CLASS.transition_document, 'the quote accepted edge (final) and the draft-deleting cancel edge');
});

test('MCP: a hand-built write with no class or tag is refused, never advertised with a guessed hint', () => {
  const base = getAction('post_entry');
  assert.ok(base !== undefined);
  const { reversibility: _r, ...classless } = base;
  const { consequenceTag: _t, ...tagless } = base;
  assert.throws(() => toolFor(classless), /post_entry/);
  assert.throws(() => toolFor(tagless), /post_entry/);
});
