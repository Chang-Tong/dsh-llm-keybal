/**
 * Serialize harness messages into the OpenAI-compatible chat-completions
 * wire format. User text is joined; assistant text becomes `content`, tool
 * calls become `tool_calls`, reasoning is replayed as `reasoning_content`
 * only on tool-call turns (the DeepSeek thinking-mode passback rule), and
 * tool results become separate `role: 'tool'` messages.
 *
 * @module dsh-llm-keybal/serialize
 */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { WireMessage, WireRequest } from './types.ts';
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; a mixed user message contributes its text first
 * and its tool results as separate wire messages after.
 */
export declare function serializeMessages(messages: readonly Message[]): WireMessage[];
/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null.
 */
export declare function serializeRequest(options: GenerateOptions): WireRequest;
/** Reject an unsupported reasoning effort before it reaches the wire. */
export declare function assertSupportedEffort(effort: string | undefined): void;
//# sourceMappingURL=serialize.d.ts.map