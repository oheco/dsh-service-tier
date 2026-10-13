import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { InMemoryCredentialStore, defaultProviderAuthContext } from '@earendil-works/pi-ai';
import { Config as PiConfig, apply as applyPi } from '@deepseek-ai/dsh-llm-pi-ai';
import { ExistingConnections, FastRequests, resolveRouteModel } from '../adapter.js';
import { Config } from '../config.js';
import { TierOperations, RequestTiers, payloadHook, fastHeaders, sessionRecordSchema, tiersForApi } from '../core.js';

const PROVIDER = 'existing-relay';
const MODEL = 'claude-test-through-relay';
function source(api, baseURL) {
  return { api, baseURL, apiKeyEnv: 'EXISTING_API_KEY', headers: { 'x-existing': 'keep', 'anthropic-beta': 'existing-beta' },
    models: [{ id: MODEL, name: 'Existing', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 8192, maxTokens: 256 }],
    retryPolicy: { mode: 'normal', maxRetries: 0 } };
}
function connections(config) {
  return new ExistingConnections({ directory: () => [{ provider: PROVIDER, settingsNs: 'pi-fixture', settingsPath: ['providers', PROVIDER] }],
    settings: () => [{ ns: 'pi-fixture', revision: 0, value: { providers: { [PROVIDER]: config } } }] });
}
function ordinaryAdapter(config) {
  let adapter;
  const handle = () => {}; handle.replace = () => {};
  const credentials = { resolve: async () => ({ value: 'fixture-key' }), readRecord: async () => undefined, listRecords: async () => [] };
  const ctx = {
    fiber: { entry: { options: { id: 'pi-fixture' } } }, on() {}, inject() {}, logger: { warn() {}, error() {} },
    get: name => name === 'credentials' ? credentials : undefined,
    llm: { registerConfigurableProviders: () => handle, registerModelDiscovery() {}, registerAdapter(_routes, value) { adapter = value; return handle; } },
  };
  applyPi(ctx, PiConfig({ providers: { [PROVIDER]: config } }));
  return adapter;
}
function operations(sessions = new Map()) {
  return new TierOperations({ describeModel: () => ({ supported: true, api: 'openai-responses' }), sessions: sessions instanceof Map ? { get: id => sessions.get(id), put: async (id, record) => sessions.set(id, record) } : sessions });
}
test('session isolation, conflict detection, Standard always available, and old tiers remain readable', async () => {
  const records = new Map([['old', { tier: 'ultrafast', revision: 2 }]]), api = operations(records);
  assert.equal(api.readTier('old'), 'ultrafast');
  await api.setSession({ sessionId: 'a', tier: 'fast', revision: 0 });
  assert.equal(api.readTier('a'), 'fast'); assert.equal(api.readTier('b'), 'default');
  const results = await Promise.allSettled(['default', 'fast'].map(tier => api.setSession({ sessionId: 'a', tier, revision: 1 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SESSION_CONFLICT');
  api.describeModel = () => ({ supported: false });
  await assert.rejects(api.setSession({ sessionId: 'b', tier: 'fast', revision: 0 }), { code: 'UNSUPPORTED_PROTOCOL' });
  await api.setSession({ sessionId: 'a', tier: 'default', revision: 2 });
});
test('child mode is copied once, nested children inherit, and explicit child choices survive', async () => {
  const records = new Map(), api = operations(records);
  await api.setSession({ sessionId: 'parent', tier: 'fast', revision: 0 });
  await api.inheritSession({ sessionId: 'child', parentSessionId: 'parent' });
  await api.inheritSession({ sessionId: 'grandchild', parentSessionId: 'child' });
  assert.deepEqual(api.getSession({ sessionId: 'child' }), { sessionId: 'child', tier: 'fast', revision: 1 });
  assert.equal(api.readTier('grandchild'), 'fast');
  await api.setSession({ sessionId: 'parent', tier: 'default', revision: 1 });
  await api.inheritSession({ sessionId: 'child', parentSessionId: 'parent' });
  assert.equal(api.readTier('child'), 'fast', 'Parent changes do not overwrite the captured child choice.');
  await api.setSession({ sessionId: 'child', tier: 'default', revision: 1 });
  await api.setSession({ sessionId: 'parent', tier: 'fast', revision: 2 });
  await api.inheritSession({ sessionId: 'child', parentSessionId: 'parent' });
  assert.equal(api.readTier('child'), 'default', 'Explicit child Standard wins over parent Fast.');
  await api.inheritSession({ sessionId: 'new-child', parentSessionId: 'child' });
  assert.equal(api.readTier('new-child'), 'default');
  await api.setSession({ sessionId: 'child', tier: 'fast', revision: 2 });
  await api.inheritSession({ sessionId: 'new-child', parentSessionId: 'child' });
  assert.equal(api.readTier('new-child'), 'default', 'Inherited Standard is persisted too.');
  assert.equal(api.readTier('independent'), 'default');
});
test('Ultrafast is offered and stored only for OpenAI protocols, including child inheritance', async () => {
  for (const api of ['openai-responses', 'openai-completions']) {
    assert.deepEqual(tiersForApi(api), ['default', 'fast', 'ultrafast']);
    const modes = operations(); modes.describeModel = () => ({ supported: true, api });
    await modes.setSession({ sessionId: 'parent', tier: 'ultrafast', revision: 0 });
    await modes.inheritSession({ sessionId: 'child', parentSessionId: 'parent' });
    assert.equal(modes.readTier('child'), 'ultrafast');
    const payload = Object.freeze({ model: MODEL });
    assert.deepEqual(await payloadHook(api, undefined, 'ultrafast')(payload), { model: MODEL, service_tier: 'ultrafast' });
    assert.equal(payload.service_tier, undefined);
  }
  assert.deepEqual(tiersForApi('anthropic-messages'), ['default', 'fast']);
  assert.deepEqual(tiersForApi('unhandled-api'), ['default']);
  const modes = operations(); modes.describeModel = () => ({ supported: true, api: 'anthropic-messages' });
  await assert.rejects(modes.setSession({ sessionId: 'anthropic', tier: 'ultrafast', revision: 0 }), { code: 'UNSUPPORTED_TIER' });
  assert.deepEqual(modes.getSession({ sessionId: 'anthropic' }), { sessionId: 'anthropic', tier: 'default', revision: 0 });
  assert.throws(() => payloadHook('anthropic-messages', undefined, 'ultrafast'), { code: 'UNSUPPORTED_TIER' });
});
test('inheritance shares the write queue and waits for durable storage before completing', async () => {
  const records = new Map(), gate = Promise.withResolvers(), started = Promise.withResolvers();
  const api = operations({ get: id => records.get(id), put: async (id, value) => {
    if (id === 'child') { started.resolve(); await gate.promise; }
    records.set(id, value);
  } });
  const parentWrite = api.setSession({ sessionId: 'parent', tier: 'fast', revision: 0 });
  const inherit = api.inheritSession({ sessionId: 'child', parentSessionId: 'parent' });
  const parentChange = api.setSession({ sessionId: 'parent', tier: 'default', revision: 1 });
  await parentWrite; await started.promise;
  assert.equal(records.has('child'), false);
  assert.equal(api.readTier('parent'), 'fast');
  gate.resolve(); await inherit; await parentChange;
  assert.equal(api.readTier('child'), 'fast');
  assert.equal(api.readTier('parent'), 'default');
  await assert.rejects(api.inheritSession({ sessionId: 'child', parentSessionId: 'child' }), { code: 'INVALID_PARENT' });
});
test('protocol hooks copy frozen payloads, preserve hooks, and merge beta headers', async () => {
  const payload = Object.freeze({ model: MODEL, reasoning: Object.freeze({ effort: 'high' }) });
  const result = await payloadHook('openai-responses', async value => ({ ...value, store: false }))(payload, {});
  assert.equal(result.service_tier, 'fast'); assert.equal(result.store, false); assert.equal(payload.service_tier, undefined);
  const anthropic = await payloadHook('anthropic-messages')(payload, {});
  assert.equal(anthropic.speed, 'fast'); assert.equal(anthropic.service_tier, undefined);
  const headers = { 'Anthropic-Beta': 'other,fast-mode-2026-02-01', Authorization: 'original' };
  const merged = fastHeaders('anthropic-messages', headers);
  assert.equal(merged['anthropic-beta'], 'other,fast-mode-2026-02-01'); assert.equal(headers['Anthropic-Beta'], 'other,fast-mode-2026-02-01');
});
test('snapshots keep same request choice; helper calls and new requests use independent choices', () => {
  let tier = 'fast'; const snapshots = new RequestTiers(() => tier), options = Object.freeze({ sessionId: 'a' });
  assert.equal(snapshots.capture(options).tier, 'fast'); tier = 'default'; assert.equal(snapshots.capture(options).tier, 'fast');
  assert.equal(snapshots.capture({ ...options }).tier, 'default'); tier = 'fast';
  assert.equal(snapshots.capture({ ...options, purpose: 'compaction' }).tier, 'default'); assert.equal(snapshots.capture({}).tier, 'default');
});
test('existing catalog/overrides/efforts and route headers stay intact; description omits secrets', () => {
  const config = source('openai-responses', 'https://fixture.invalid/v1');
  config.compat = { supportsMaxOutputTokens: false }; config.models[0].compat = { supportsStrictMode: false };
  const routes = connections(config), original = structuredClone(config), selected = routes.selection({ provider: PROVIDER, model: MODEL });
  assert.equal(selected.model.provider, PROVIDER); assert.equal(selected.model.api, 'openai-responses');
  assert.deepEqual(selected.model.thinkingLevelMap, { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null });
  assert.deepEqual(selected.model.compat, { supportsMaxOutputTokens: false, supportsStrictMode: false }); assert.deepEqual(config, original);
  const builtin = resolveRouteModel('openai', { modelOverrides: { 'gpt-4': { name: 'Original model' } } }, 'gpt-4');
  assert.equal(builtin.model.name, 'Original model'); assert.equal(builtin.model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(routes.describe({ provider: PROVIDER, model: MODEL }).supported, true);
  assert.ok(!JSON.stringify(routes.describe({ provider: PROVIDER, model: MODEL })).includes('EXISTING_API_KEY'));
});
test('DSH JSON domain restores choice without resetting legacy revision', async t => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-tier-test-')), owned = await realpath(dir), backend = new JsonStorageBackend(dir);
  t.after(async () => { await backend.close(); assert.equal(await realpath(dir), owned); assert.ok(path.basename(owned).startsWith('dsh-tier-test-')); await rm(owned, { recursive: true }); });
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json' });
  const spec = defineDomain({ name: 'tier_test', version: 1, tables: { sessions: domainTable(sessionRecordSchema) } });
  let domain = await facility.open(spec); const api = operations(domain.table('sessions'));
  await api.setSession({ sessionId: 'a', tier: 'fast', revision: 0 });
  await api.inheritSession({ sessionId: 'child', parentSessionId: 'a' });
  await api.setSession({ sessionId: 'a', tier: 'default', revision: 1 });
  await domain.close(); domain = await facility.open(spec);
  assert.deepEqual(domain.table('sessions').get('a'), { tier: 'default', revision: 2 });
  assert.deepEqual(domain.table('sessions').get('child'), { tier: 'fast', revision: 1 });
  await operations(domain.table('sessions')).inheritSession({ sessionId: 'child', parentSessionId: 'a' });
  assert.deepEqual(domain.table('sessions').get('child'), { tier: 'fast', revision: 1 });
  await domain.close();
});
async function fixture(t) {
  const requests = []; let reject = false;
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push({ url: request.url, body, headers: request.headers });
    if (reject) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fast not supported', type: 'invalid_request_error' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = item => response.write(`data: ${JSON.stringify(item)}\n\n`);
    if (new URL(request.url, 'http://fixture').pathname.endsWith('/messages')) {
      const event = item => response.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
      event({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event({ type: 'message_stop' }); response.end();
    } else if (request.url.endsWith('/chat/completions')) {
      send({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] });
      send({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      response.end('data: [DONE]\n\n');
    } else {
      const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
      send({ type: 'response.created', response: { id: 'resp-fixture', model: body.model, status: 'in_progress', output: [] } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'hello' });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: 'resp-fixture', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1`, reject: () => { reject = true; } };
}
const request = sessionId => Object.freeze({ provider: PROVIDER, model: MODEL, sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'check_status', description: 'Checks status.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } }], reasoningEffort: 'high', maxTokens: 64 });
async function collect(stream, success = true) {
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const finish = chunks.find(chunk => chunk.type === 'finish'); assert.ok(finish, JSON.stringify(chunks));
  if (success) { assert.ok(chunks.some(chunk => chunk.type === 'text-delta'), JSON.stringify(chunks)); assert.equal(finish.reason.kind, 'stop', JSON.stringify(chunks)); assert.equal(finish.replayState.response.provider, PROVIDER); }
  return chunks;
}
for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages']) {
  test(`${api}: existing route HTTP, Standard parity, concurrency, retry snapshot, and relay rejection`, { timeout: 20000 }, async t => {
    const wire = await fixture(t), config = source(api, wire.baseURL), routes = connections(config), tiers = new Map([['a', 'default'], ['b', 'fast'], ['c', 'default']]);
    const adapterConfig = { resolveApiKey: async (_provider, profile) => { assert.equal(profile.apiKeyEnv, 'EXISTING_API_KEY'); return 'fixture-key'; }, auth: { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() } };
    const fast = new FastRequests({ connections: routes, readTier: id => tiers.get(id), adapterConfig });
    const hostCtx = new Context(), ordinary = ordinaryAdapter(config), runtime = new LlmRuntime(hostCtx);
    runtime.registerAdapter([PROVIDER], ordinary); t.after(() => hostCtx.fiber.dispose());
    let called = 0;
    await collect(fast.stream(request('a'), () => { called++; return runtime.stream(request('a')); }));
    assert.equal(called, 1);
    const standardWire = wire.requests[0];
    assert.equal(standardWire.body.service_tier, undefined); assert.equal(standardWire.body.speed, undefined);
    await Promise.all([request('b'), request('b')].map(options => collect(fast.stream(options, () => { throw new Error('Fast must not fall through'); }))));
    for (const item of wire.requests.slice(1)) {
      assert.equal(item.body.model, MODEL); assert.equal(item.headers['x-existing'], 'keep');
      assert.equal(item.headers[api === 'anthropic-messages' ? 'x-api-key' : 'authorization'], api === 'anthropic-messages' ? 'fixture-key' : 'Bearer fixture-key');
      assert.ok(item.body.tools.some(tool => (tool.name ?? tool.function?.name) === 'check_status'));
      if (api === 'anthropic-messages') { assert.equal(item.body.speed, 'fast'); assert.equal(item.body.service_tier, undefined); assert.ok(item.headers['anthropic-beta'].includes('existing-beta')); assert.ok(item.headers['anthropic-beta'].includes('fast-mode-2026-02-01')); }
      else { assert.equal(item.body.service_tier, 'fast'); assert.equal(item.body.speed, undefined); }
    }
    const retry = request('b'); await collect(fast.stream(retry, () => { throw new Error('wrong path'); })); tiers.set('b', 'default');
    await collect(fast.stream(retry, () => { throw new Error('snapshot lost'); }));
    let standard = false; await collect(fast.stream(request('b'), () => { standard = true; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(); }), false); assert.equal(standard, true);
    tiers.set('b', 'fast');
    const attachmentRequest = Object.freeze({ ...request('b'), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'file', attachment: { attachmentId: 'fixture-file', name: 'fixture.txt', bytes: 12 } }, { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 8, width: 2, height: 2, name: 'fixture.png' } }] }] });
    await collect(runtime.stream(attachmentRequest));
    const standardAttachment = wire.requests.at(-1).body;
    const fastAttachmentReply = await collect(fast.stream(attachmentRequest, () => { throw new Error('wrong attachment path'); }));
    const fastAttachment = { ...wire.requests.at(-1).body }; delete fastAttachment.service_tier; delete fastAttachment.speed;
    assert.deepEqual(fastAttachment, standardAttachment, 'Attachment projection and every original body field must match Standard.');
    assert.ok(JSON.stringify(fastAttachment).includes('fixture.txt'));
    const replayState = fastAttachmentReply.find(chunk => chunk.type === 'finish').replayState;
    const replayRequest = Object.freeze({ ...request('b'), messages: [request('b').messages[0], { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: PROVIDER, model: MODEL, replayState } }, { role: 'user', content: [{ type: 'text', text: 'continue' }] }] });
    await collect(runtime.stream(replayRequest)); const standardReplay = wire.requests.at(-1).body;
    await collect(fast.stream(replayRequest, () => { throw new Error('wrong replay path'); }));
    const fastReplay = { ...wire.requests.at(-1).body }; delete fastReplay.service_tier; delete fastReplay.speed;
    assert.deepEqual(fastReplay, standardReplay, 'Durable assistant replay must match the existing adapter.');
    const childModes = operations();
    await childModes.setSession({ sessionId: 'parent', tier: 'fast', revision: 0 });
    await childModes.inheritSession({ sessionId: 'fresh-child', parentSessionId: 'parent' });
    await childModes.inheritSession({ sessionId: 'fork-child', parentSessionId: 'parent' });
    const childFast = new FastRequests({ connections: routes, readTier: id => childModes.readTier(id), adapterConfig });
    await Promise.all(['fresh-child', 'fork-child'].map(id => collect(childFast.stream(request(id), () => { throw new Error('Inherited Fast must not fall through'); }))));
    for (const item of wire.requests.slice(-2)) assert.equal(item.body[api === 'anthropic-messages' ? 'speed' : 'service_tier'], 'fast');
    await childModes.setSession({ sessionId: 'parent', tier: 'ultrafast', revision: 1 });
    await childModes.inheritSession({ sessionId: 'ultra-child', parentSessionId: 'parent' });
    if (api === 'anthropic-messages') {
      const before = wire.requests.length;
      const unsupported = await collect(childFast.stream(request('ultra-child'), () => { throw new Error('Must not silently downgrade inherited Ultrafast'); }), false);
      assert.equal(unsupported.at(-1).reason.failure.code, 'UNSUPPORTED_TIER');
      assert.equal(wire.requests.length, before, 'No Anthropic request with a made-up ultrafast speed.');
      assert.equal(childModes.readTier('ultra-child'), 'ultrafast');
      await childModes.setSession({ sessionId: 'ultra-child', tier: 'fast', revision: 1 });
      await collect(childFast.stream(request('ultra-child'), () => { throw new Error('Child can independently switch to Fast'); }));
      assert.equal(wire.requests.at(-1).body.speed, 'fast');
    } else {
      await collect(childFast.stream(request('ultra-child'), () => { throw new Error('Child must inherit Ultrafast'); }));
      assert.equal(wire.requests.at(-1).body.service_tier, 'ultrafast');
      tiers.set('ultra', 'ultrafast');
      await Promise.all(['b', 'ultra'].map(id => collect(fast.stream(request(id), () => { throw new Error('Both nonstandard modes must be decorated'); }))));
      assert.deepEqual(wire.requests.slice(-2).map(item => item.body.service_tier).sort(), ['fast', 'ultrafast']);
      const ultraRetry = request('ultra'); await collect(fast.stream(ultraRetry, () => { throw new Error('wrong path'); }));
      tiers.set('ultra', 'default'); await collect(fast.stream(ultraRetry, () => { throw new Error('Ultrafast snapshot lost'); }));
      assert.equal(wire.requests.at(-1).body.service_tier, 'ultrafast');
    }
    const defaults = Config({ openaiDefaultMode: 'ultrafast', anthropicDefaultMode: 'fast' }), defaultRecords = new Map();
    const defaultModes = new TierOperations({ defaults, sessions: { get: id => defaultRecords.get(id), put: async (id, value) => defaultRecords.set(id, value) }, describeModel: input => routes.describe(input) });
    const defaultFast = new FastRequests({ connections: routes, readTier: (id, selection) => defaultModes.readTier(id, selection), adapterConfig });
    await collect(defaultFast.stream(request('unselected-root'), () => { throw new Error('Protocol default must decorate the actual request'); }));
    assert.equal(wire.requests.at(-1).body[api === 'anthropic-messages' ? 'speed' : 'service_tier'], api === 'anthropic-messages' ? 'fast' : 'ultrafast');
    assert.equal(defaultRecords.size, 0, 'A request using the default does not persist an override.');
    for (const purpose of ['title', 'compaction']) {
      const auxiliary = { ...request('unselected-root'), purpose };
      await collect(defaultFast.stream(auxiliary, () => runtime.stream(auxiliary)));
      assert.equal(wire.requests.at(-1).body.speed, undefined); assert.equal(wire.requests.at(-1).body.service_tier, undefined);
    }
    await defaultModes.setSession({ sessionId: 'unselected-root', tier: 'default', revision: 0 });
    await collect(defaultFast.stream(request('unselected-root'), () => runtime.stream(request('unselected-root'))));
    assert.equal(wire.requests.at(-1).body.speed, undefined); assert.equal(wire.requests.at(-1).body.service_tier, undefined);
    wire.reject(); const before = wire.requests.length;
    const failed = await collect(fast.stream(request('b'), () => { throw new Error('No automatic downgrade'); }), false);
    assert.equal(failed.at(-1).reason.kind, 'error'); assert.equal(wire.requests.length, before + 1); assert.equal(tiers.get('b'), 'fast');
    if (api !== 'anthropic-messages') {
      const beforeUltra = wire.requests.length;
      const ultraFailed = await collect(childFast.stream(request('ultra-child'), () => { throw new Error('No automatic downgrade from Ultrafast'); }), false);
      assert.equal(ultraFailed.at(-1).reason.kind, 'error'); assert.equal(wire.requests.length, beforeUltra + 1);
      assert.equal(wire.requests.at(-1).body.service_tier, 'ultrafast');
      assert.equal(childModes.readTier('ultra-child'), 'ultrafast');
    }
  });
}
