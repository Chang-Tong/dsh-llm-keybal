/**
 * The per-route key-pool registry: one {@link KeyPool} per model, created
 * from provider configuration with plugin defaults applied. The adapter asks
 * the balancer to acquire a credential and reports outcomes back by entry
 * index.
 *
 * @module dsh-llm-keybal/balancer
 */
import type { KeyBalProviderConfig, KeyBalReasoningEffort } from './config.ts';
import { type ResolvedKeyBalConfig } from './config.ts';
import { type KeyEntry } from './pool.ts';
/** A picked credential plus the pool entry index to report back against. */
export interface PickedCredential {
    entry: KeyEntry;
    entryIndex: number;
}
/** One model pool view with its resolved capacity facts. */
export interface ModelPoolView {
    model: string;
    contextWindow: number;
    maxTokens: number;
    /** Adapter-configured default reasoning effort, when the model pins one. */
    reasoningEffort?: KeyBalReasoningEffort;
    strategy: string;
    status(): Record<string, unknown>;
}
/**
 * Registry of per-model key pools for one provider route. Model config may
 * override the plugin-wide strategy, retry, and cooldown defaults.
 */
export declare class KeyBalancer {
    private readonly profile;
    private readonly defaults;
    private readonly pools;
    constructor(profile: KeyBalProviderConfig, defaults: ResolvedKeyBalConfig);
    /** Pick one credential for a model using the pool's strategy. */
    acquire(model: string): PickedCredential | null;
    /** Report one request outcome against the pool entry that served it. */
    report(model: string, entryIndex: number, ok: boolean, status: number): void;
    /** The pool for one model, when configured. */
    model(model: string): ModelPoolView | undefined;
    /** Every configured model, in configuration order. */
    models(): ModelPoolView[];
    maxRetries(model: string): number;
}
//# sourceMappingURL=balancer.d.ts.map