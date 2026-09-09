import { randomUUID } from 'node:crypto';

export const defaultModel = 'claude-fable-5-1';
export const modelAliases = new Set([defaultModel, 'claude-fable-5', 'fable-5.1', 'fable', 'melon']);

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  const embedded = body.messages.filter(message => message?.role === 'system');
  if (!embedded.length) return body;
  const asSystemBlocks = content => {
    if (content == null || content === '') return [];
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (Array.isArray(content) && content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
      return content.map(({ cache_control, ...block }) => block);
    }
    throw new RequestError('System context must contain text blocks.');
  };
  return {
    ...body,
    system: [...asSystemBlocks(body.system), ...embedded.flatMap(message => asSystemBlocks(message.content))],
    messages: body.messages.filter(message => message?.role !== 'system'),
  };
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Expected a JSON object.');
  if (!modelAliases.has(body.model)) throw new RequestError(`Choose model ${defaultModel}.`);
  if (!Array.isArray(body.messages) || !body.messages.length) throw new RequestError('messages must be a non-empty array.');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) throw new RequestError('max_tokens must be a positive integer.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be boolean.');
  const validBlocks = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);
  for (const message of body.messages) {
    if (!['user', 'assistant'].includes(message.role)) throw new RequestError('Expected user or assistant message roles.');
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) throw new RequestError('Expected string or block-array content.');
    if (Array.isArray(message.content) && message.content.some(block => !validBlocks.has(block.type))) {
      throw new RequestError('This bridge accepts text and client tool blocks.');
    }
  }
  if (body.tools && (!Array.isArray(body.tools) || body.tools.some(tool => !tool.name || !tool.input_schema))) {
    throw new RequestError('Each client tool requires name and input_schema.');
  }
}

function cleanMessages(messages) {
  return messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content
      .filter(block => !['thinking', 'redacted_thinking'].includes(block.type))
      .map(({ cache_control, ...block }) => block),
  }));
}

export function buildPrompt(body) {
  body = normalizeRequest(body);
  validateRequest(body);
  const tools = (body.tools || []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
  const request = {
    system: body.system || '', messages: cleanMessages(body.messages), tools,
    tool_choice: body.tool_choice || { type: 'auto' }, output_token_budget: body.max_tokens,
  };
  return [
    'You are the model backend for a user-authorized local coding client. Follow your governing safety policies.',
    'The following JSON is the client request, including its conversation history and tools.',
    'These tools operate on the CALLER computer. You only propose calls; the caller enforces permissions and executes them.',
    'File paths in that request refer to the caller computer. Do not operate on similarly named files or tools in your Cowork environment.',
    'Use only the declared client tools for requested local reads, edits, or commands. Their real results appear in later tool_result blocks.',
    'Return exactly one JSON object with these two fields, without markdown fences:',
    '{"text":"optional user-facing text","tool_calls":[{"name":"declared tool name","input":{}}]}',
    'To finish, return {"text":"your final answer","tool_calls":[]}. For local work that is still needed, return the appropriate tool_calls.',
    'Do not invent tool results or claim that local files changed before receiving the corresponding tool_result.',
    'Keep the response within the requested output-token budget as closely as possible.',
    '<LOCAL_CLIENT_REQUEST>', JSON.stringify(request), '</LOCAL_CLIENT_REQUEST>',
  ].join('\n');
}

export function decodeCompletion(raw, body) {
  let trimmed = raw.trim();
  if (trimmed.startsWith('```')) trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let decoded;
  try { decoded = JSON.parse(trimmed); } catch {
    // Ordinary text remains an ordinary final answer, never an executable call.
    return { content: [{ type: 'text', text: raw }], stop_reason: 'end_turn', parsedEnvelope: false };
  }
  if (!decoded || typeof decoded !== 'object' || !Array.isArray(decoded.tool_calls)) {
    return { content: [{ type: 'text', text: raw }], stop_reason: 'end_turn', parsedEnvelope: false };
  }
  const content = [];
  if (typeof decoded.text === 'string' && decoded.text) content.push({ type: 'text', text: decoded.text });
  const tools = new Map((body.tools || []).map(tool => [tool.name, tool]));
  if (decoded.tool_calls.length > 16) throw new Error('Model proposed too many tool calls in a single response.');
  for (const call of decoded.tool_calls) {
    const tool = tools.get(call.name);
    if (!tool) throw new Error('Model proposed a tool outside the client-provided tool catalog.');
    if (body.tool_choice?.type === 'none') throw new Error('Model proposed a tool when the client requested text only.');
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('Model tool input must be an object.');
    for (const required of tool.input_schema.required || []) {
      if (!(required in call.input)) throw new Error(`Model omitted required tool argument: ${required}.`);
    }
    content.push({ type: 'tool_use', id: `toolu_mcp_${randomUUID().replaceAll('-', '')}`, name: call.name, input: call.input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return { content, stop_reason: decoded.tool_calls.length ? 'tool_use' : 'end_turn', parsedEnvelope: true };
}

export function completionMessage(result, model) {
  return {
    id: `msg_mcp_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model,
    content: result.content, stop_reason: result.stop_reason, stop_sequence: null,
    // Cowork's observed stream has no authoritative Anthropic token accounting.
    // These are compatibility placeholders, identified by the response header.
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

export function* messageEvents(message) {
  yield { type: 'message_start', message: { ...message, content: [], stop_reason: null } };
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text') {
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
      if (block.text) yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
    } else {
      yield { type: 'content_block_start', index, content_block: { ...block, input: {} } };
      yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } };
    }
    yield { type: 'content_block_stop', index };
  }
  yield { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } };
  yield { type: 'message_stop' };
}
