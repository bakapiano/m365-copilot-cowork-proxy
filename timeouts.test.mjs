import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestTimeouts, defaultUpstreamTimeoutMs } from './timeouts.mjs';
import { localRouting } from './routing.mjs';
import { createProxy } from './server.mjs';
import { defaultModel } from './protocol.mjs';

test('defaults to fifteen minutes upstream and sixteen minutes for Claude', () => {
  assert.equal(defaultUpstreamTimeoutMs, 900000);
  assert.deepEqual(requestTimeouts(''), { upstreamTimeoutMs: 900000, clientTimeoutMs: 960000 });
  assert.deepEqual(requestTimeouts('  '), requestTimeouts(''));
});

test('custom request deadlines retain a one-minute client grace period', () => {
  assert.deepEqual(requestTimeouts('1800000'), { upstreamTimeoutMs: 1800000, clientTimeoutMs: 1860000 });
  for (const bare of [false, true]) {
    const env = localRouting('http://127.0.0.1:1234', 'fixture', defaultModel, { bare, upstreamTimeoutMs: 1800000 });
    assert.equal(env.API_TIMEOUT_MS, '1860000');
  }
});

test('invalid or overflowing deadlines fail before starting a request', () => {
  for (const value of ['bad', '0', '-1', '1.5', 'Infinity', '2147483647', '9000000000']) {
    assert.throws(() => requestTimeouts(value), /MCP_UPSTREAM_TIMEOUT_MS/);
  }
});

function requestFixture() {
  const key = 'a'.repeat(32);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const req = { method: 'POST', url: '/v1/messages', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model: defaultModel, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] })); },
  };
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, writableEnded: false, body: '',
    setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body += body || ''; this.writableEnded = true; },
  });
  return { key, credentials: { authorization: `Bearer ${token}` }, req, res };
}

test('a 273-second generation survives the former three-minute deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = requestFixture();
  const proxy = createProxy({ ...fixture, upstreamTimeoutMs: defaultUpstreamTimeoutMs,
    generator: async (_credentials, _prompt, { signal }) => {
      t.mock.timers.tick(273338);
      assert.equal(signal.aborted, false);
      return { text: 'LONG_REQUEST_OK', stop: 'end_turn' };
    },
  });
  await proxy.server.listeners('request')[0](fixture.req, fixture.res);
  assert.equal(fixture.res.statusCode, 200);
  assert.equal(JSON.parse(fixture.res.body).content[0].text, 'LONG_REQUEST_OK');
  assert.equal(proxy.stats.errors, 0);
});

test('the enlarged total deadline still aborts at fifteen minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = requestFixture();
  const proxy = createProxy({ ...fixture, upstreamTimeoutMs: defaultUpstreamTimeoutMs,
    generator: async (_credentials, _prompt, { signal }) => {
      t.mock.timers.tick(899999);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(signal.aborted, true);
      throw new DOMException('Aborted', 'AbortError');
    },
  });
  await proxy.server.listeners('request')[0](fixture.req, fixture.res);
  assert.equal(fixture.res.statusCode, 502);
  assert.match(JSON.parse(fixture.res.body).error.message, /timed out/);
});

test('authenticated health reports the configured timeout', async () => {
  const fixture = requestFixture();
  const proxy = createProxy({ ...fixture, upstreamTimeoutMs: 1800000 });
  const base = await proxy.listen();
  try {
    const health = await (await fetch(`${base}/health`, { headers: { 'x-api-key': fixture.key } })).json();
    assert.equal(health.upstreamTimeoutMs, 1800000);
  } finally { await proxy.close(); }
});
