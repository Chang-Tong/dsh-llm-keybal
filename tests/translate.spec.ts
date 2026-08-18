/**
 * SSE translation unit tests: wire chunks -> harness StreamChunks, including
 * tool calls, reasoning, usage, and finish reasons.
 */

import { describe, expect, it } from 'vitest'
import { DONE } from '../src/sse.ts'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'

async function collect(payloads: string[]): Promise<unknown[]> {
  const out: unknown[] = []
  async function* source(): AsyncGenerator<string> {
    for (const payload of payloads) yield payload
  }
  for await (const chunk of translate(source())) out.push(chunk)
  return out
}

describe('translate', () => {
  it('emits text blocks from deltas', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      DONE,
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hel' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'lo' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('translates tool calls into tool-call blocks', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'get_weather', arguments: '{"city":"bj"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ])
    const blockEnd = chunks.find(chunk => (chunk as { type: string }).type === 'block-end')
    expect(blockEnd).toMatchObject({
      type: 'block-end',
      block: { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"bj"}' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('handles reasoning deltas', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
  })

  it('maps empty responses to an error finish', async () => {
    const chunks = await collect([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ])
    const finish = chunks.find(chunk => (chunk as { type: string }).type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('defaults missing wire fields and keeps open blocks across deltas', async () => {
    const chunks = await collect([
      JSON.stringify({}),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'a' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'b' } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{}] } }] }),
      DONE,
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'a' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'b' })
    const blockEnd = chunks.find((chunk) => {
      const block = (chunk as { block?: { type?: string } }).block
      return block?.type === 'tool-call'
    })
    expect(blockEnd).toMatchObject({
      type: 'block-end',
      block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
    })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('throws on malformed JSON payloads', async () => {
    await expect(collect(['not-json', DONE])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throws STREAM_CLOSED when the payload stream ends without DONE', async () => {
    await expect(collect(['{"choices":[]}'])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('mapFinishReason', () => {
  it('maps stop / tool_calls / length', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })

  it('falls back to an error for unknown reasons', () => {
    expect(mapFinishReason('content_filter')).toMatchObject({ kind: 'error' })
  })
})

describe('mapUsage', () => {
  it('subtracts cache reads from input tokens', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } }))
      .toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 })
  })

  it('keeps plain counts disjoint when no cache is reported', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 20 }))
      .toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('reports reasoning tokens when the wire provides them', () => {
    expect(mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 8 },
    })).toEqual({ inputTokens: 100, outputTokens: 20, reasoningTokens: 8 })
  })
})
