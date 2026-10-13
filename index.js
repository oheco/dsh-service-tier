import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { credentialRef, isCredentialKeySegment, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { defaultProviderAuthContext } from '@earendil-works/pi-ai';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { foldRequestHeader } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { Config } from './config.js';
export { Config };
import { ExistingConnections, FastRequests } from './adapter.js';
import { RPC_CHANNEL, RPC_PREFIX, TierError, TierOperations, sessionRecordSchema } from './core.js';

export const name = 'oheco-service-tier';
export const inject = ['llm', 'credentials', 'settings', 'storageDomain', 'connection'];
export const VERSION = '0.2.2';
const dataSpec = defineDomain({
  name: 'oheco_service_tier', version: 1,
  global: { schema: z.object({ hostStarted: z.string(), hostVersion: z.string().default(''), hostReady: z.boolean().default(false), clientSlots: z.record(z.string(), z.string()) }), initial: { hostStarted: '', hostVersion: '', hostReady: false, clientSlots: {} } },
  tables: { sessions: domainTable(sessionRecordSchema) },
});
const actions = ['describe', 'session', 'set-session', 'client-ready', 'diagnostics'];
function piCredential(record) {
  if (!record) return undefined;
  return record.kind === 'api-key' ? { type: 'api_key', ...(record.key === undefined ? {} : { key: record.key }), ...(record.env === undefined ? {} : { env: record.env }) } : record.payload;
}
function storedCredential(value) {
  if (value.type === 'api_key') return { kind: 'api-key', ...(value.key === undefined ? {} : { key: value.key }), ...(value.env === undefined ? {} : { env: value.env }) };
  return { kind: 'grant', payload: JSON.parse(JSON.stringify(value)) };
}
function selectionOf(agent) {
  const config = agent?.session.requestHeader?.()?.config;
  return { provider: config?.provider ?? agent?.options.provider, model: config?.model ?? agent?.options.model };
}
export async function apply(ctx, config = Config({})) {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber));
  const domain = await ctx.storageDomain.open(dataSpec);
  ctx.effect(() => () => domain.close());
  await domain.global.set({ hostStarted: new Date().toISOString(), hostVersion: VERSION, hostReady: false, clientSlots: {} });
  const connections = new ExistingConnections({ directory: () => ctx.llm.listConfigurableProviders(), settings: () => ctx.settings.describe(), activeProviders: () => ctx.llm.listProviders().map(provider => provider.id) });
  let sessionSelection = () => undefined;
  const operations = new TierOperations({ sessions: domain.table('sessions'), defaults: config, describeModel: input => {
    const active = sessionSelection(input?.sessionId);
    return connections.describe({ provider: input?.provider ?? active?.provider, model: input?.model ?? active?.model });
  } });
  const ambient = defaultProviderAuthContext();
  const fast = new FastRequests({
    connections, readTier: (sessionId, selection) => operations.readTier(sessionId, selection),
    requestServices: () => ({ attachments: ctx.get('attachments'), fs: ctx.get('fs') }),
    adapterConfig: {
      async resolveApiKey(provider, profile) {
        if (profile.apiKeyEnv === undefined) return undefined;
        const value = (await ctx.credentials.resolve(credentialRef(profile.apiKeyEnv)))?.value;
        if (!value) throw new LlmError(`No credential is configured for existing connection "${provider}".`, 'MISSING_CREDENTIAL');
        return assertUsableApiKey(value, name, profile.apiKeyEnv);
      },
      auth: {
        credentials: {
          async read(provider) { return isCredentialKeySegment(provider) ? piCredential(await ctx.credentials.readRecord(recordKeyFor(provider))) : undefined; },
          async list() { return []; },
          async modify(provider, mutate) {
            if (!isCredentialKeySegment(provider)) throw new LlmError('This provider cannot address a stored credential.', 'UNSTORABLE_PROVIDER_ID');
            return piCredential(await ctx.credentials.modifyRecord(recordKeyFor(provider), async current => {
              const next = await mutate(piCredential(current));
              return next === undefined ? undefined : storedCredential(next);
            }));
          },
          async delete(provider) { if (isCredentialKeySegment(provider)) await ctx.credentials.deleteRecord(recordKeyFor(provider)); },
        },
        authContext: {
          ...ambient,
          async env(ref) {
            if (isCredentialRefName(ref)) { const value = await ctx.credentials.resolve(credentialRef(ref)); if (value) return value.value; }
            return launchEnvironmentOf(ctx).get(ref)?.value;
          },
        },
      },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    },
  });
  ctx.on('llm/stream', (options, next) => fast.stream(options, next));
  const handle = async (action, payload, signal) => {
    try {
      if (signal.aborted) throw new TierError('CANCELLED', 'Request cancelled.');
      switch (action) {
        case 'describe': return { ok: true, value: { ...connections.describe(payload), ...operations.getSession(payload) } };
        case 'session': return { ok: true, value: operations.getSession(payload) };
        case 'set-session': return { ok: true, value: await operations.setSession(payload) };
        case 'diagnostics': return { ok: true, value: domain.global.get() };
        case 'client-ready': {
          if (payload?.slot !== 'conversation.input.right' || payload.registered !== true) throw new TierError('INVALID_SLOT', 'Invalid client slot.');
          await domain.global.set({ ...domain.global.get(), clientSlots: { ...domain.global.get().clientSlots, [payload.slot]: new Date().toISOString() } });
          return { ok: true, value: { registered: true } };
        }
      }
    } catch (error) {
      return { ok: false, error: { code: error instanceof TierError ? error.code : 'OPERATION_FAILED', message: error instanceof TierError ? error.message : 'Unable to read the existing connection. Reload and try again.', details: {} } };
    }
  };
  for (const action of actions) ctx.effect(() => ctx.connection.fetch.register({
    path: `${RPC_CHANNEL}/${RPC_PREFIX}${action}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('Expected application/json.', { status: 415 });
      let body;
      try { body = await request.json(); } catch { return new Response('Expected JSON.', { status: 400 }); }
      const parsed = clientRequestSchema.safeParse(body);
      if (!parsed.success) return new Response('Invalid RPC envelope.', { status: 400 });
      const { rpcId, method, payload } = parsed.data;
      const result = method === `${RPC_PREFIX}${action}` ? await handle(action, payload, request.signal) : { ok: false, error: { code: 'BAD_REQUEST', message: 'RPC method does not match route.', details: {} } };
      return Response.json({ type: 'server-response', rpcId, result });
    },
  }));
  // Share the UI's session operation with agents; no key/configuration tools.
  await ctx.inject(['agents'], async agentCtx => {
    sessionSelection = sessionId => selectionOf(agentCtx.agents.get(sessionId));
    agentCtx.effect(() => () => { sessionSelection = () => undefined; });
    let storedSelection = async () => undefined;
    await agentCtx.inject(['sessionPersistence'], persistenceCtx => {
      storedSelection = async sessionId => {
        let handle;
        try { handle = await persistenceCtx.sessionPersistence.open(sessionId, 'read'); }
        catch (error) { if (error instanceof SessionPersistenceNotFoundError) return undefined; throw error; }
        try { return foldRequestHeader((await handle.read()).events)?.config; }
        finally { await handle.close(); }
      };
      persistenceCtx.effect(() => () => { storedSelection = async () => undefined; });
    });
    const attached = new Map();
    const attach = agent => {
      if (attached.has(agent)) return;
      const dispose = agent.ctx.effect(() => {
        const fiber = agent.ctx.inject(['tools'], toolCtx => toolCtx.tools.register({
          name: 'service_tier', description: 'Read or set this session’s processing mode for its existing connection. OpenAI supports default, fast, ultrafast; Anthropic supports default, fast. Uses the session’s current provider/model unless supplied.',
          parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set'] }, provider: { type: 'string' }, model: { type: 'string' }, tier: { type: 'string', enum: ['default', 'fast', 'ultrafast'] } }, required: ['action'], additionalProperties: false },
          output: { schema: { type: 'object', properties: { sessionId: { type: 'string' }, tier: { type: 'string', enum: ['default', 'fast', 'ultrafast'] }, revision: { type: 'integer' } }, required: ['sessionId', 'tier', 'revision'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute(args, exec) {
            if (exec.signal.aborted) throw new TierError('CANCELLED', 'Request cancelled.');
            const sessionId = String(agent.session.id);
            if (args.action === 'get') return operations.getSession({ ...args, sessionId });
            const active = agent.session.requestHeader?.()?.config;
            return operations.setSession({ provider: active?.provider, model: active?.model, ...args, sessionId, revision: operations.revisionOf(sessionId) });
          },
        }));
        return () => fiber.dispose();
      });
      attached.set(agent, dispose);
    };
    const initialize = async agent => {
      const { origin, parentSession } = agent.session.header;
      if (origin === 'subagent' && parentSession !== undefined) {
        await operations.inheritSession({ sessionId: String(agent.session.id), parentSessionId: String(parentSession),
          resolveParentSelection: () => {
            const parent = agentCtx.agents.get(parentSession);
            return parent ? selectionOf(parent) : storedSelection(parentSession);
          },
        });
      }
      attach(agent);
    };
    agentCtx.effect(() => () => { for (const dispose of attached.values()) dispose(); attached.clear(); });
    // DSH awaits serial creation listeners before the child's first turn can start.
    agentCtx.on('agent/created', async ({ agent }) => { await initialize(agent); });
    agentCtx.on('agent/disposed', ({ agent }) => { attached.get(agent)?.(); attached.delete(agent); });
    // Registration order puts live parents before their children. Backfill existing
    // children on activation; an offline parent's persisted choice still works.
    for (const agent of agentCtx.agents.list()) await initialize(agent);
  });
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'service-tier', description: 'Read or set this session’s processing mode: default (Standard), fast, ultrafast (OpenAI).',
      async handler({ agent, rawInput }) {
        try {
          const sessionId = String(agent.session.id), tier = rawInput.trim();
          if (!tier) return { kind: 'success', text: `Processing mode: ${operations.getSession({ sessionId }).tier}` };
          const active = agent.session.requestHeader()?.config;
          const next = await operations.setSession({ sessionId, provider: active?.provider, model: active?.model, tier: tier === 'standard' ? 'default' : tier, revision: operations.revisionOf(sessionId) });
          return { kind: 'success', text: `Processing mode: ${next.tier}` };
        } catch (error) { return { kind: 'error', text: error instanceof TierError ? error.message : 'Unable to update processing mode.' }; }
      },
    }));
  });
  await domain.global.set({ ...domain.global.get(), hostReady: true });
}
