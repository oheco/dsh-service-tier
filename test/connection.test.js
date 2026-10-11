import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as ConnectionPlugin from '@deepseek-ai/dsh-client-connection';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { apply, inject, VERSION } from '../index.js';
import { RPC_CHANNEL, RPC_PREFIX } from '../core.js';

// Actual Connection plugin, signed-cookie authentication, and HTTP bridge.
// All credentials/tokens in this fixture are new, isolated test values.
test('real assembly: sibling services, signed authentication, exact routes, and /api gateway coexist', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-tier-rpc-'));
  const owned = await realpath(directory);
  const backend = new JsonStorageBackend(directory);
  const routes = new Map(), authRecords = new Map();
  const ctx = new Context();
  let facility, server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await ctx.fiber.dispose();
    await facility?.closeAll();
    await backend.close();
    assert.equal(await realpath(directory), owned);
    assert.ok(path.basename(owned).startsWith('dsh-tier-rpc-'));
    await rm(owned, { recursive: true });
  });
  // Sibling-owned services enforce the same dependency checks as DSH.
  await ctx.plugin({ name: 'fixture-services', apply(serviceCtx) {
    serviceCtx.provide('webServer', { register(route) {
      assert.ok(!routes.has(route.path));
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } });
    serviceCtx.provide('storage', { backend: { get: () => backend } });
    facility = new DomainFacility(serviceCtx, { backend: 'json' });
    serviceCtx.provide('storageDomain', facility);
    serviceCtx.provide('settings', { describe: () => [{ ns: 'pi-fixture', revision: 0, value: { providers: { existing: { api: 'openai-responses', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'fixture-model' }] } } } }] });
    serviceCtx.provide('credentials', {
      describe: async () => ({ configured: false, writable: true }),
      async modifyRecord(key, modify) {
        const value = await modify(authRecords.get(key));
        if (value !== undefined) authRecords.set(key, value);
        return authRecords.get(key);
      },
    });
    serviceCtx.provide('llm', { listProviders: () => [{ id: 'existing' }], listConfigurableProviders: () => [{ provider: 'existing', settingsNs: 'pi-fixture', settingsPath: ['providers', 'existing'] }] });
  } });
  const token = randomUUID();
  await ctx.plugin(ConnectionPlugin, { token });
  const connection = ctx.get('connection');
  assert.ok(routes.has('/api'));
  await ctx.plugin({ name: 'fixture-gateway', inject: ['connection'], apply(gatewayCtx) {
    gatewayCtx.connection.rpc.intercept('/api', endpoint => endpoint === 'session/modelCatalog', async () => ({ ok: true, value: { default: null } }));
  } });
  // Negative control: root-provided services would incorrectly allow this read.
  await ctx.plugin({ name: 'fixture-inject-check', inject: ['connection'], apply(probeCtx) {
    assert.throws(() => probeCtx.webServer, /cannot get property "webServer" without inject/);
  } });
  const plugin = await ctx.plugin({ name: 'fixture-service-tier', inject, async apply(pluginCtx) {
    pluginCtx.fiber.entry = { options: { id: 'fixture-plugin' } };
    await apply(pluginCtx);
  } });
  assert.equal(plugin.state, 2);
  assert.equal(facility.get('oheco_service_tier').global.get().hostReady, true);
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      if (connection.authorizeIndex(request, response)) { response.writeHead(200); response.end('fixture'); }
      return;
    }
    const route = [...routes.values()].find(item => pathname.startsWith(`${item.path}/`));
    if (!route) { response.writeHead(404); response.end(); return; }
    try { await route.handler(request, response); }
    catch { response.writeHead(500); response.end('fixture handler failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { 'content-type': 'application/json', cookie };
  const envelope = (method, payload = {}) => JSON.stringify({ type: 'client-request', rpcId: 'fixture-rpc', method, payload });
  async function rpc(action, payload) {
    const response = await fetch(`${origin}${RPC_CHANNEL}/${RPC_PREFIX}${action}`, { method: 'POST', headers, body: envelope(`${RPC_PREFIX}${action}`, payload) });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.rpcId, 'fixture-rpc');
    assert.equal(value.result.ok, true, JSON.stringify(value.result));
    return value.result.value;
  }
  const described = await rpc('describe', { sessionId: 'fixture-a', provider: 'existing', model: 'fixture-model' });
  assert.equal(described.provider, 'existing');
  assert.equal(described.supported, true);
  assert.deepEqual(described.tiers, ['default', 'fast', 'ultrafast']);
  assert.equal((await rpc('session', { sessionId: 'fixture-a' })).tier, 'default');
  await rpc('set-session', { sessionId: 'fixture-a', provider: 'existing', model: 'fixture-model', tier: 'fast', revision: 0 });
  assert.equal((await rpc('session', { sessionId: 'fixture-a' })).tier, 'fast');
  await rpc('set-session', { sessionId: 'fixture-a', provider: 'existing', model: 'fixture-model', tier: 'ultrafast', revision: 1 });
  assert.equal((await rpc('session', { sessionId: 'fixture-a' })).tier, 'ultrafast');
  await rpc('client-ready', { slot: 'conversation.input.right', registered: true });
  const diagnostics = await rpc('diagnostics');
  assert.equal(diagnostics.hostVersion, VERSION);
  assert.equal(diagnostics.hostReady, true);
  const body = envelope(`${RPC_PREFIX}describe`);
  const unauthorized = await fetch(`${origin}${RPC_CHANNEL}/${RPC_PREFIX}describe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unauthorized.status, 401);
  const untrusted = await fetch(`${origin}${RPC_CHANNEL}/${RPC_PREFIX}describe`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body });
  assert.equal(untrusted.status, 403);
  const malformed = await fetch(`${origin}${RPC_CHANNEL}/${RPC_PREFIX}describe`, { method: 'POST', headers, body: '{}' });
  assert.equal(malformed.status, 400);
  const gateway = await fetch(`${origin}/api/session/modelCatalog`, { method: 'POST', headers, body: envelope('session/modelCatalog', { args: {} }) });
  assert.equal(gateway.status, 200);
  assert.equal((await gateway.json()).result.ok, true);
});
