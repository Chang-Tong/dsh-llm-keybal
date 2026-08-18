/**
 * The key pool: per-(provider, model) API-key entries with load-balancing
 * strategies, failure tracking, and cooldown. This is the load-balancing core
 * of the keybal adapter. One `KeyPool` owns the keys of exactly one model on
 * one provider route; `KeyBalancer` owns every pool of one adapter instance.
 *
 * @module dsh-llm-keybal/pool
 */

import type { KeyBalStrategy } from './config.ts'

/** One API key's live state within a pool. */
export interface KeyEntry {
  /** The credential, sent as `Authorization: Bearer <key>`. */
  key: string
  /** Successful requests served by this key. */
  uses: number
  /** Failed requests served by this key. */
  failures: number
  /** Consecutive failures since the last success; drives cooldown. */
  consecutiveFailures: number
  /** Epoch ms until the key is eligible again; 0 means healthy. */
  disabledUntil: number
  /** Requests currently in flight on this key. */
  inflight: number
}

/** One key pool for a (provider, model) pair. */
export interface KeyPool {
  model: string
  strategy: KeyBalStrategy
  cooldownMs: number
  maxRetries: number
  /** Round-robin cursor; modulo the healthy length at pick time. */
  rr: number
  entries: KeyEntry[]
}

export interface KeyPoolOptions {
  strategy: KeyBalStrategy
  cooldownMs: number
  maxRetries: number
}

/** Create one pool over the given keys. */
export function createPool(keys: readonly string[], options: KeyPoolOptions, model: string): KeyPool {
  return {
    model,
    strategy: options.strategy,
    cooldownMs: options.cooldownMs,
    maxRetries: options.maxRetries,
    rr: 0,
    entries: keys.map(key => ({
      key,
      uses: 0,
      failures: 0,
      consecutiveFailures: 0,
      disabledUntil: 0,
      inflight: 0,
    })),
  }
}

function healthy(now: number, entries: readonly KeyEntry[]): KeyEntry[] {
  return entries.filter(entry => entry.disabledUntil <= now)
}

function pickRandom(entries: readonly KeyEntry[]): KeyEntry {
  return entries[Math.floor(Math.random() * entries.length)] as KeyEntry
}

/**
 * Acquire one key for a request. Skips cooling keys; when every key is
 * cooling, falls back to the key closest to recovery so a degraded pool keeps
 * serving rather than deadlocking. Selection honors the pool strategy; the
 * round-robin cursor advances past the picked entry.
 */
export function acquire(pool: KeyPool): KeyEntry | null {
  const now = Date.now()
  const ready = healthy(now, pool.entries)
  if (ready.length === 0) {
    if (pool.entries.length === 0) return null
    const soonest = [...pool.entries].sort((a, b) => a.disabledUntil - b.disabledUntil)[0] as KeyEntry
    soonest.inflight++
    return soonest
  }
  let entry: KeyEntry
  if (pool.strategy === 'random') {
    entry = pickRandom(ready)
  } else if (pool.strategy === 'least-used') {
    entry = ready.reduce((a, b) => (a.inflight + a.uses) <= (b.inflight + b.uses) ? a : b)
  } else if (pool.strategy === 'health') {
    entry = ready.reduce((a, b) => (a.failures * 10 + a.uses) <= (b.failures * 10 + b.uses) ? a : b)
  } else {
    entry = ready[pool.rr % ready.length] as KeyEntry
    pool.rr = (pool.rr + 1) % ready.length
  }
  entry.inflight++
  return entry
}

/**
 * Report one request outcome back to the pool. Success resets the
 * consecutive-failure streak; failure marks the key, and a key that fails
 * twice in a row (or with an auth error) enters cooldown for {@link KeyPool.cooldownMs}.
 */
export function report(pool: KeyPool, entry: KeyEntry, ok: boolean, status: number): void {
  entry.inflight = Math.max(0, entry.inflight - 1)
  entry.uses++
  if (ok) {
    entry.consecutiveFailures = 0
    return
  }
  entry.failures++
  entry.consecutiveFailures++
  if (entry.consecutiveFailures >= 2 || status === 401 || status === 403) {
    entry.disabledUntil = Date.now() + pool.cooldownMs
  }
}

/** Detached pool health view for diagnostics. */
export function poolStatus(pool: KeyPool, now = Date.now()): Record<string, unknown> {
  return {
    model: pool.model,
    strategy: pool.strategy,
    total: pool.entries.length,
    healthy: healthy(now, pool.entries).length,
    cooling: pool.entries.filter(entry => entry.disabledUntil > now).length,
    uses: pool.entries.reduce((sum, entry) => sum + entry.uses, 0),
    failures: pool.entries.reduce((sum, entry) => sum + entry.failures, 0),
    inflight: pool.entries.reduce((sum, entry) => sum + entry.inflight, 0),
  }
}
