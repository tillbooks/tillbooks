/**
 * D160.5, defect 1: every plugin write that STARTS third-party code waits for a person.
 *
 * D160.1 (d) puts access and third-party code inside the approval boundary. `install_plugin` was
 * governed under `plugin-install` (a strong-default ask, D103), but `enable_plugin` was not: it
 * re-registers every capability of a disabled plugin and starts its sandbox, so an agent seat that a
 * person had stopped by disabling a plugin could start it again with no Vorschlag. Reproduced below over
 * the real transport seam before the fix: the agent's call answered `ok` with `status: 'installed'`.
 *
 * `refresh_plugin_compat` is the other road to the same place: a plugin that fell out of compat sits
 * `incompatible` with its capabilities swept and its process stopped, and a refresh that finds the
 * range satisfied again (after a core update) re-registers it and starts it. That is an enable by
 * another name, so it is governed the same way. D161.1 (owner, 11.10.2026) adds `uninstall_plugin`, an
 * access verb: it stops the code and deletes the manifest with its grants for good (business data stays,
 * an audit row remains), and only a fresh, governed `install_plugin` brings it back. The stop button
 * `disable_plugin` stays free, written down in `NOT_DIAL_GOVERNED`: the way back from it is governed.
 *
 * THE NET: every write whose name says `plugin` is governed under `plugin-install` or excluded with a
 * reason, and the bite test removes each governed one in turn and sees it named.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { ACTIONS, getAction } from '../../dist/api/registry.js';
import {
  DIAL_CAPABILITY_FOR_ACTION,
  INPUT_KEYED_DIAL_RULES,
  NOT_DIAL_GOVERNED,
  STRONG_DEFAULT_ASK_CAPABILITIES,
} from '../../dist/core/agent/index.js';
import { CONSEQUENCE_FOR_VERB } from '../../dist/core/agent/consequences.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const rest = (deps, name, input) => handleRest(name, input, deps).body;
const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

/**
 * The plugin writes governed under `plugin-install`: the three that start third-party code, and
 * (D161.1, owner 11.10.2026) `uninstall_plugin`, which removes the install and its grants for good.
 */
const GOVERNED = ['install_plugin', 'enable_plugin', 'refresh_plugin_compat', 'uninstall_plugin'];
/** The stop button, excluded with its reason. */
const STOPS_CODE = ['disable_plugin'];

const PLUGIN_WRITES = ACTIONS.filter((a) => a.kind === 'write' && /plugin/.test(a.name)).map((a) => a.name);

/** The coverage rule as a function of the map, so the bite test can hand it a weakened one. */
function uncovered(byName, excluded = NOT_DIAL_GOVERNED) {
  const keyed = new Set(INPUT_KEYED_DIAL_RULES.map((r) => r.action));
  return PLUGIN_WRITES.filter((verb) => byName[verb] === undefined && !keyed.has(verb) && excluded[verb] === undefined);
}

