import { AsyncLocalStorage } from 'node:async_hooks';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { fastHeaders, payloadHook, RequestTiers, SUPPORTED_APIS, tiersForApi, TierError } from './core.js';

const protocols = { 'openai-responses': openAIResponsesApi, 'openai-completions': openAICompletionsApi, 'anthropic-messages': anthropicMessagesApi };
const catalogProviders = new Map(builtinProviders().map(provider => [provider.id, provider]));
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const compatFields = {
  'openai-responses': new Set(['supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention']),
  'openai-completions': new Set(['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat', 'chatTemplateKwargs', 'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField', 'vllmPriority', 'supportsStrictMode', 'cacheControlFormat', 'supportsLongCacheRetention']),
  'anthropic-messages': new Set(['supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools']),
};
const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Resolve just the selected model from the existing pi-ai route configuration.
 * Field precedence follows DSH llm-pi-ai 0.2.0-rc.2 (MIT); no route is registered.
 */
export function resolveRouteModel(provider, source, id) {
  const catalogProvider = catalogProviders.get(provider);
  const catalog = new Map((catalogProvider ? getBuiltinModels(provider) : []).map(model => [model.id, model]));
  const entries = source.models?.length ? source.models : [...catalog.values()].map(model => ({ id: model.id, ...source.modelOverrides?.[model.id] }));
  const entry = entries.find(model => model.id === id);
  if (!entry) throw new TierError('MODEL_NOT_CONFIGURED', 'The selected model is no longer in this connection.');
  const base = catalog.get(id);
  const apis = new Set([...catalog.values()].map(model => model.api));
  const api = source.api ?? base?.api ?? (apis.size === 1 ? [...apis][0] : undefined);
  const baseUrl = source.baseURL ?? base?.baseUrl ?? catalogProvider?.baseUrl;
  const model = {
    ...base, id, name: entry.name ?? base?.name ?? id, provider, api, baseUrl,
    reasoning: base?.reasoning ?? false,
    input: entry.input ?? base?.input ?? source.defaultInput ?? ['text'],
    cost: base?.cost ?? noCost,
    contextWindow: entry.contextWindow ?? base?.contextWindow ?? source.defaultContextWindow ?? 262144,
    maxTokens: entry.maxTokens ?? base?.maxTokens ?? source.defaultMaxTokens ?? 32768,
  };
  if (entry.reasoningEfforts === false) { model.reasoning = false; delete model.thinkingLevelMap; }
  else if (entry.reasoningEfforts != null) {
    model.reasoning = true;
    model.thinkingLevelMap = Object.fromEntries(levels.flatMap(level => {
      const value = entry.reasoningEfforts[level];
      return level === 'off' && value === null ? [] : [[level, value ?? null]];
    }));
  }
  const valid = compat => Object.fromEntries(Object.entries(compat ?? {}).filter(([field, value]) => compatFields[api]?.has(field) && value != null && !(typeof value === 'object' && Object.keys(value).length === 0)));
  const configuredCompat = { ...valid(source.compat), ...valid(entry.compat) };
  if (Object.keys(configuredCompat).length) model.compat = { ...base?.api === api ? base.compat : undefined, ...configuredCompat };
  return { model, entry, catalogProvider };
}

export class ExistingConnections {
  constructor({ directory, settings, activeProviders }) { this.directory = directory; this.settings = settings; this.activeProviders = activeProviders; this.cached = new Map(); }
  selection(input) {
    if (typeof input?.provider !== 'string' || typeof input?.model !== 'string') return undefined;
    const route = this.directory().find(entry => entry.provider === input.provider);
    if (!route) return undefined;
    const row = this.settings().find(entry => entry.ns === route.settingsNs);
    if (!row) return undefined;
    let source = row.value;
    for (const key of route.settingsPath) source = source?.[key];
    if (!source || typeof source !== 'object') return undefined;
    // Cache by settings namespace/revision and model, never by URL or model name alone.
    const key = JSON.stringify([route.settingsNs, row.revision, input.provider, input.model]);
    if (this.cached.has(key)) return this.cached.get(key);
    const resolved = resolveRouteModel(input.provider, source, input.model);
    const active = this.activeProviders?.();
    const replayProviders = this.directory().filter(entry => entry.settingsNs === route.settingsNs && (!active || active.includes(entry.provider))).map(entry => entry.provider);
    const value = { ...resolved, source: structuredClone(source), supported: SUPPORTED_APIS.has(resolved.model.api), replayProviders };
    this.cached.set(key, value);
    if (this.cached.size > 200) this.cached.delete(this.cached.keys().next().value);
    return value;
  }
  describe(input) {
    const selected = this.selection(input);
    return { provider: input?.provider ?? null, model: input?.model ?? null, api: selected?.model.api ?? null, supported: selected?.supported ?? false, tiers: tiersForApi(selected?.model.api) };
  }
}

