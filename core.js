import { z } from 'zod';

export const RPC_CHANNEL = '/api';
export const RPC_PREFIX = 'oheco-service-tier/';
export const FAST_BETA = 'fast-mode-2026-02-01';
export const SUPPORTED_APIS = new Set(['openai-responses', 'openai-completions', 'anthropic-messages']);
export class TierError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const TIERS = ['default', 'fast', 'ultrafast'];
export const sessionRecordSchema = z.object({ tier: z.enum(TIERS), revision: z.number().int().nonnegative() }).strict();
export function tiersForApi(api) {
  if (api === 'openai-responses' || api === 'openai-completions') return [...TIERS];
  return api === 'anthropic-messages' ? ['default', 'fast'] : ['default'];
}
export function defaultModeForApi(api, config = {}) {
  const value = api === 'openai-responses' || api === 'openai-completions' ? config.openaiDefaultMode : api === 'anthropic-messages' ? config.anthropicDefaultMode : undefined;
  return (typeof value?.get === 'function' ? value.get() : value) ?? 'default';
}
export function assertTierForApi(api, tier) {
  if (!tiersForApi(api).includes(tier)) throw new TierError('UNSUPPORTED_TIER', `The connection protocol "${api}" does not support ${tier} mode. Select Standard or a supported mode.`);
}
export function parseSessionId(value) {
  const parsed = z.string().min(1).max(256).safeParse(value);
  if (!parsed.success) throw new TierError('INVALID_SESSION', 'A session ID is required.');
  return parsed.data;
}
export function payloadHook(api, previous, tier = 'fast') {
  assertTierForApi(api, tier);
  return async (payload, model) => {
    const transformed = previous ? await previous(payload, model) : undefined;
    const value = transformed ?? payload;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TierError('INVALID_PAYLOAD', 'Provider payload must be an object.');
    return { ...value, ...(api === 'anthropic-messages' ? { speed: tier } : { service_tier: tier }) };
  };
}
export function fastHeaders(api, headers) {
  if (api !== 'anthropic-messages') return headers;
  const result = new Headers(headers);
  const betas = (result.get('anthropic-beta') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  result.set('anthropic-beta', [...new Set([...betas, FAST_BETA])].join(','));
  return Object.fromEntries(result);
}
export class TierOperations {
  constructor({ sessions, describeModel, defaults = {} }) {
    this.sessions = sessions; this.describeModel = describeModel; this.defaults = defaults; this.writes = Promise.resolve();
  }
  revisionOf(sessionId) { return this.sessions.get(parseSessionId(sessionId))?.revision ?? 0; }
  hasSpeedDefault() { return defaultModeForApi('openai-responses', this.defaults) !== 'default' || defaultModeForApi('anthropic-messages', this.defaults) !== 'default'; }
  getSession(input) {
    const sessionId = parseSessionId(input?.sessionId);
    const record = this.sessions.get(sessionId);
    if (record !== undefined) return { sessionId, tier: record.tier, revision: record.revision };
    const tier = this.hasSpeedDefault() ? defaultModeForApi(this.describeModel(input).api, this.defaults) : 'default';
    return { sessionId, tier, revision: 0 };
  }
  readTier(sessionId, selection) { return sessionId ? this.getSession({ ...selection, sessionId }).tier : 'default'; }
  inheritSession(input) {
    const run = async () => {
      const sessionId = parseSessionId(input?.sessionId);
      const parentSessionId = parseSessionId(input?.parentSessionId);
      if (sessionId === parentSessionId) throw new TierError('INVALID_PARENT', 'A session cannot inherit its own mode.');
      // Existing child choices (including Standard) survive resume and plugin reload.
      if (this.sessions.get(sessionId) !== undefined) return this.getSession({ sessionId });
      const parentSelection = this.sessions.get(parentSessionId) === undefined && this.hasSpeedDefault() ? await input.resolveParentSelection?.() : undefined;
      const tier = this.readTier(parentSessionId, parentSelection);
      // Persist Standard too: later parent changes must not alter an existing child.
      await this.sessions.put(sessionId, { tier, revision: 1 });
      return this.getSession({ sessionId });
    };
    const result = this.writes.then(run);
    this.writes = result.catch(() => {});
    return result;
  }
  setSession(input) {
    const run = async () => {
      const sessionId = parseSessionId(input?.sessionId);
      const state = { sessionId, revision: this.revisionOf(sessionId) };
      if (!TIERS.includes(input?.tier)) throw new TierError('INVALID_TIER', 'Choose Standard, Fast, or Ultrafast.');
      if (input.revision !== state.revision) throw new TierError('SESSION_CONFLICT', 'The mode changed in another view. Reload before saving.');
      // Turning Fast off must always work, even if a connection was removed.
      if (input.tier !== 'default') {
        const model = await this.describeModel(input);
        if (!model.supported) throw new TierError('UNSUPPORTED_PROTOCOL', 'This connection protocol does not support the fast-mode request parameters.');
        assertTierForApi(model.api, input.tier);
      }
      await this.sessions.put(state.sessionId, { tier: input.tier, revision: state.revision + 1 });
      return this.getSession(input);
    };
    const result = this.writes.then(run);
    this.writes = result.catch(() => {});
    return result;
  }
}
export class RequestTiers {
  constructor(readTier) { this.readTier = readTier; this.snapshots = new WeakMap(); }
  capture(options) {
    if (this.snapshots.has(options)) return this.snapshots.get(options);
    const tier = options.purpose || !options.sessionId ? 'default' : this.readTier(options.sessionId, options);
    const captured = { tier, adapter: undefined };
    this.snapshots.set(options, captured);
    return captured;
  }
}