/** A workspace holding one plugin with one MCP tool, installed by a person, in the status asked for. */
function world(seed, { status = 'disabled', compatRange = '^1.0.0' } = {}) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Plugin AG', `${seed}-ws`);
  const payload = `plugin-${seed}`;
  const installed = human(deps, 'install_plugin', {
    workspaceId,
    source: 'local',
    packageRef: {
      manifest: {
        name: `Extension ${seed}`,
        version: '1.0.0',
        compat_range: compatRange,
        sha256: createHash('sha256').update(payload).digest('hex'),
        capabilities: [{ kind: 'mcp_tool', name: `acme_${seed.replace(/-/g, '_')}` }],
        permissions: { requested: [] },
      },
      payload,
    },
    idempotencyKey: `${seed}-install`,
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const pluginId = installed.plugin.id;
  if (status === 'disabled') {
    assert.equal(human(deps, 'disable_plugin', { workspaceId, pluginId, idempotencyKey: `${seed}-off` }).ok, true);
  }
  return { deps, workspaceId, pluginId };
}

const statusOf = (w) => w.deps.store.db.prepare('SELECT status FROM plugin_manifests WHERE workspace_id = ? AND id = ?').get(w.workspaceId, w.pluginId).status;
const registrations = (w) =>
  w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM plugin_capability_registrations WHERE workspace_id = ? AND plugin_id = ?').get(w.workspaceId, w.pluginId).n;
const drafts = (w, verb) =>
  w.deps.store.db.prepare('SELECT id, status, dial_capability FROM agent_action WHERE workspace_id = ? AND action_tool = ?').all(w.workspaceId, verb);

// --- the net --------------------------------------------------------------------------------------

test('every plugin write is governed under plugin-install or excluded in writing', () => {
  assert.deepEqual([...PLUGIN_WRITES].sort(), [...GOVERNED, ...STOPS_CODE].sort(), 'the population is the five G02 writes');
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION), []);
  for (const verb of GOVERNED) assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], 'plugin-install', `${verb}: governed under plugin-install`);
  assert.equal(NOT_DIAL_GOVERNED.uninstall_plugin, undefined, 'D161.1: uninstall is governed, not excluded');
  for (const verb of STOPS_CODE) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[verb], undefined, `${verb}: a stop direction stays free`);
    assert.match(NOT_DIAL_GOVERNED[verb], /stop/, `${verb}: its exclusion says it is the stop direction`);
  }
  assert.ok(STRONG_DEFAULT_ASK_CAPABILITIES.has('plugin-install'), 'the family stays a strong-default ask');
});

test('IT BITES: un-governing any governed plugin write, uninstall included, is named at once', () => {
  for (const verb of GOVERNED) {
    const weakened = { ...DIAL_CAPABILITY_FOR_ACTION };
    delete weakened[verb];
    assert.deepEqual(uncovered(weakened), [verb], `${verb}: un-governed, it must surface`);
  }
  const { disable_plugin: _d, ...fewer } = NOT_DIAL_GOVERNED;
  assert.deepEqual(uncovered(DIAL_CAPABILITY_FOR_ACTION, fewer), ['disable_plugin'], 'an exclusion is load-bearing too');
});

test('enable_plugin, refresh_plugin_compat and uninstall_plugin state their own consequence in both locales (D156 rules)', () => {
  for (const verb of ['enable_plugin', 'refresh_plugin_compat', 'uninstall_plugin']) {
    const own = CONSEQUENCE_FOR_VERB[verb];
    assert.ok(own, `${verb}: a sentence of its own, not the install fallback`);
    for (const locale of ['en', 'de-CH']) {
      const s = own[locale];
      assert.ok(s.length <= 220, `${verb} ${locale}: at most 220 characters (${s.length})`);
      assert.ok(s.split(/(?<=[.!?])\s+/).length <= 2, `${verb} ${locale}: at most two sentences`);
    }
    assert.doesNotMatch(own['de-CH'], /ß/);
    assert.equal(getAction(verb).consequence, own.en, `${verb}: the MCP description carries it`);
  }
  assert.equal(CONSEQUENCE_FOR_VERB.enable_plugin.reversibility, 'reversible', 'enable_plugin: disable_plugin stops it again');
  // D161: the reviewed map classes refresh_plugin_compat correctable (the stricter class wins: code it restarted may already have run).
  assert.equal(CONSEQUENCE_FOR_VERB.refresh_plugin_compat.reversibility, 'correctable', 'refresh_plugin_compat: the D161 map class');
  // No verb brings the same install back; the sentence says business data stays and names the reinstall.
  assert.equal(CONSEQUENCE_FOR_VERB.uninstall_plugin.reversibility, 'final');
  assert.match(CONSEQUENCE_FOR_VERB.uninstall_plugin.en, /business data stays/);
  assert.match(CONSEQUENCE_FOR_VERB.uninstall_plugin.en, /installed anew/);
});

// --- the behaviour, over the real seam -----------------------------------------------------------

