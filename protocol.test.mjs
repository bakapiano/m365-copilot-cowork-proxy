import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, decodeCompletion, completionMessage, messageEvents, defaultModel, normalizeRequest } from './protocol.mjs';
import { sseEvents } from './upstream.mjs';
import { createProxy } from './server.mjs';
import { localRouting } from './routing.mjs';

const request = { model: defaultModel, max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] };
test('ordinary and bare launches select one explicit gateway credential path', () => {
  const ordinary = localRouting('http://127.0.0.1:1234', 'local-test-key', defaultModel);
  assert.equal(ordinary.ANTHROPIC_AUTH_TOKEN, 'local-test-key');
  assert.equal(ordinary.ANTHROPIC_API_KEY, '');
  const bare = localRouting('http://127.0.0.1:1234', 'local-test-key', defaultModel, { bare: true });
  assert.equal(bare.ANTHROPIC_API_KEY, 'local-test-key');
  assert.equal(bare.ANTHROPIC_AUTH_TOKEN, '');
});
test('keeps system and history in a structured client request', () => {
  assert.match(buildPrompt({ ...request, system: 'system context' }), /system context/);
  assert.match(buildPrompt(request), /LOCAL_CLIENT_REQUEST/);
});
test('normalizes ordinary Claude system-role context without losing content or mutating input', () => {
  const body = { ...request, system: 'original context', messages: [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'system', content: [{ type: 'text', text: 'additional client context', cache_control: { type: 'ephemeral' } }] },
  ] };
  const normalized = normalizeRequest(body);
  assert.deepEqual(normalized.messages.map(message => message.role), ['user']);
  assert.deepEqual(normalized.system.map(block => block.text), ['original context', 'additional client context']);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'system']);
  assert.match(buildPrompt(body), /additional client context/);
  assert.match(buildPrompt(body), /你好/);
});
test('rejects non-text embedded system context', () => {
  assert.throws(() => buildPrompt({ ...request, messages: [...request.messages, { role: 'system', content: [{ type: 'tool_use' }] }] }), /System context/);
});
test('converts a validated local tool proposal to Anthropic tool_use', () => {
  const body = { ...request, tools: [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }] };
  const result = decodeCompletion('{"text":"","tool_calls":[{"name":"Read","input":{"file_path":"input.txt"}}]}', body);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
  assert.match(result.content[0].id, /^toolu_mcp_/);
});
test('rejects tools outside the caller catalog', () => {
  assert.throws(() => decodeCompletion('{"tool_calls":[{"name":"Bash","input":{}}]}', request), /catalog/);
});
test('preserves JSON/text answers without executable envelopes', () => {
  assert.equal(decodeCompletion('{"ok":true}', request).content[0].text, '{"ok":true}');
});
test('emits Anthropic text and tool event sequences', () => {
  const message = completionMessage({ content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'toolu_test', name: 'Read', input: { file_path: 'x' } }], stop_reason: 'tool_use' }, defaultModel);
  const events = [...messageEvents(message)];
  assert.equal(events[0].type, 'message_start');
  assert.equal(events.at(-1).type, 'message_stop');
  assert.equal(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json, '{"file_path":"x"}');
});
test('SSE parser handles chunked UTF-8 and CRLF boundaries', async () => {
  const bytes = new TextEncoder().encode('event: dx\r\ndata: {"t":"你好"}\r\n\r\nevent: fr\ndata: {"content":"你好"}\n\n');
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  const events = [];
  for await (const event of sseEvents(response)) events.push(event);
  assert.deepEqual(events.map(event => event.event), ['dx', 'fr']);
  assert.equal(events[0].data.t, '你好');
});
test('local gateway authenticates and returns real protocol envelopes', async () => {
  const key = 'a'.repeat(32);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const proxy = createProxy({ key, credentials: { authorization: `Bearer ${token}` }, generator: async () => ({ text: '{"text":"hello","tool_calls":[]}', stop: 'end_turn' }) });
  const base = await proxy.listen();
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/api/hello`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status, 401);
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, 'hello');
    const bearer = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(bearer.status, 200);
    const mixed = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-api-key': 'old-sdk-key', 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(mixed.status, 200);
    const invalid = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'x-api-key': 'wrong', 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(invalid.status, 401);
    const ordinary = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({
      ...request, messages: [...request.messages, { role: 'system', content: [{ type: 'text', text: 'ordinary-mode context' }] }],
    }) });
    assert.equal(ordinary.status, 200);
    const stream = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) });
    assert.match(await stream.text(), /event: message_stop/);
  } finally { await proxy.close(); }
});
