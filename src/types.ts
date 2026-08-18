/**
 * Wire-level vocabulary for the keybal adapter: the OpenAI-compatible
 * chat-completions request and response shapes this package talks to.
 * Harness types stay at the seam; these are transport-only.
 * @module dsh-llm-keybal/types
 */

/** One wire message in the chat-completions format. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant tool invocations (replayed from history). */
  tool_calls?: WireToolCall[]
  /** assistant reasoning passthrough (DeepSeek-thinking gateways). */
  reasoning_content?: string
  /** tool message correlation. */
  tool_call_id?: string
}

/** One assistant tool invocation on the wire. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One tool schema declared on the wire. */
export interface WireTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

/** The chat-completions request body. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: boolean
  stream_options?: { include_usage: boolean }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** One usage report on the wire. */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One SSE chat-completions chunk payload (non-final frames). */
export interface WireDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

/** One choice inside a stream chunk or a non-stream response. */
export interface WireChoice {
  delta?: WireDelta
  message?: WireMessage & { reasoning_content?: string; tool_calls?: WireToolCall[] }
  finish_reason?: string | null
}

/** One chat-completions response payload (stream chunk or full response). */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
}

/** A provider error body. */
export interface WireErrorBody {
  error?: { message?: string; code?: string; type?: string }
}
