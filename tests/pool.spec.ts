/**
 * Key-pool unit tests: strategies, cooldown, failover counting, and
 * all-keys-cooling fallback.
 */

import { describe, expect, it, vi } from 'vitest'
import { acquire, createPool, poolStatus, report, type KeyPool } from '../src/pool.ts'

function pool(keys: string[], strategy: 'round-robin' | 'random' | 'least-used' | 'health'): KeyPool {
  return createPool(keys, { strategy, cooldownMs: 1000, maxRetries: 2 }, 'mock-model')
}

describe('round-robin', () => {
  it('cycles through keys in order', () => {
    const p = pool(['a', 'b', 'c'], 'round-robin')
    expect(acquire(p)!.key).toBe('a')
    expect(acquire(p)!.key).toBe('b')
    expect(acquire(p)!.key).toBe('c')
    expect(acquire(p)!.key).toBe('a')
  })

  it('skips cooling keys', () => {
    const p = pool(['a', 'b'], 'round-robin')
    const first = acquire(p)!
    report(p, first, false, 500)
    report(p, first, false, 500) // two consecutive failures -> cooldown
    expect(first.disabledUntil).toBeGreaterThan(Date.now())
    // 'a' cooling -> picks 'b'
    expect(acquire(p)!.key).toBe('b')
  })

  it('falls back to the soonest-recovering key when all are cooling', () => {
    const p = pool(['a', 'b'], 'round-robin')
    const a = acquire(p)!
    const b = acquire(p)!
    report(p, a, false, 500)
    report(p, a, false, 500)
    report(p, b, false, 500)
    report(p, b, false, 500)
    expect(acquire(p)).not.toBeNull()
  })
})

describe('random', () => {
  it('returns a key from the pool', () => {
    const p = pool(['a', 'b', 'c'], 'random')
    expect(['a', 'b', 'c']).toContain(acquire(p)!.key)
  })
})

describe('least-used', () => {
  it('prefers the key with fewest requests', () => {
    const p = pool(['a', 'b'], 'least-used')
    const a = acquire(p)!
    report(p, a, true, 200)
    report(p, a, true, 200)
    const picked = acquire(p)!
    expect(picked.key).toBe('b')
  })
})

describe('health', () => {
  it('prefers the key with the lowest failure weight', () => {
    const p = pool(['a', 'b'], 'health')
    const a = acquire(p)!
    report(p, a, false, 500)
    const picked = acquire(p)!
    expect(picked.key).toBe('b')
  })
})

describe('report', () => {
  it('resets the consecutive-failure streak on success', () => {
    const p = pool(['a'], 'round-robin')
    const entry = acquire(p)!
    report(p, entry, false, 500)
    expect(entry.consecutiveFailures).toBe(1)
    report(p, entry, true, 200)
    expect(entry.consecutiveFailures).toBe(0)
    expect(entry.uses).toBe(2)
    expect(entry.inflight).toBe(0)
  })

  it('cooldowns immediately on auth errors', () => {
    const p = pool(['a'], 'round-robin')
    const entry = acquire(p)!
    report(p, entry, false, 401)
    expect(entry.disabledUntil).toBeGreaterThan(Date.now())
  })

  it('tracks failures and uses', () => {
    const p = pool(['a'], 'round-robin')
    const entry = acquire(p)!
    report(p, entry, false, 429)
    expect(entry.failures).toBe(1)
    expect(entry.uses).toBe(1)
  })
})

describe('empty pool', () => {
  it('acquires nothing', () => {
    const p = pool([], 'round-robin')
    expect(acquire(p)).toBeNull()
  })
})

describe('cooldown timer', () => {
  it('honors the cooldown window', () => {
    vi.useFakeTimers()
    try {
      const p = pool(['a'], 'round-robin')
      const entry = acquire(p)!
      report(p, entry, false, 500)
      report(p, entry, false, 500)
      vi.advanceTimersByTime(1001)
      expect(acquire(p)!.key).toBe('a')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('poolStatus', () => {
  it('summarizes the pool health', () => {
    const p = pool(['a', 'b'], 'round-robin')
    const first = acquire(p)!
    report(p, first, true, 200)
    report(p, first, false, 429)
    report(p, first, false, 429)
    const status = poolStatus(p, Date.now() + 1)
    expect(status).toMatchObject({
      model: 'mock-model',
      strategy: 'round-robin',
      total: 2,
      healthy: 1,
      cooling: 1,
      uses: 3,
      failures: 2,
    })
  })
})
