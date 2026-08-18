/**
 * Serializer unit tests: harness messages -> wire chat-completions format.
 */

import { describe, expect, it } from 'vitest'
import { CallId, MessageId, type Message } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeRequest } from '../src/serialize.ts'

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
  })
})
