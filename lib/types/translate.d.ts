/**
 * Translate OpenAI-compatible SSE payloads into harness `StreamChunk`s. One
 * stateful block per content, reasoning, or tool-call index; an empty initial
 * reasoning delta does not open a block; finish reason and the latest usage
 * are deferred until `[DONE]`.
 *
 * @module dsh-llm-keybal/translate
 */
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { WireUsage } from './types.ts';
/** Map the wire finish_reason vocabulary to the harness FinishReason. */
export declare function mapFinishReason(reason: string): FinishReason;
/** Map wire usage fields to disjoint harness counts (cache hits subtracted). */
export declare function mapUsage(usage: WireUsage): TokenUsage;
/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 */
export declare function translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=translate.d.ts.map