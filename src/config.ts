/**
 * Configuration schema for the keybal adapter. One plugin instance owns a
 * dict of provider routes; the dict key IS the route shown to the harness
 * (convention: `<name>_pool`, e.g. `deepseek_pool`, `openai_pool`,
 * `claude_pool`, `qwen_pool`). Each route declares its endpoint and a
 * per-model key pool — the same (provider, model) can hold many API keys and
 * requests are load-balanced across them with automatic failover.
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
 *             keys: [sk-a, sk-b, sk-c]
 *       qwen_pool:
 *         baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
 *         models:
 *           qwen-max:
 *             keys: [sk-x, sk-y]
 * ```
 *
 * @module dsh-llm-keybal/config
 */

import z from '@deepseek-ai/schemastery'

/** Context capacity assumed for a model with no configured capacity. */
export const DEFAULT_CONTEXT_WINDOW = 131_072

/** Output capability assumed for a model with no configured cap. */
export const DEFAULT_MAX_TOKENS = 8_192

/** Load-balancing strategy for one key pool. */
export type KeyBalStrategy = 'round-robin' | 'random' | 'least-used' | 'health'

/** Plugin-wide defaults; a model entry may override each field. */
export interface KeyBalDefaults {
  strategy: KeyBalStrategy
  /** Additional key attempts after the first failure (total = 1 + maxRetries). */
  maxRetries: number
  /** Millisecond cooldown applied to a key after repeated failures. */
  cooldownMs: number
}
export interface KeyBalModelConfig {
  /** API keys for this model, load-balanced across. */
  keys: string[]
  /** Selector label; defaults to the model id. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap materialized when the caller omits one. */
  maxTokens?: number
  /** Pool-local strategy override. */
  strategy?: KeyBalStrategy
  /** Pool-local retry override. */
  maxRetries?: number
  /** Pool-local cooldown override. */
  cooldownMs?: number
}

/** One provider route owned by this plugin. */
export interface KeyBalProviderConfig {
  /** Human-readable provider name for selectors; defaults to the route key. */
  displayName?: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Per-model key pools, keyed by model id. */
  models: Record<string, KeyBalModelConfig>
}

const KeyBalStrategySchema: z<KeyBalStrategy> = z.union(['round-robin', 'random', 'least-used', 'health'])

const modelConfig: z<KeyBalModelConfig> = z.object({
  keys: z.array(z.string()).default([]),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  strategy: KeyBalStrategySchema,
  maxRetries: z.number().step(1).min(0),
  cooldownMs: z.natural(),
})

const providerConfig: z<KeyBalProviderConfig> = z.object({
  displayName: z.string(),
  baseURL: z.string().required(),
  models: z.dict(modelConfig).default({}),
})

/** Plugin configuration. All fields optional in yml: the schema fills defaults. */
export interface Config {
  strategy?: KeyBalStrategy
  maxRetries?: number
  cooldownMs?: number
  /** Provider routes, keyed by route (convention `<name>_pool`). */
  providers: Record<string, KeyBalProviderConfig>
}

/** Runtime schema for {@link Config}; fills every default. */
export const Config: z<Config> = z.object({
  strategy: KeyBalStrategySchema.default('round-robin'),
  maxRetries: z.number().step(1).min(0).default(2),
  cooldownMs: z.natural().default(30000),
  providers: z.dict(providerConfig).default({}),
})

/** A fully-defaulted config snapshot, as the adapter consumes it. */
export interface ResolvedKeyBalConfig {
  strategy: KeyBalStrategy
  maxRetries: number
  cooldownMs: number
  providers: Record<string, KeyBalProviderConfig>
}

/** Materialize every schema default into one resolved snapshot. */
export function resolveConfig(config: Config): ResolvedKeyBalConfig {
  return {
    strategy: config.strategy ?? 'round-robin',
    maxRetries: config.maxRetries ?? 2,
    cooldownMs: config.cooldownMs ?? 30000,
    providers: config.providers,
  }
}

/**
 * Reject a configuration the adapter could not serve, naming the offending
 * route or model. Keys are the whole credential plane here (unlike
 * reference-based adapters), so an empty pool is the one unserviceable shape.
 */
export function assertServiceable(config: Config): void {
  for (const [provider, profile] of Object.entries(config.providers)) {
    if (profile.baseURL.length === 0) {
      throw new Error(`keybal: provider "${provider}" needs a non-empty baseURL`)
    }
    for (const [model, entry] of Object.entries(profile.models)) {
      if (entry.keys.length === 0) {
        throw new Error(`keybal: provider "${provider}" model "${model}" has no keys configured`)
      }
    }
  }
}