/** Iterate an adapter under one captured async scope, including cancellation. */
async function* scopedIterator(scope, captured, create) {
  const iterator = scope.run(captured, () => create()[Symbol.asyncIterator]());
  let done = false;
  try {
    while (true) {
      const item = await scope.run(captured, () => iterator.next());
      if (item.done) { done = true; return; }
      yield item.value;
    }
  } finally { if (!done && iterator.return) await scope.run(captured, () => iterator.return()); }
}
export class FastRequests {
  constructor({ connections, readTier, adapterConfig, requestServices = () => ({}) }) {
    this.connections = connections; this.tiers = new RequestTiers(readTier);
    this.scope = new AsyncLocalStorage(); this.adapterConfig = adapterConfig; this.requestServices = requestServices;
  }
  adapter(selected) {
    const { model, source, entry, catalogProvider } = selected;
    const api = protocols[model.api]();
    let auth = catalogProvider?.auth;
    const harnessKeyAuth = { name: 'Existing DSH connection', resolve: async ({ credential }) => ({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'DSH credentials' }) };
    if (!auth) auth = { apiKey: harnessKeyAuth };
    else if (!auth.apiKey && source.apiKeyEnv !== undefined) auth = { ...auth, apiKey: harnessKeyAuth };
    const decorate = options => {
      const captured = this.scope.getStore();
      if (!captured) throw new LlmError('Fast request scope is missing.', 'INVALID_CONFIG');
      return { ...options, headers: fastHeaders(model.api, options?.headers), onPayload: payloadHook(model.api, options?.onPayload, captured.tier) };
    };
    const provider = {
      ...(catalogProvider ?? {}), id: model.provider, name: source.displayName ?? model.provider,
      ...(source.baseURL ? { baseUrl: source.baseURL } : {}), auth,
      getModels: () => [model],
      stream: (target, context, options) => api.stream(target, context, decorate(options)),
      streamSimple: (target, context, options) => api.streamSimple(target, context, decorate(options)),
    };
    const profile = {
      ...source, provider: model.provider, displayName: source.displayName ?? model.provider, piProvider: provider,
      modelErrors: new Map(), configuredMaxTokens: new Map(entry.maxTokens === undefined ? [] : [[model.id, entry.maxTokens]]),
      streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? 300000,
      maxRequestImageBytes: source.maxRequestImageBytes ?? 20971520,
      requestImagePixelBudget: source.requestImagePixelBudget ?? 4194304,
      requestImageMaxBytes: source.requestImageMaxBytes ?? 1048576,
      retryPolicy: resolveRetryPolicy(source.retryPolicy),
    };
    return new PiAiAdapter({ ...this.adapterConfig, profiles: () => new Map([[model.provider, profile]]) });
  }
  /** The standard path calls next unchanged; fast never silently falls back. */
  stream(options, next) {
    const captured = this.tiers.capture(options);
    if (captured.tier === 'default') return next();
    if (captured.adapter === undefined) {
      const selected = this.connections.selection(options);
      // Other protocols use their normal path; a session choice must not affect them.
      if (!selected?.supported) { captured.adapter = null; return next(); }
      if (!tiersForApi(selected.model.api).includes(captured.tier)) {
        captured.failure = new LlmError(`The connection protocol "${selected.model.api}" does not support ${captured.tier} mode. Select Standard or a supported mode.`, 'UNSUPPORTED_TIER').failure;
        captured.adapter = null;
      } else {
        captured.adapter = this.adapter(selected);
        captured.replayProviders = selected.replayProviders;
      }
    }
    if (captured.failure) return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: captured.failure } }; })();
    if (captured.adapter === null) return next();
    return this.run(options, captured);
  }
  async *run(options, captured) {
    const requestCtx = new Context();
    try {
      for (const [name, service] of Object.entries(this.requestServices())) if (service !== undefined) requestCtx.provide(name, service);
      const runtime = new LlmRuntime(requestCtx);
      // Private request runtime only: the host registry/model catalog is untouched.
      // Register the existing adapter family's identities so its durable replay ownership survives.
      runtime.registerAdapter(captured.replayProviders, captured.adapter);
      yield* scopedIterator(this.scope, captured, () => runtime.stream(options));
    } catch (error) {
      const failure = error instanceof LlmError ? error.failure : { code: 'ADAPTER_ERROR', message: error instanceof Error ? error.message : 'Model request failed.' };
      yield { type: 'finish', reason: { kind: options.signal?.aborted || failure.code === 'ABORTED' ? 'aborted' : 'error', failure } };
    } finally { await requestCtx.fiber.dispose(); }
  }
}
