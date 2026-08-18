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
import z from '@deepseek-ai/schemastery';
/** Context capacity assumed for a model with no configured capacity. */
export const DEFAULT_CONTEXT_WINDOW = 131_072;
/** Output capability assumed for a model with no configured cap. */
export const DEFAULT_MAX_TOKENS = 8_192;
const KeyBalStrategySchema = z.union(['round-robin', 'random', 'least-used', 'health']);
const reasoningEffortSchema = z.union(['off', 'high', 'max']);
const modelConfig = z.object({
    keys: z.array(z.string()).default([]),
    name: z.string(),
    description: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
    reasoningEffort: reasoningEffortSchema,
    strategy: KeyBalStrategySchema,
    maxRetries: z.number().step(1).min(0),
    cooldownMs: z.natural(),
});
const providerConfig = z.object({
    displayName: z.string(),
    baseURL: z.string().required(),
    models: z.dict(modelConfig).default({}),
});
/** Runtime schema for {@link Config}; fills every default. */
export const Config = z.object({
    strategy: KeyBalStrategySchema.default('round-robin'),
    maxRetries: z.number().step(1).min(0).default(2),
    cooldownMs: z.natural().default(30000),
    providers: z.dict(providerConfig).default({}),
});
/** Materialize every schema default into one resolved snapshot. */
export function resolveConfig(config) {
    return {
        strategy: config.strategy ?? 'round-robin',
        maxRetries: config.maxRetries ?? 2,
        cooldownMs: config.cooldownMs ?? 30000,
        providers: config.providers,
    };
}
/**
 * Reject a configuration the adapter could not serve, naming the offending
 * route or model. Keys are the whole credential plane here (unlike
 * reference-based adapters), so an empty pool is the one unserviceable shape;
 * a route with no models serves nothing either.
 */
export function assertServiceable(config) {
    for (const [provider, profile] of Object.entries(config.providers)) {
        if (profile.baseURL.length === 0) {
            throw new Error(`keybal: provider "${provider}" needs a non-empty baseURL`);
        }
        if (Object.keys(profile.models).length === 0) {
            throw new Error(`keybal: provider "${provider}" has no models configured`);
        }
        for (const [model, entry] of Object.entries(profile.models)) {
            if (entry.keys.length === 0) {
                throw new Error(`keybal: provider "${provider}" model "${model}" has no keys configured`);
            }
        }
    }
}
//# sourceMappingURL=config.js.map