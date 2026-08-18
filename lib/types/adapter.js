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
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { KeyBalancer } from "./balancer.js";
import { assertSupportedEffort, serializeRequest } from "./serialize.js";
import { parseSse } from "./sse.js";
import { translate } from "./translate.js";
/** Map an HTTP status to a stable harness error code. */
function httpErrorCode(status, error) {
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
    if (status === 401 || status === 403)
        return 'AUTH';
    if (detail.includes('insufficient_quota') || detail.includes('quota'))
        return 'QUOTA';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400)
        return 'INVALID_REQUEST';
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
/* jscpd:ignore-start -- Retry-After parsing shared with llm-deepseek. */
function providerRetryAfterMs(value) {
    if (value === null)
        return undefined;
    if (/^\d+$/.test(value)) {
        const delay = Number(value) * 1_000;
        return Number.isFinite(delay) && delay > 0 ? delay : undefined;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
/**
 * Load-balancing LlmAdapter. Route facts are re-read from the provider
 * function per operation so a configuration change reaches the next request
 * without re-registration.
 */
export class KeyBalAdapter extends LlmAdapter {
    routes;
    constructor(routes) {
        super();
        this.routes = routes;
    }
    providerInfo(provider) {
        return { id: provider, name: this.routes().get(provider)?.displayName ?? provider };
    }
    listModels(provider) {
        const route = this.routes().get(provider);
        if (route === undefined)
            return Promise.resolve([]);
        return Promise.resolve(route.pools.models().map((pool) => ({
            provider,
            id: pool.model,
            name: pool.model,
            inputModalities: ['text'],
        })));
    }
    resolveModel(provider, model, _signal) {
        const route = this.routes().get(provider);
        const pool = route?.pools.model(model);
        return Promise.resolve({
            provider,
            id: model,
            name: model,
            inputModalities: ['text'],
            ...pool === undefined ? {} : { context: { contextWindow: pool.contextWindow }, defaultMaxTokens: pool.maxTokens },
        });
    }
    /**
     * Stream one model call. Picks a key from the route's pool, performs the
     * request, and on a failure reports the key and retries with the next one
     * (up to the pool's maxRetries). Chunks pass through the SSE translation.
     */
    async *stream(options) {
        assertSupportedEffort(options.reasoningEffort);
        const route = this.routes().get(options.provider);
        if (route === undefined) {
            yield {
                type: 'finish',
                reason: { kind: 'error', failure: { message: `no keybal route for provider "${options.provider}"`, code: 'NO_ADAPTER' } },
            };
            return;
        }
        const body = serializeRequest(options);
        const attempts = 1 + route.pools.maxRetries(options.model);
        for (let attempt = 0; attempt < attempts; attempt++) {
            const credential = this.acquireCredential(route, options.model);
            if (credential === null) {
                yield {
                    type: 'finish',
                    reason: { kind: 'error', failure: { message: `provider "${options.provider}" model "${options.model}" has no keys configured`, code: 'MISSING_CREDENTIAL' } },
                };
                return;
            }
            const outcome = await this.requestOnce(route, credential, body, options);
            route.pools.report(options.model, credential.entryIndex, outcome.ok, outcome.status);
            if (outcome.ok) {
                yield* outcome.chunks;
                return;
            }
            // A request-shape error is not a key problem; do not burn retries on it.
            if (outcome.status === 400 || outcome.status === 404 || outcome.status === 422) {
                yield* outcome.chunks;
                return;
            }
            if (attempt === attempts - 1)
                yield* outcome.chunks;
        }
    }
    acquireCredential(route, model) {
        const picked = route.pools.acquire(model);
        if (picked === null)
            return null;
        return { key: picked.entry.key, entryIndex: picked.entryIndex };
    }
    async requestOnce(route, credential, body, options) {
        const controller = new AbortController();
        const signal = options.signal === undefined
            ? controller.signal
            : AbortSignal.any([options.signal, controller.signal]);
        try {
            const response = await fetch(`${route.baseURL.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${credential.key}`,
                    'content-type': 'application/json',
                    'accept': 'text/event-stream',
                    ...attributionHeaders(),
                },
                body: JSON.stringify(body),
                signal,
            });
            if (!response.ok) {
                let message = `keybal upstream error (HTTP ${response.status})`;
                try {
                    const parsed = await response.json();
                    if (parsed.error?.message)
                        message = parsed.error.message;
                }
                catch {
                    // The HTTP status still identifies the failure.
                }
                const delay = providerRetryAfterMs(response.headers.get('retry-after'));
                throw new LlmError(message, httpErrorCode(response.status), {
                    status: response.status,
                    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
                });
            }
            if (response.body === null) {
                throw new LlmError('keybal upstream returned no response body', 'EMPTY_RESPONSE');
            }
            const chunks = [];
            for await (const chunk of translate(parseSse(response.body))) {
                chunks.push(chunk);
            }
            return { ok: true, status: 200, chunks };
        }
        catch (error) {
            if (options.signal?.aborted) {
                return {
                    ok: true,
                    status: 0,
                    chunks: [{
                            type: 'finish',
                            reason: {
                                kind: 'aborted',
                                failure: { message: 'keybal request aborted by caller', code: 'ABORTED' },
                            },
                        }],
                };
            }
            const failure = error instanceof LlmError
                ? error
                : new LlmError(`keybal request failed: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT');
            const status = failure.failure.status;
            return {
                ok: false,
                status: status ?? 0,
                chunks: [{
                        type: 'finish',
                        reason: {
                            kind: 'error',
                            failure: {
                                message: failure.message,
                                code: failure.code,
                                ...status !== undefined ? { status } : {},
                            },
                        },
                    }],
            };
        }
        finally {
            controller.abort('keybal stream consumer stopped');
        }
    }
}
/** Resolve the adapter routes from a resolved configuration snapshot. */
export function buildRoutes(config) {
    const routes = new Map();
    for (const [provider, profile] of Object.entries(config.providers)) {
        const pools = new KeyBalancer(profile, config);
        routes.set(provider, {
            baseURL: profile.baseURL,
            ...profile.displayName === undefined ? {} : { displayName: profile.displayName },
            pools,
        });
    }
    return routes;
}
//# sourceMappingURL=adapter.js.map