/**
 * The key pool: per-(provider, model) API-key entries with load-balancing
 * strategies, failure tracking, and cooldown. This is the load-balancing core
 * of the keybal adapter. One `KeyPool` owns the keys of exactly one model on
 * one provider route; `KeyBalancer` owns every pool of one adapter instance.
 *
 * @module dsh-llm-keybal/pool
 */
import type { KeyBalStrategy } from './config.ts';
/** One API key's live state within a pool. */
export interface KeyEntry {
    /** The credential, sent as `Authorization: Bearer <key>`. */
    key: string;
    /** Successful requests served by this key. */
    uses: number;
    /** Failed requests served by this key. */
    failures: number;
    /** Consecutive failures since the last success; drives cooldown. */
    consecutiveFailures: number;
    /** Epoch ms until the key is eligible again; 0 means healthy. */
    disabledUntil: number;
    /** Requests currently in flight on this key. */
    inflight: number;
}
/** One key pool for a (provider, model) pair. */
export interface KeyPool {
    model: string;
    strategy: KeyBalStrategy;
    cooldownMs: number;
    maxRetries: number;
    /** Round-robin cursor; modulo the healthy length at pick time. */
    rr: number;
    entries: KeyEntry[];
}
export interface KeyPoolOptions {
    strategy: KeyBalStrategy;
    cooldownMs: number;
    maxRetries: number;
}
/** Create one pool over the given keys. */
export declare function createPool(keys: readonly string[], options: KeyPoolOptions, model: string): KeyPool;
/**
 * Acquire one key for a request. Skips cooling keys; when every key is
 * cooling, falls back to the key closest to recovery so a degraded pool keeps
 * serving rather than deadlocking. Selection honors the pool strategy; the
 * round-robin cursor advances past the picked entry.
 */
export declare function acquire(pool: KeyPool): KeyEntry | null;
/**
 * Report one request outcome back to the pool. Success resets the
 * consecutive-failure streak; failure marks the key, and a key that fails
 * twice in a row (or with an auth error) enters cooldown for {@link KeyPool.cooldownMs}.
 */
export declare function report(pool: KeyPool, entry: KeyEntry, ok: boolean, status: number): void;
/** Detached pool health view for diagnostics. */
export declare function poolStatus(pool: KeyPool, now?: number): Record<string, unknown>;
//# sourceMappingURL=pool.d.ts.map