test('REPRO: an agent seat enabling a disabled plugin gets a Vorschlag over REST, and nothing starts', () => {
  const w = world('en-rest');
  assert.equal(statusOf(w), 'disabled');
  assert.equal(registrations(w), 0);

  const r = rest(w.deps, 'enable_plugin', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'agent-on' });
  assert.equal(r.drafted, true, `the agent started third-party code with no Vorschlag: ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'force_ask', 'plugin-install is a strong-default ask');
  assert.equal(statusOf(w), 'disabled', 'the plugin did not start');
  assert.equal(registrations(w), 0, 'no capability was registered');
  assert.deepEqual(drafts(w, 'enable_plugin').map((d) => [d.status, d.dial_capability]), [['pending', 'plugin-install']]);
});

test('over MCP the same call drafts, and the person approving it is what starts the plugin', () => {
  const w = world('en-mcp');
  const r = mcp(w.deps, 'enable_plugin', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'agent-on' });
  assert.equal(r.drafted, true, JSON.stringify(r));
  assert.equal(statusOf(w), 'disabled');

  const [draft] = drafts(w, 'enable_plugin');
  const approved = human(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: draft.id });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(statusOf(w), 'installed', 'the approval ran the enable');
  assert.equal(registrations(w), 1, 'and registered its capability');
});

test('refresh_plugin_compat cannot revive an incompatible plugin for an agent: it drafts', () => {
  // Installed while its range fails the core: `incompatible`, nothing registered, nothing running.
  const w = world('rf', { status: 'incompatible', compatRange: '^99.0.0' });
  assert.equal(statusOf(w), 'incompatible');
  assert.equal(registrations(w), 0);
  // A core update that satisfies the range, simulated on the stored manifest: the next refresh would
  // re-register the plugin and start it, the same act as enable_plugin.
  w.deps.store.db.prepare("UPDATE plugin_manifests SET compat_range = '^1.0.0' WHERE workspace_id = ? AND id = ?").run(w.workspaceId, w.pluginId);

  const r = rest(w.deps, 'refresh_plugin_compat', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'agent-rf' });
  assert.equal(r.drafted, true, `the agent revived third-party code with no Vorschlag: ${JSON.stringify(r)}`);
  assert.equal(statusOf(w), 'incompatible');
  assert.equal(registrations(w), 0);

  // The person running the same refresh starts it: that direction is real, which is why it is governed.
  const byHuman = human(w.deps, 'refresh_plugin_compat', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'human-rf' });
  assert.equal(byHuman.ok, true, JSON.stringify(byHuman));
  assert.equal(statusOf(w), 'installed');
  assert.equal(registrations(w), 1);
});

test('the stop button stays free for the agent: disable runs at once', () => {
  const w = world('stop', { status: 'installed' });
  assert.equal(registrations(w), 1);
  const off = rest(w.deps, 'disable_plugin', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'agent-off' });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.notEqual(off.drafted, true);
  assert.equal(statusOf(w), 'disabled');
  assert.equal(registrations(w), 0);
});

test('D161.1: an agent uninstalling a plugin gets a Vorschlag; the person approving it removes the plugin', () => {
  const w = world('rm', { status: 'installed' });
  const manifests = () => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM plugin_manifests WHERE workspace_id = ? AND id = ?').get(w.workspaceId, w.pluginId).n;
  const r = rest(w.deps, 'uninstall_plugin', { workspaceId: w.workspaceId, pluginId: w.pluginId, idempotencyKey: 'agent-rm' });
  assert.equal(r.drafted, true, `the agent removed the plugin with no Vorschlag: ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'force_ask');
  assert.equal(manifests(), 1, 'the plugin is still installed');
  assert.equal(registrations(w), 1, 'and still registered');

  const [draft] = drafts(w, 'uninstall_plugin');
  assert.equal(draft.dial_capability, 'plugin-install');
  const approved = human(w.deps, 'approve_drafted_action', { workspaceId: w.workspaceId, actionId: draft.id });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(manifests(), 0, 'the approval ran the uninstall');
  assert.equal(registrations(w), 0);
  const audit = w.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'plugin' AND entity_id = ? AND action = 'delete'")
    .get(w.workspaceId, w.pluginId).n;
  assert.equal(audit, 1, 'the removal stays on the audit trail');
});
