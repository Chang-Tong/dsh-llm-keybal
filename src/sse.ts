/**
 * Decode an SSE byte stream into event `data` payloads, exactly like the
 * official DeepSeek adapter's parser: `eventsource-parser` handles framing,
 * the literal `[DONE]` is yielded so the caller owns final flushing, and EOF
 * before it raises {@link LlmError}.
 *
 * @module dsh-llm-keybal/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
