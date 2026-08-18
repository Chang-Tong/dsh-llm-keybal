/**
 * Decode an SSE byte stream into event `data` payloads, exactly like the
 * official DeepSeek adapter's parser: `eventsource-parser` handles framing,
 * the literal `[DONE]` is yielded so the caller owns final flushing, and EOF
 * before it raises {@link LlmError}.
 *
 * @module dsh-llm-keybal/sse
 */
/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export declare const DONE = "[DONE]";
/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it.
 */
export declare function parseSse(stream: ReadableStream<BufferSource>): AsyncGenerator<string>;
//# sourceMappingURL=sse.d.ts.map