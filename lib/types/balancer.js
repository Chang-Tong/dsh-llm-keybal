/**
 * The per-route key-pool registry: one {@link KeyPool} per model, created
 * from provider configuration with plugin defaults applied. The adapter asks
 * the balancer to acquire a credential and reports outcomes back by entry
 * index.
 *
 * @module dsh-llm-keybal/balancer
 */
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./config.js";
import { acquire, createPool, report } from "./pool.js";
/**
 * Registry of per-model key pools for one provider route. Model config may
 * override the plugin-wide strategy, retry, and cooldown defaults.
 */
export class KeyBalancer {
    profile;
    defaults;
    pools = new Map();
    constructor(profile, defaults) {
        this.profile = profile;
        this.defaults = defaults;
        for (const [model, config] of Object.entries(profile.models)) {
            this.pools.set(model, createPool(config.keys, {
                strategy: config.strategy ?? defaults.strategy,
                cooldownMs: config.cooldownMs ?? defaults.cooldownMs,
                maxRetries: config.maxRetries ?? defaults.maxRetries,
            }, model));
        }
    }
    /** Pick one credential for a model using the pool's strategy. */
    acquire(model) {
        const pool = this.pools.get(model);
        if (pool === undefined)
            return null;
        const entry = acquire(pool);
        if (entry === null)
            return null;
        return { entry, entryIndex: pool.entries.indexOf(entry) };
    }
    /** Report one request outcome against the pool entry that served it. */
    report(model, entryIndex, ok, status) {
        const pool = this.pools.get(model);
        if (pool === undefined)
            return;
        const entry = pool.entries[entryIndex];
        if (entry === undefined)
            return;
        report(pool, entry, ok, status);
    }
    /** The pool for one model, when configured. */
    model(model) {
        const pool = this.pools.get(model);
        if (pool === undefined)
            return undefined;
        const config = this.profile.models[model];
        return {
            model,
            contextWindow: config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...config?.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
            strategy: pool.strategy,
            status: () => ({
                strategy: pool.strategy,
                total: pool.entries.length,
                healthy: pool.entries.filter(entry => entry.disabledUntil <= Date.now()).length,
                cooling: pool.entries.filter(entry => entry.disabledUntil > Date.now()).length,
                uses: pool.entries.reduce((sum, entry) => sum + entry.uses, 0),
                failures: pool.entries.reduce((sum, entry) => sum + entry.failures, 0),
                inflight: pool.entries.reduce((sum, entry) => sum + entry.inflight, 0),
            }),
        };
    }
    /** Every configured model, in configuration order. */
    models() {
        return Object.keys(this.profile.models)
            .map(model => this.model(model))
            .filter((view) => view !== undefined);
    }
    maxRetries(model) {
        return this.profile.models[model]?.maxRetries ?? this.defaults.maxRetries;
    }
}
//# sourceMappingURL=balancer.js.map