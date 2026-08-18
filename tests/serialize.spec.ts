/**
 * Serializer unit tests: harness messages -> wire chat-completions format.
 */

import { describe, expect, it } from 'vitest'
import { CallId, MessageId, ReasoningEffortId, type Message } from '@deepseek-ai/dsh-llm'
import { assertSupportedEffort, serializeMessages, serializeRequest } from '../src/serialize.ts'

let seq = 0
function mid(): MessageId {
  return MessageId(`m-${++seq}`)
}

function msg(role: 'system' | 'user' | 'assistant', blocks: unknown[], source: unknown = { kind: 'user' }): Message {
  return { id: mid(), role, content: blocks as never, source: source as never }
}

describe('serializeMessages', () => {
  it('joins user text blocks', () => {
    const wire = serializeMessages([
      msg('user', [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }]),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('flattens system messages', () => {
    const wire = serializeMessages([
      msg('system', [{ type: 'text', text: 'be brief' }]),
    ])
    expect(wire).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('serializes assistant tool calls and drops plain reasoning', () => {
    const wire = serializeMessages([
      msg('assistant', [
        { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"bj"}' },
        { type: 'reasoning', text: 'thinking...' },
      ], { kind: 'model', provider: 'p', model: 'm' }),
    ])
    expect(wire[0]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: 'thinking...',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"bj"}' } }],
    })
  })

  it('emits tool results as separate tool messages', () => {
    const wire = serializeMessages([
      msg('user', [
        { type: 'text', text: 'check' },
        { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'sunny' }], isError: false },
      ], { kind: 'tool', callId: CallId('call-1') }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'check' },
      { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
    ])
  })

  it('omits the user message when a tool-result turn has no text', () => {
    const wire = serializeMessages([
      msg('user', [
        { type: 'tool-result', toolCallId: CallId('call-2'), content: [{ type: 'text', text: 'done' }], isError: false },
      ], { kind: 'tool', callId: CallId('call-2') }),
    ])
    expect(wire).toEqual([
      { role: 'tool', tool_call_id: 'call-2', content: 'done' },
    ])
  })

  it('substitutes a placeholder for an empty tool-result body', () => {
    const wire = serializeMessages([
      msg('user', [
        { type: 'tool-result', toolCallId: CallId('call-3'), content: [], isError: false },
      ], { kind: 'tool', callId: CallId('call-3') }),
    ])
    expect(wire).toEqual([
      { role: 'tool', tool_call_id: 'call-3', content: '(no output)' },
    ])
  })

  it('drops reasoning from a reasoning-only assistant turn', () => {
    const wire = serializeMessages([
      msg('assistant', [{ type: 'reasoning', text: 'thinking...' }], { kind: 'model', provider: 'p', model: 'm' }),
    ])
    expect(wire[0]).toEqual({
      role: 'assistant',
      content: '',
    })
  })
})

describe('serializeRequest', () => {
  it('builds a streaming request with tools and sampling', () => {
    const request = serializeRequest({
      provider: 'p',
      model: 'm',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      system: 'sys',
      temperature: 0.5,
      maxTokens: 100,
      stop: ['\n'],
      tools: [{ name: 't', description: 'tool', parameters: { type: 'object' } }],
    })
    expect(request).toMatchObject({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.5,
      max_tokens: 100,
      stop: ['\n'],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'tool', parameters: { type: 'object' } } }],
    })
  })

  it('omits optional fields when absent', () => {
    const request = serializeRequest({
      provider: 'p',
      model: 'm',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(request.temperature).toBeUndefined()
    expect(request.max_tokens).toBeUndefined()
    expect(request.tools).toBeUndefined()
    expect(request.thinking).toBeUndefined()
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('disables thinking for an explicit off effort', () => {
    const request = serializeRequest({
      provider: 'p',
      model: 'm',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(request.thinking).toEqual({ type: 'disabled' })
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('enables thinking with a wire effort for high and max', () => {
    const high = serializeRequest({
      provider: 'p',
      model: 'm',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(high.thinking).toEqual({ type: 'enabled' })
    expect(high.reasoning_effort).toBe('high')
    const max = serializeRequest({
      provider: 'p',
      model: 'm',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(max.thinking).toEqual({ type: 'enabled' })
    expect(max.reasoning_effort).toBe('max')
  })
})

describe('assertSupportedEffort', () => {
  it('accepts the supported efforts and undefined', () => {
    expect(() => { assertSupportedEffort(undefined) }).not.toThrow()
    expect(() => { assertSupportedEffort('off') }).not.toThrow()
    expect(() => { assertSupportedEffort('high') }).not.toThrow()
    expect(() => { assertSupportedEffort('max') }).not.toThrow()
  })

  it('rejects an unsupported effort', () => {
    expect(() => { assertSupportedEffort('ultra') }).toThrow(/reasoning effort/)
  })
})
