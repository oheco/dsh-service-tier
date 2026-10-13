import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { updateVolatile } from '@deepseek-ai/cosmokit';
import SettingsForms from '@deepseek-ai/dsh-settings';
import { Config } from '../config.js';
import { TierOperations, RequestTiers } from '../core.js';

test('native Settings: both default fields are served, atomic edits update live refs, stale and invalid writes fail', async t => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-tier-config-')), owned = await realpath(directory), ctx = new Context();
  let entry, modes, settings, writes = 0;
  t.after(async () => { await ctx.fiber.dispose(); assert.equal(await realpath(directory), owned); assert.ok(path.basename(owned).startsWith('dsh-tier-config-')); await rm(owned, { recursive: true }); });
  ctx.provide('profileContext', { home: directory });
  ctx.provide('loader', { await: async () => {} });
  // Persistence/reconciliation is owned by DSH. This isolated editor validates
  // candidates before committing refs, like the real Loader's volatile update.
  ctx.provide('configEditor', {
    entries: () => entry ? [entry] : [],
    configuration: () => entry ? [{ entry, inherited: {}, override: entry.options.config }] : [],
    async edit(current, change) {
      assert.equal(current, entry);
      const raw = change(current.options.config, {}), next = Config(raw);
      for (const field of ['openaiDefaultMode', 'anthropicDefaultMode']) updateVolatile(current.fiber.config[field], next[field]);
      current.options.config = raw; writes++;
    },
  });
  await ctx.plugin({ name: 'fixture-settings', inject: SettingsForms.inject, apply(serviceCtx) { settings = new SettingsForms(serviceCtx); } });
  const records = new Map();
  const plugin = await ctx.plugin({ name: 'fixture-tier-owner', Config, inject: ['settings'], apply(pluginCtx, defaults) {
    pluginCtx.effect(() => pluginCtx.settings.configure({ auto: false }, pluginCtx.fiber));
    modes = new TierOperations({ defaults, sessions: { get: id => records.get(id), put: async (id, value) => records.set(id, value) },
      describeModel: input => ({ supported: true, api: input.provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses' }) });
  } }, {});
  entry = { id: 'fixture-entry', options: { id: 'oheco-service-tier', name: '@oheco/dsh-service-tier', config: {} }, fiber: plugin };
  const initial = settings.describe()[0];
  assert.equal(initial.ns, 'oheco-service-tier'); assert.equal(initial.autoGenerate, false);
  assert.deepEqual(initial.value, { openaiDefaultMode: 'default', anthropicDefaultMode: 'default' });
  const snapshots = new RequestTiers((id, selection) => modes.readTier(id, selection)), pending = { sessionId: 'root', provider: 'openai' };
  assert.equal(snapshots.capture(pending).tier, 'default');
  await settings.mutate(initial.ns, [
    { op: 'set', path: ['openaiDefaultMode'], value: 'ultrafast' },
    { op: 'set', path: ['anthropicDefaultMode'], value: 'fast' },
  ], initial.revision);
  assert.equal(writes, 1); assert.equal(plugin.state, 2, 'No plugin restart is needed for volatile defaults.');
  const changed = settings.describe()[0]; assert.ok(changed.revision > initial.revision);
  assert.equal(modes.getSession({ sessionId: 'root', provider: 'openai' }).tier, 'ultrafast');
  assert.equal(modes.getSession({ sessionId: 'root', provider: 'anthropic' }).tier, 'fast');
  assert.equal(snapshots.capture(pending).tier, 'default', 'An in-flight request keeps its previous snapshot.');
  assert.equal(snapshots.capture({ ...pending }).tier, 'ultrafast');
  assert.equal(records.size, 0);
  await modes.setSession({ sessionId: 'standard', tier: 'default', revision: 0 });
  await modes.inheritSession({ sessionId: 'child', parentSessionId: 'root', resolveParentSelection: async () => ({ provider: 'openai' }) });
  await assert.rejects(settings.mutate(initial.ns, [{ op: 'set', path: ['openaiDefaultMode'], value: 'fast' }], initial.revision), { code: 'SETTINGS_CONFLICT' });
  await assert.rejects(settings.mutate(initial.ns, [
    { op: 'set', path: ['openaiDefaultMode'], value: 'default' }, { op: 'set', path: ['anthropicDefaultMode'], value: 'ultrafast' },
  ], changed.revision));
  assert.equal(writes, 1); assert.deepEqual(settings.describe()[0].value, changed.value, 'An invalid second field must not partially commit the first.');
  await settings.mutate(initial.ns, [{ op: 'set', path: ['openaiDefaultMode'], value: 'fast' }], changed.revision);
  assert.equal(modes.getSession({ sessionId: 'root', provider: 'openai' }).tier, 'fast');
  assert.equal(modes.readTier('child'), 'ultrafast'); assert.equal(modes.readTier('standard'), 'default');
  assert.equal(writes, 2);
});
