/**
 * KeyBalancer unit tests: per-model pool lookup, unknown-model behavior, and
 * the pool-status projection used by diagnostics.
 */

import { describe, expect, it } from 'vitest'
import { KeyBalancer } from '../src/balancer.ts'
import type { ResolvedKeyBalConfig } from '../src/config.ts'

const defaults: ResolvedKeyBalConfig = {
  strategy: 'round-robin',
  maxRetries: 2,
  cooldownMs: 30000,
  providers: {},
}

const balancer = (): KeyBalancer => new KeyBalancer({
  baseURL: 'https://api.deepseek.com',
  models: {
    'model-a': { keys: ['k1', 'k2'] },
  },
}, defaults)

describe('KeyBalancer', () => {
  it('acquires from a configured model', () => {
    const picked = balancer().acquire('model-a')
    expect(picked?.entry.key).toBe('k1')
    expect(picked?.entryIndex).toBe(0)
  })

  it('acquires nothing for an unknown model', () => {
    expect(balancer().acquire('nope')).toBeNull()
  })

  it('acquires nothing for a model with an empty pool', () => {
    const empty = new KeyBalancer({ baseURL: 'https://api.deepseek.com', models: { 'model-a': { keys: [] } } }, defaults)
    expect(empty.acquire('model-a')).toBeNull()
  })

  it('ignores reports for unknown models or indexes', () => {
    const b = balancer()
    expect(() => { b.report('nope', 0, false, 500) }).not.toThrow()
    expect(() => { b.report('model-a', 99, false, 500) }).not.toThrow()
  })

  it('exposes a status view for a configured model', () => {
    const view = balancer().model('model-a')
    expect(view).toMatchObject({ model: 'model-a', contextWindow: 131072, maxTokens: 8192 })
    expect(view?.status()).toMatchObject({ total: 2, healthy: 2, cooling: 0 })
  })

  it('exposes no view for an unknown model', () => {
    expect(balancer().model('nope')).toBeUndefined()
  })

  it('lists configured models in order', () => {
    const b = new KeyBalancer({
      baseURL: 'https://api.deepseek.com',
      models: { 'model-b': { keys: ['k'] }, 'model-a': { keys: ['k'] } },
    }, defaults)
    expect(b.models().map(view => view.model)).toEqual(['model-b', 'model-a'])
  })

  it('applies plugin-wide retry defaults', () => {
    expect(balancer().maxRetries('model-a')).toBe(2)
    expect(balancer().maxRetries('nope')).toBe(2)
  })
})
