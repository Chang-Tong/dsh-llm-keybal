/**
 * The keybal LlmAdapter: one instance serves every configured provider route,
 * routing each stream call through the route's per-model key pool with
 * automatic failover. Transport is the standard OpenAI-compatible
 * chat-completions SSE endpoint reached through the global `fetch`; a failed
 * or rate-limited key is reported back to the pool and the next key tried,
 * up to the pool's maxRetries.
 *
 * @module dsh-llm-keybal/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ResolvedKeyBalConfig } from './config.ts';
import { KeyBalancer } from './balancer.ts';
/** One provider route's per-model pools plus its endpoint. */
export interface KeyBalRoute {
    baseURL: string;
    displayName?: string;
    pools: KeyBalancer;
}
/**
 * Load-balancing LlmAdapter. Route facts are re-read from the provider
 * function per operation so a configuration change reaches the next request
 * without re-registration.
 */
export declare class KeyBalAdapter extends LlmAdapter {
    private readonly routes;
    constructor(routes: () => ReadonlyMap<string, KeyBalRoute>);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Stream one model call. Picks a key from the route's pool, performs the
     * request, and on a failure reports the key and retries with the next one
     * (up to the pool's maxRetries). Chunks pass through the SSE translation.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private acquireCredential;
    private requestOnce;
}
/** Resolve the adapter routes from a resolved configuration snapshot. */
export declare function buildRoutes(config: ResolvedKeyBalConfig): Map<string, KeyBalRoute>;
//# sourceMappingURL=adapter.d.ts.map