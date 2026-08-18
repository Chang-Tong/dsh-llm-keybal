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
import { KeyBalAdapter, buildRoutes } from "./adapter.js";
import { assertServiceable, resolveConfig } from "./config.js";
export { KeyBalAdapter } from "./adapter.js";
export { Config, resolveConfig } from "./config.js";
export { createPool, acquire, report, poolStatus } from "./pool.js";
export { KeyBalancer } from "./balancer.js";
export { serializeRequest, serializeMessages } from "./serialize.js";
export { parseSse } from "./sse.js";
export { translate } from "./translate.js";
export const name = 'llm-keybal';
export const inject = ['llm'];
/**
 * Register the keybal adapter for every configured provider route. Routes are
 * a static composition fact (keys are literal config), so there is no
 * settings section: re-registration is unnecessary because route and pool
 * facts never change after load.
 */
export function apply(ctx, config) {
    assertServiceable(config);
    const resolved = resolveConfig(config);
    const routes = buildRoutes(resolved);
    const routeNames = [...routes.keys()];
    const adapter = new KeyBalAdapter(() => routes);
    if (routeNames.length > 0) {
        ctx.llm.registerAdapter(routeNames, adapter);
    }
    ctx.logger.info(`llm-keybal: registered ${routeNames.length} provider route(s): ${routeNames.join(', ')}`);
}
//# sourceMappingURL=index.js.map