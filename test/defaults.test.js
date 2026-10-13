import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../index.js';
import { defaultModeForApi, TierOperations, RequestTiers } from '../core.js';

const routes = { openai: 'openai-responses', chat: 'openai-completions', anthropic: 'anthropic-messages' };
function fixture(defaults) {
  const records = new Map();
  const modes = new TierOperations({ defaults, sessions: { get: id => records.get(id), put: async (id, value) => records.set(id, value) },
    describeModel: input => ({ api: routes[input?.provider], supported: input?.provider in routes }) });
  return { records, modes };
}

test('plugin Config exposes two localized selections and rejects unsupported defaults', () => {
  const values = raw => Object.fromEntries(Object.entries(Config(raw)).map(([key, ref]) => [key, ref.get()]));
  assert.deepEqual(values({}), { openaiDefaultMode: 'default', anthropicDefaultMode: 'default' });
  assert.deepEqual(values({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' }), { openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' });
  assert.throws(() => Config({ anthropicDefaultMode: 'ultrafast' }));
  assert.throws(() => Config({ openaiDefaultMode: 'priority' }));
  const schema = JSON.parse(JSON.stringify(Config));
  const fields = schema.refs[schema.uid].dict;
  assert.deepEqual(Object.keys(fields), ['openaiDefaultMode', 'anthropicDefaultMode']);
  const openai = schema.refs[fields.openaiDefaultMode], anthropic = schema.refs[fields.anthropicDefaultMode];
  assert.equal(openai.meta.volatile, true); assert.equal(anthropic.meta.volatile, true);
  assert.deepEqual(openai.list.map(id => schema.refs[id].value), ['default', 'fast', 'ultrafast']);
  assert.deepEqual(anthropic.list.map(id => schema.refs[id].value), ['default', 'fast']);
  assert.equal(openai.meta.description.zh, 'OpenAI 默认模式');
  assert.equal(anthropic.meta.description.en, 'Anthropic default mode');
  assert.equal(schema.refs[openai.list[2]].meta.description.zh, '超快速');
});
test('protocol defaults remain implicit while saved choices override later configuration changes', async () => {
  const defaults = Config({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' });
  const { modes, records } = fixture(defaults);
  for (const provider of ['openai', 'chat']) assert.deepEqual(modes.getSession({ sessionId: 'unselected', provider }), { sessionId: 'unselected', tier: 'ultrafast', revision: 0 });
  assert.equal(modes.getSession({ sessionId: 'unselected', provider: 'anthropic' }).tier, 'fast');
  assert.equal(modes.getSession({ sessionId: 'unselected', provider: 'unhandled' }).tier, 'default');
  assert.equal(records.size, 0, 'Reading a default must not pin an implicit choice.');
  await modes.setSession({ sessionId: 'standard', tier: 'default', revision: 0 });
  await modes.setSession({ sessionId: 'pinned', provider: 'openai', tier: 'ultrafast', revision: 0 });
  defaults.openaiDefaultMode = 'fast'; defaults.anthropicDefaultMode = 'default';
  assert.equal(modes.getSession({ sessionId: 'unselected', provider: 'openai' }).tier, 'fast');
  assert.equal(modes.getSession({ sessionId: 'unselected', provider: 'anthropic' }).tier, 'default');
  assert.equal(modes.getSession({ sessionId: 'pinned', provider: 'openai' }).tier, 'ultrafast');
  assert.equal(modes.getSession({ sessionId: 'standard', provider: 'openai' }).tier, 'default');
  modes.describeModel = () => { throw new Error('Removed connection'); };
  await modes.setSession({ sessionId: 'recover', tier: 'default', revision: 0 });
  assert.equal(modes.getSession({ sessionId: 'recover' }).tier, 'default');
  assert.equal(defaultModeForApi('unhandled', defaults), 'default');
});
test('request snapshots resolve the actual route and keep title/compaction calls Standard', () => {
  const defaults = Config({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' }), { modes } = fixture(defaults);
  const snapshots = new RequestTiers((id, selection) => modes.readTier(id, selection));
  const request = Object.freeze({ sessionId: 'root', provider: 'openai' });
  assert.equal(snapshots.capture(request).tier, 'ultrafast');
  defaults.openaiDefaultMode = 'default';
  assert.equal(snapshots.capture(request).tier, 'ultrafast');
  assert.equal(snapshots.capture({ ...request }).tier, 'default');
  assert.equal(snapshots.capture({ ...request, provider: 'anthropic' }).tier, 'fast');
  for (const purpose of ['title', 'compaction']) assert.equal(snapshots.capture({ ...request, provider: 'anthropic', purpose }).tier, 'default');
  assert.equal(snapshots.capture({ provider: 'anthropic' }).tier, 'default');
});
test('children freeze the parent’s effective protocol default, and failure never saves a wrong mode', async () => {
  const defaults = Config({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' }), { modes, records } = fixture(defaults);
  await modes.inheritSession({ sessionId: 'child', parentSessionId: 'parent', resolveParentSelection: async () => ({ provider: 'openai' }) });
  await modes.inheritSession({ sessionId: 'grandchild', parentSessionId: 'child' });
  assert.equal(records.has('parent'), false);
  assert.equal(modes.getSession({ sessionId: 'child', provider: 'anthropic' }).tier, 'ultrafast', 'Inheritance uses the parent’s route, even if the child overrides its protocol.');
  defaults.openaiDefaultMode = 'default';
  assert.equal(modes.readTier('child'), 'ultrafast'); assert.equal(modes.readTier('grandchild'), 'ultrafast');
  await modes.setSession({ sessionId: 'child', tier: 'default', revision: 1 });
  await modes.inheritSession({ sessionId: 'child', parentSessionId: 'parent', resolveParentSelection: async () => { throw new Error('Should not inspect an already saved child'); } });
  assert.equal(modes.readTier('child'), 'default');
  await assert.rejects(modes.inheritSession({ sessionId: 'retry', parentSessionId: 'offline', resolveParentSelection: async () => { throw new Error('Storage unavailable'); } }), /Storage unavailable/);
  assert.equal(records.has('retry'), false);
  await modes.inheritSession({ sessionId: 'retry', parentSessionId: 'offline', resolveParentSelection: async () => ({ provider: 'anthropic' }) });
  assert.equal(modes.readTier('retry'), 'fast');
});
