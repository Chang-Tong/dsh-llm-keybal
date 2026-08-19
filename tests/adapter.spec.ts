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

/** Collect terminal finish reasons, typed so assertions stay lint-clean. */
async function finishReasons(adapter: KeyBalAdapter, opts = options()): Promise<unknown[]> {
  const finishes: unknown[] = []
  for await (const chunk of adapter.stream(opts)) {
    if (chunk.type === 'finish') finishes.push(chunk.reason)
  }
  return finishes
}

/** The sole error finish reason, for a toMatchObject assertion. */
function errorFinish(finishes: unknown[]): Record<string, unknown> {
  const reason = finishes.at(-1)
  if (reason === undefined || typeof reason !== 'object' || reason === null) {
    throw new Error('expected an error finish reason')
  }
  return reason as Record<string, unknown>
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
    const auths = server.headers.map(headers => headers.authorization)
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
    const auths = server.headers.map(headers => headers.authorization)
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
      ...config('http://127.0.0.1:1', ['k']) as unknown as Record<string, unknown>,
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

  it('advertises reasoning with a high default when the model pins no effort', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const resolved = await adapter.resolveModel('mock_pool', 'mock-model')
    expect(resolved.reasoning).toMatchObject({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    })
  })

  it('exposes reasoning metadata when the model pins an effort', async () => {
    const cfg = resolveConfig({
      strategy: 'round-robin',
      maxRetries: 2,
      cooldownMs: 30000,
      providers: {
        mock_pool: {
          baseURL: 'http://127.0.0.1:1',
          models: {
            'mock-model': { keys: ['k'], reasoningEffort: 'high' },
          },
        },
      },
    })
    const adapter = new KeyBalAdapter(once(buildRoutes(cfg)))
    const resolved = await adapter.resolveModel('mock_pool', 'mock-model')
    expect(resolved.reasoning).toMatchObject({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    })
  })

  it('keeps reasoning metadata off the catalog, resolved only per model', async () => {
    const cfg = resolveConfig({
      strategy: 'round-robin',
      maxRetries: 2,
      cooldownMs: 30000,
      providers: {
        mock_pool: {
          baseURL: 'http://127.0.0.1:1',
          models: {
            'mock-model': { keys: ['k'], reasoningEffort: 'off' },
          },
        },
      },
    })
    const adapter = new KeyBalAdapter(once(buildRoutes(cfg)))
    const listed = await adapter.listModels('mock_pool')
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('reasoning')
    const resolved = await adapter.resolveModel('mock_pool', 'mock-model')
    expect(resolved.reasoning).toMatchObject({ defaultEffort: 'off' })
  })

  it('resolves unknown models without context or token caps', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const resolved = await adapter.resolveModel('mock_pool', 'no-such-model')
    expect(resolved).toMatchObject({ provider: 'mock_pool', id: 'no-such-model' })
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('emits a MISSING_CREDENTIAL finish when the model pool has no keys', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', [])))
    const finishes = await finishReasons(adapter)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'MISSING_CREDENTIAL' },
    })
  })

  it('maps an auth error to AUTH and cooldowns the key', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    const parts = await collectChunks(adapter)
    expect(parts.join('')).toBe('hello')
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer key-a', 'Bearer key-b'])
  })

  it('maps a quota error to QUOTA and fails over', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 402, body: JSON.stringify({ error: { message: 'insufficient_quota' } }) },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('maps an unrecognized status to a stable HTTP_ code', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 418, body: JSON.stringify({ error: { message: 'teapot' } }) },
      { kind: 'http-error', status: 418, body: JSON.stringify({ error: { message: 'teapot' } }) },
      { kind: 'http-error', status: 418, body: JSON.stringify({ error: { message: 'teapot' } }) },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a'])))
    const finishes = await finishReasons(adapter)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'HTTP_418', status: 418 },
    })
  })

  it('does not burn retries on a request-shape 400', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    const finishes = await finishReasons(adapter)
    // One attempt only: a shape error is not a key problem.
    expect(server.headers).toHaveLength(1)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'INVALID_REQUEST' },
    })
  })

  it('maps a server error to SERVER', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 500, body: JSON.stringify({ error: { message: 'boom' } }) },
      { kind: 'http-error', status: 500, body: JSON.stringify({ error: { message: 'boom' } }) },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a'])))
    const finishes = await finishReasons(adapter)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'SERVER' },
    })
  })

  it('honors a numeric Retry-After on the failure detail', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'retry-after': '5' } },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('honors an HTTP-date Retry-After on the failure detail', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString()
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'retry-after': date } },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('omits the delay when a numeric Retry-After is not a positive delay', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'retry-after': '0' } },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('omits the delay when an HTTP-date Retry-After is in the past', async () => {
    const date = new Date(Date.now() - 60_000).toUTCString()
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'retry-after': date } },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('falls back to the generic message when the error body carries no message', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 402, body: JSON.stringify({ error: { type: 'insufficient_quota' } }) },
      { kind: 'sse', events: textEvents },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a', 'key-b'])))
    expect((await collectChunks(adapter)).join('')).toBe('hello')
  })

  it('treats a bodyless upstream response as EMPTY_RESPONSE', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 204, body: '' },
      { kind: 'http-error', status: 204, body: '' },
      { kind: 'http-error', status: 204, body: '' },
    ])
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a'])))
    const finishes = await finishReasons(adapter)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'EMPTY_RESPONSE' },
    })
  })

  it('emits an aborted finish when the caller aborts mid-stream', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents, delayMs: 20 },
    ])
    const controller = new AbortController()
    const adapter = new KeyBalAdapter(once(routes(server.url, ['key-a'])))
    const finishes: unknown[] = []
    const stream = adapter.stream({ ...options(), signal: controller.signal })
    const pump = (async () => {
      for await (const chunk of stream) {
        if (chunk.type === 'finish') finishes.push(chunk.reason)
      }
    })()
    setTimeout(() => { controller.abort() }, 5)
    await pump
    expect(finishes).toContainEqual(expect.objectContaining({ kind: 'aborted' }))
  })

  it('maps a transport failure to TRANSPORT', async () => {
    const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
    const finishes = await finishReasons(adapter)
    expect(errorFinish(finishes)).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT' },
    })
  })

  it('stringifies a non-Error transport rejection', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => { throw 'boom' })
    try {
      const adapter = new KeyBalAdapter(once(routes('http://127.0.0.1:1', ['k'])))
      const finishes = await finishReasons(adapter)
      expect(errorFinish(finishes)).toMatchObject({
        kind: 'error',
        failure: { code: 'TRANSPORT', message: 'keybal request failed: boom' },
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
