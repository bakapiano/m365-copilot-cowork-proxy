import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { sseEvents, readCompletion } from './upstream.mjs';
import { createProxy } from './server.mjs';
import { defaultModel } from './protocol.mjs';

const compressed = value => ({ compressed: true, data: gzipSync(JSON.stringify(value)).toString('base64') });
const frame = (event, value, id = 'seq:70') => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const collect = async response => { const events = []; for await (const event of sseEvents(response)) events.push(event); return events; };

test('decodes gzip/Base64 final events split across arbitrary UTF-8 chunks', async () => {
  const final = { stop: 'end_turn', mid: 'fixture', content: '你好，已完成。😀', ri: true };
  const bytes = new TextEncoder().encode(frame('dx', { t: '你好' }) + frame('fr', compressed(final)) + frame('rl', { st: 'ok' }));
  const response = new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
    controller.close();
  } }));
  const events = await collect(response);
  assert.deepEqual(events.map(event => event.event), ['dx', 'fr', 'rl']);
  assert.equal(events[0].compressed, false);
  assert.equal(events[1].compressed, true);
  assert.equal(events[1].id, 'seq:70');
  assert.deepEqual(events[1].data, final);
});

test('compressed completion returns at rl ok and cancels an otherwise open SSE stream', { timeout: 1000 }, async () => {
  let canceled = false;
  const events = [];
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame('rl', { st: 'started' }) + frame('dx', compressed({ t: '预览' }))
      + frame('fr', compressed({ content: '{"text":"complete","tool_calls":[]}', stop: 'end_turn' })) + frame('rl', compressed({ st: 'ok' }))));
    // Deliberately keep the subscription open, matching the Cowork transport.
  }, cancel() { canceled = true; } }));
  const result = await readCompletion(response, { onEvent: (event, metadata) => events.push([event, metadata.compressed]) });
  assert.equal(result.text, '{"text":"complete","tool_calls":[]}');
  assert.equal(result.stop, 'end_turn');
  assert.equal(result.streamedCharacters, 2);
  assert.equal(canceled, true);
  assert.deepEqual(events, [['rl', false], ['dx', true], ['fr', true], ['rl', true]]);
});

test('plain final responses retain existing behavior and an empty answer is valid', async () => {
  const result = await readCompletion(new Response(frame('fr', { content: '', stop: 'end_turn' }) + frame('rl', { st: 'ok' })));
  assert.equal(result.text, '');
});

test('success without a final response fails immediately instead of waiting for a timeout', { timeout: 1000 }, async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame('rl', { st: 'ok' })));
  }, cancel() { canceled = true; } }));
  await assert.rejects(readCompletion(response), /completed without an authoritative final response/);
  assert.equal(canceled, true);
  await assert.rejects(readCompletion(new Response(frame('fr', { content: { unexpected: true } }))), /invalid content payload/);
});

test('malformed Base64, gzip, JSON and UTF-8 fail with payload-free errors', async () => {
  const invalid = [
    { compressed: true }, { compressed: true, data: 'invalid!secret' },
    { compressed: true, data: Buffer.from('not gzip secret').toString('base64') },
    { compressed: true, data: gzipSync('invalid json secret').toString('base64') },
    { compressed: true, data: gzipSync(Buffer.from([0xc3, 0x28])).toString('base64') },
  ];
  for (const value of invalid) await assert.rejects(collect(new Response(frame('fr', value))), error => {
    assert.match(error.message, /Cowork compressed event contained invalid/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('gzip expansion is bounded to four MiB', async () => {
  const value = compressed({ content: 'x'.repeat(4 * 1024 * 1024) });
  await assert.rejects(collect(new Response(frame('fr', value))), /decoded event exceeded the 4 MiB size limit/);
});

test('both complete and partial raw SSE frames are bounded by UTF-8 bytes', async () => {
  const huge = '你'.repeat(350000);
  await assert.rejects(collect(new Response(frame('dx', { t: huge }))), /frame exceeded the 1 MiB size limit/);
  await assert.rejects(collect(new Response(`data: ${huge}`)), /frame exceeded the 1 MiB size limit/);
});

test('the Anthropic gateway emits message_stop after a compressed upstream completion', async () => {
  const key = 'a'.repeat(32);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const proxy = createProxy({ key, credentials: { authorization: `Bearer ${token}` }, generator: async () => readCompletion(
    new Response(frame('fr', compressed({ content: '{"text":"COMPRESSED_OK","tool_calls":[]}', stop: 'end_turn' })) + frame('rl', { st: 'ok' })),
  ) });
  const base = await proxy.listen();
  try {
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: defaultModel, messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: true }),
    });
    const result = await response.text();
    assert.equal(response.status, 200);
    assert.match(result, /COMPRESSED_OK/);
    assert.match(result, /event: message_stop/);
    assert.equal(proxy.stats.errors, 0);
  } finally { await proxy.close(); }
});
