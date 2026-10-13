import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { childSessionMeta } from '@deepseek-ai/dsh-subagent';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { apply, inject, Config } from '../index.js';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';

// Exercise the real registry's awaited agent/created dispatch with isolated
// Session-shaped fixtures; no paid model, parent config, or user log is touched.
test('real agent lifecycle: fresh/fork children inherit before announce resolves, resume/reload keep overrides', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-tier-agent-'));
  const owned = await realpath(directory), backend = new JsonStorageBackend(directory), ctx = new Context();
  const routes = new Map(), detachers = [], tools = new Set(), commands = new Map();
  let registry, facility;
  const storedHeaders = new Map(), closedReads = [];
  t.after(async () => {
    for (const detach of detachers.reverse()) detach();
    await ctx.fiber.dispose(); await facility?.closeAll(); await backend.close();
    assert.equal(await realpath(directory), owned);
    assert.ok(path.basename(owned).startsWith('dsh-tier-agent-'));
    await rm(owned, { recursive: true });
  });
  await ctx.plugin({ name: 'fixture-agent-services', apply(serviceCtx) {
    registry = new AgentRegistry(serviceCtx);
    facility = new DomainFacility(serviceCtx, { backend: 'json' });
    serviceCtx.provide('storage', { backend: { get: () => backend } });
    serviceCtx.provide('storageDomain', facility);
    serviceCtx.provide('credentials', {});
    serviceCtx.provide('sessionPersistence', { async open(id, access) {
      assert.equal(access, 'read');
      if (!storedHeaders.has(id)) throw new SessionPersistenceNotFoundError(id);
      return { async read() { return { events: [{ type: 'request/header', data: { header: { config: storedHeaders.get(id) } } }] }; }, async close() { closedReads.push(id); } };
    } });
    serviceCtx.provide('tools', { register(definition) { tools.add(definition); return () => tools.delete(definition); } });
    serviceCtx.provide('commands', { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name); } });
    const providers = ['existing', 'anthropic'];
    serviceCtx.provide('llm', { listProviders: () => providers.map(id => ({ id })), listConfigurableProviders: () => providers.map(provider => ({ provider, settingsNs: 'pi-fixture', settingsPath: ['providers', provider] })) });
    serviceCtx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'pi-fixture', revision: 0, value: { providers: Object.fromEntries(providers.map(provider => [provider, { api: provider === 'existing' ? 'openai-responses' : 'anthropic-messages', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'fixture-model' }] }])) } }] });
    serviceCtx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  } });
  async function makeAgent(id, parent, seeded = false, source = 'startup', origin = 'subagent', provider = 'existing') {
    let agent;
    await ctx.plugin({ name: `fixture-agent-${id}`, apply(agentCtx) {
      const meta = parent ? { ...childSessionMeta(parent, (parent.session.header.delegationDepth ?? 0) + 1, seeded), origin } : { isSeeded: false };
      agent = { id, options: { provider, model: 'fixture-model' }, status: 'idle', ctx: agentCtx,
        session: { id, header: { id, ...meta }, requestHeader: () => ({ config: { provider, model: 'fixture-model' } }) } };
    } });
    detachers.push(registry.enter(agent, parent ? registry.get(parent.id) : undefined));
    await registry.announce(agent, source);
    return agent;
  }
  async function mount(config = {}) {
    const plugin = await ctx.plugin({ name: 'fixture-service-tier', inject, Config, apply }, config);
    assert.equal(plugin.state, 2);
    return plugin;
  }
  async function rpc(action, payload) {
    const response = await routes.get(`/api/oheco-service-tier/${action}`).fetch(new Request(`http://fixture/api/oheco-service-tier/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'agent-test', method: `oheco-service-tier/${action}`, payload }),
    }));
    const result = (await response.json()).result; assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  const choice = id => rpc('session', { sessionId: id });
  const set = async (id, tier) => rpc('set-session', { sessionId: id, provider: 'existing', model: 'fixture-model', tier, revision: (await choice(id)).revision });
  const parent = await makeAgent('parent');
  let plugin = await mount();
  await set('parent', 'fast');
  const fresh = await makeAgent('fresh', parent), fork = await makeAgent('fork', parent, true);
  assert.equal((await choice(fresh.id)).tier, 'fast'); assert.equal((await choice(fork.id)).tier, 'fast');
  const grandchild = await makeAgent('grandchild', fresh);
  assert.equal((await choice(grandchild.id)).tier, 'fast');
  await set('fresh', 'default'); await set('parent', 'default');
  assert.equal((await choice('grandchild')).tier, 'fast'); assert.equal((await choice('fork')).tier, 'fast');
  await set('parent', 'fast');
  await makeAgent('ordinary-fork', parent, true, 'startup', null);
  assert.equal((await choice('ordinary-fork')).tier, 'default', 'An ordinary conversation fork is not a delegated subagent.');
  // Preserve an explicit child Standard on resume, even if its parent is Fast.
  detachers[1]();
  await makeAgent('fresh', parent, false, 'resume');
  assert.deepEqual(await choice('fresh'), { sessionId: 'fresh', tier: 'default', revision: 2 });
  await plugin.dispose();
  // A child started while the plugin was inactive is backfilled on activation.
  await makeAgent('backfill', parent);
  const implicitParent = await makeAgent('implicit-parent');
  await makeAgent('implicit-child', implicitParent); await makeAgent('implicit-fork', implicitParent, true);
  await makeAgent('cross-protocol-child', implicitParent, false, 'startup', 'subagent', 'anthropic');
  await makeAgent('anthropic-root', undefined, false, 'startup', undefined, 'anthropic');
  plugin = await mount({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' });
  assert.deepEqual(await choice('implicit-parent'), { sessionId: 'implicit-parent', tier: 'ultrafast', revision: 0 });
  for (const id of ['implicit-child', 'implicit-fork', 'cross-protocol-child']) assert.equal((await choice(id)).tier, 'ultrafast');
  assert.equal((await choice('anthropic-root')).tier, 'fast');
  storedHeaders.set('offline-config-parent', { provider: 'anthropic', model: 'fixture-model' });
  const offline = { ...parent, id: 'offline-config-parent', session: { ...parent.session, id: 'offline-config-parent', header: { id: 'offline-config-parent' } } };
  await makeAgent('offline-default-child', offline, false, 'resume');
  assert.equal((await choice('offline-default-child')).tier, 'fast', 'Offline inheritance resolves the parent’s persisted request header, not the child’s OpenAI route.');
  assert.deepEqual(closedReads, ['offline-config-parent']);
  assert.equal((await choice('backfill')).tier, 'fast');
  assert.equal((await choice('fresh')).tier, 'default');
  assert.equal((await choice('fork')).tier, 'fast');
  await set('parent', 'ultrafast');
  await makeAgent('ultra-child', parent);
  assert.equal((await choice('ultra-child')).tier, 'ultrafast');
  // Durable parent choice suffices when the live parent has left the registry.
  detachers[0]();
  const resumed = await makeAgent('offline-parent-child', parent, false, 'resume');
  assert.equal((await choice('offline-parent-child')).tier, 'ultrafast');
  const signal = new AbortController().signal;
  let childTool;
  for (const definition of tools) if ((await definition.execute({ action: 'get' }, { signal })).sessionId === resumed.id) childTool = definition;
  assert.ok(childTool);
  assert.deepEqual(childTool.parameters.properties.tier.enum, ['default', 'fast', 'ultrafast']);
  await childTool.execute({ action: 'set', tier: 'fast' }, { signal });
  assert.equal((await choice(resumed.id)).tier, 'fast', 'Tool uses the child’s existing request-header config without restating model IDs.');
  const command = commands.get('service-tier'); assert.ok(command);
  assert.equal((await command.handler({ agent: resumed, rawInput: 'ultrafast' })).kind, 'success');
  assert.equal((await choice(resumed.id)).tier, 'ultrafast');
  const previousTools = new Set(tools), broken = await makeAgent('removed-model-root');
  broken.session.requestHeader = () => ({ config: { provider: 'existing', model: 'removed-model' } });
  const brokenTool = [...tools].find(definition => !previousTools.has(definition)); assert.ok(brokenTool);
  await brokenTool.execute({ action: 'set', tier: 'default' }, { signal });
  assert.equal((await choice(broken.id)).tier, 'default', 'Standard remains selectable even if a configured speed default cannot resolve the model.');
  const brokenCommand = await makeAgent('removed-model-command'); brokenCommand.session.requestHeader = broken.session.requestHeader;
  assert.equal((await command.handler({ agent: brokenCommand, rawInput: 'standard' })).kind, 'success');
  assert.equal((await choice(brokenCommand.id)).tier, 'default');
  await plugin.dispose();
  assert.equal(routes.size, 0); assert.equal(tools.size, 0); assert.equal(commands.size, 0);
});
