/**
 * keybal — multi-provider API-key load-balancing LLM adapter.
 *
 * One plugin instance registers a {@link KeyBalAdapter} for every configured
 * provider route; the route key is the provider name shown in selectors
 * (convention `<name>_pool`, e.g. `deepseek_pool`, `openai_pool`,
 * `claude_pool`, `qwen_pool`). Each (provider, model) owns a pool of API
 * keys; requests are load-balanced across them with automatic failover and
 * failure cooldown. Keys are literal configuration values (a key pool is
 * several credentials, not one reference), so this adapter takes them
 * directly from the plugin config rather than through the credential seam.
 *
 * Configuration is editable: the `llm-keybal` user-settings section holds the
 * live provider dict, and profile facts resolve per request, so a changed
 * key, endpoint, model, or knob reaches the next request without a restart.
 * A changed *route set* re-registers the same adapter instance in place.
 *
 * ```yaml
 * - id: llm-keybal
 *   name: 'dsh-llm-keybal'
 *   config:
 *     strategy: round-robin
 *     maxRetries: 2
 *     cooldownMs: 30000
 *     providers:
 *       deepseek_pool:
 *         displayName: DeepSeek 池
 *         baseURL: https://api.deepseek.com
 *         models:
 *           deepseek-v4-flash:
 *             keys: [sk-…, sk-…]
 *       openai_pool:
 *         displayName: OpenAI 池
 *         baseURL: https://api.openai.com/v1
 *         models:
 *           gpt-4o-mini:
 *             keys: [sk-…]
 * ```
 *
 * @module dsh-llm-keybal
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export { KeyBalAdapter } from './adapter.ts';
export type { KeyBalRoute } from './adapter.ts';
export { Config, resolveConfig } from './config.ts';
export type { Config as KeyBalConfig, KeyBalDefaults, KeyBalModelConfig, KeyBalProviderConfig, KeyBalStrategy, ResolvedKeyBalConfig, } from './config.ts';
export { createPool, acquire, report, poolStatus } from './pool.ts';
export type { KeyEntry, KeyPool } from './pool.ts';
export { KeyBalancer } from './balancer.ts';
export type { ModelPoolView, PickedCredential } from './balancer.ts';
export { serializeRequest, serializeMessages } from './serialize.ts';
export { parseSse } from './sse.ts';
export { translate } from './translate.ts';
export type * from './types.ts';
export declare const name = "llm-keybal";
export declare const inject: string[];
/**
 * Register the keybal adapter for every configured provider route. Route
 * facts resolve per request from the live configuration (plugin default +
 * `llm-keybal` settings section), so key, pool, and knob changes reach the
 * next request without a restart; only a changed route set re-registers.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map