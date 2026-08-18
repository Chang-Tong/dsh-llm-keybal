/**
 * SSE parser unit tests: payload framing, the `[DONE]` terminator, and the
 * EOF-without-`[DONE]` failure.
 */

import { describe, expect, it } from 'vitest'
import { DONE, parseSse } from '../src/sse.ts'

const encoder = new TextEncoder()

async function parse(payloads: string[]): Promise<string[]> {
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      controller.close()
    },
  })
  const out: string[] = []
  for await (const data of parseSse(stream)) out.push(data)
  return out
}

describe('parseSse', () => {
  it('yields each payload and returns at [DONE]', async () => {
    expect(await parse(['{"a":1}', DONE])).toEqual(['{"a":1}', DONE])
  })

  it('throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
    await expect(parse(['{"a":1}'])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
