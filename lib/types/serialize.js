/**
 * Serialize harness messages into the OpenAI-compatible chat-completions
 * wire format. User text is joined; assistant text becomes `content`, tool
 * calls become `tool_calls`, reasoning is replayed as `reasoning_content`
 * only on tool-call turns (the DeepSeek thinking-mode passback rule), and
 * tool results become separate `role: 'tool'` messages.
 *
 * @module dsh-llm-keybal/serialize
 */
/* jscpd:ignore-start -- OpenAI-compatible wire serialization shared with llm-deepseek. */
import { LlmError } from '@deepseek-ai/dsh-llm';
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const reasoning = message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('');
    const toolCalls = message.content
        .filter(block => block.type === 'tool-call')
        .map(block => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
    }));
    return {
        role: 'assistant',
        // Text-less turns send "" — NEVER null: reasoning-only assistant turns
        // are rejected with "content or tool_calls must be set" by DeepSeek.
        content: text,
        ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    };
}
/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; a mixed user message contributes its text first
 * and its tool results as separate wire messages after.
 */
export function serializeMessages(messages) {
    const wire = [];
    for (const message of messages) {
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            wire.push(serializeAssistant(message));
            continue;
        }
        const toolResults = message.content.filter(block => block.type === 'tool-result');
        const text = flattenText(message.content);
        if (text.length > 0 || toolResults.length === 0) {
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            wire.push({
                role: 'tool',
                tool_call_id: result.toolCallId,
                content: flattenText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
/**
 * Build the full wire request. Always streaming with usage reporting on;
 * optional fields are omitted rather than sent as null.
 */
export function serializeRequest(options) {
    const messages = [];
    if (options.system !== undefined) {
        messages.push({ role: 'system', content: options.system });
    }
    messages.push(...serializeMessages(options.messages));
    const tools = options.tools?.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop !== undefined ? { stop: options.stop } : {},
    };
}
/** Reject an unsupported reasoning effort before it reaches the wire. */
export function assertSupportedEffort(effort) {
    if (effort !== undefined && effort !== 'off' && effort !== 'high' && effort !== 'max') {
        throw new LlmError(`keybal does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
    }
}
/* jscpd:ignore-end */
//# sourceMappingURL=serialize.js.map