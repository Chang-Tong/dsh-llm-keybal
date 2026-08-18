/**
 * Adapter end-to-end tests: routes a real `KeyBalAdapter` through a local
 * mock chat-completions server, verifying load balancing across keys, failure
 * failover, and stream translation.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { KeyBalAdapter, buildRoutes } from '../src/adapter.ts'
import { resolveConfig, type Config } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

function config(baseURL: string, keys: string[]): Config {
  return {
    strategy: 'round-robin',
    maxRetries: 2,
    cooldownMs: 30000,
    providers: {
      mock_pool: {
        baseURL,
        models: {
          'mock-model': { keys },
        },
      },
    },
  }
}

function routes(baseURL: string, keys: string[]) {
  return buildRoutes(resolveConfig(config(baseURL, keys)))
}

/** Memoize a fresh route map so pool cursors survive across stream calls. */
function once(map: ReturnType<typeof routes>) {
  return () => map
}

function options(model = 'mock-model') {
  return {
    provider: 'mock_pool',
    model,
    messages: [{ id: MessageId('m1'), role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const } }],
  }
}

async function collectChunks(adapter: KeyBalAdapter, opts = options()): Promise<string[]> {
  const parts: string[] = []
  for await (const chunk of adapter.stream(opts)) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  return parts
}

afterEach(async () => {
  await closeMockServers()
})

describe('KeyBalAdapter', () => {
  it('load-balances round-robin across keys', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b', 'key-c'])))
    await collectChunks(adapter)
    await collectChunks(adapter)
    await collectChunks(adapter)
    const auths = server.headers.map((headers) => headers.authorization)
    expect(auths).toEqual(['Bearer key-a', 'Bearer key-b', 'Bearer key-c'])
  })

  it('fails over to the next key on a rate-limit error', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    const parts = await collectChunks(adapter)
    expect(parts.join('')).toBe('hello')
    const auths = server.headers.map((headers) => headers.authorization)
    expect(auths).toEqual(['Bearer key-a', 'Bearer key-b'])
  })

  it('emits an error finish when every key fails', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'nope' } }) },
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'nope' } }) },
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'nope' } }) },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    const finishes: unknown[] = []
    for await (const chunk of adapter.stream(options())) {
      if (chunk.type === 'finish') finishes.push(chunk.reason)
    }
    expect(finishes).toContainEqual(expect.objectContaining({ kind: 'error' }))
    // retries: key-a, key-b, then key-a again (maxRetries=2 -> 3 attempts)
    expect(server.headers).toHaveLength(3)
  })

  it('rejects an unknown provider with an error finish', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const finishes: unknown[] = []
    for await (const chunk of adapter.stream({ ...options(), provider: 'nope' })) {
      if (chunk.type === 'finish') finishes.push(chunk.reason)
    }
    expect(finishes).toContainEqual(expect.objectContaining({ kind: 'error' }))
  })

  it('lists configured models', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const models = await adapter.listModels('mock_pool')
    expect(models.map(model => model.id)).toEqual(['mock-model'])
    expect(await adapter.listModels('missing')).toEqual([])
  })

  it('reports the provider display name falling back to the route key', () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    expect(adapter.providerInfo('mock_pool')).toEqual({ id: 'mock_pool', name: 'mock_pool' })
    const named = buildRoutes(resolveConfig({
      ...config('http://127.0.0.1:1', ['k']),
      providers: {
        mock_pool: {
          displayName: 'Mock 池',
          baseURL: 'http://127.0.0.1:1',
          models: { 'mock-model': { keys: ['k'] } },
        },
      },
    }))
    expect(new KeyBalAdapter(() => named).providerInfo('mock_pool')).toEqual({ id: 'mock_pool', name: 'Mock 池' })
  })

  it('resolves model metadata with a default context window', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const resolved = await adapter.resolveModel('mock_pool', 'mock-model')
    expect(resolved).toMatchObject({ provider: 'mock_pool', id: 'mock-model', context: { contextWindow: 131072 } })
  })
})
