import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { accountRecord, clientId, resourceId, scope, credentialsFromToken, createAuthProvider, runWamHelper } from './auth.mjs';
import { createProxy } from './server.mjs';
import { defaultModel } from './protocol.mjs';

const tenant = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const username = 'fixture@example.test';
const baseClaims = { aud: resourceId, azp: clientId, scp: 'access_as_user', tid: tenant, oid: user, preferred_username: username };
const token = (overrides = {}, now = Date.now()) => `header.${Buffer.from(JSON.stringify({ ...baseClaims, exp: Math.floor(now / 1000) + 3600, ...overrides })).toString('base64url')}.signature`;
const record = { authority: 'login.microsoftonline.com', homeAccountId: `${user}.${tenant}`, clientId, tenantId: tenant, username, version: '1.0' };
const providerOptions = { tenantId: undefined, account: undefined, loadRecord: async () => undefined, persistRecord: async () => {} };

test('the WAM scope and client match the captured Cowork application', () => {
  assert.equal(scope, `${resourceId}/access_as_user`);
  const result = credentialsFromToken(token());
  assert.equal(result.authProvider, 'wam');
  assert.equal(result['x-tenant-id'], tenant);
  assert.equal(result['x-user-id'], user);
  assert.equal(result.accountName, username);
});

test('rejects wrong resource, client, scope, identity and expiration without exposing tokens', () => {
  for (const claims of [{ aud: 'other' }, { azp: 'other' }, { scp: 'other' }, { oid: '' }, { tid: '' }, { exp: 1 }]) {
    const secret = token(claims);
    assert.throws(() => credentialsFromToken(secret), error => !error.message.includes(secret));
  }
  assert.throws(() => credentialsFromToken('not-a-token'), /unreadable/);
  assert.throws(() => credentialsFromToken(token(), { account: 'different@example.test' }), /different account/);
  assert.throws(() => credentialsFromToken(token(), { tenantId: user }), /different tenant/);
});

test('account metadata has an explicit token-free allowlist', () => {
  const saved = accountRecord({ ...record, accessToken: 'sensitive', refreshToken: 'sensitive', authorization: 'sensitive' });
  assert.deepEqual(saved, record);
  assert.throws(() => accountRecord({ ...record, authority: 'other.example.test' }), /metadata/);
  assert.throws(() => accountRecord({ ...record, clientId: user }), /metadata/);
});

test('WAM is the default provider and reuses account metadata without invoking the browser', async () => {
  let options; let saved;
  const provider = createAuthProvider({ ...providerOptions, source: 'wam', loadRecord: async () => record,
    acquire: async value => { options = value; return { token: token(), record }; },
    persistRecord: async value => { saved = value; }, browserAcquire: async () => { throw new Error('Unexpected browser access'); },
  });
  assert.equal((await provider.getCredentials()).accountName, username);
  assert.equal(options.interactive, false);
  assert.equal(options.tenantId, tenant);
  assert.deepEqual(options.record, record);
  assert.deepEqual(saved, record);
});

test('interactive sign-in deliberately opens account selection using a fresh credential', async () => {
  let options;
  const provider = createAuthProvider({ ...providerOptions, source: 'wam',
    loadRecord: async () => { throw new Error('Interactive auth must ignore saved selectors'); },
    acquire: async value => { options = value; return { token: token(), record }; },
  });
  await provider.getCredentials({ interactive: true });
  assert.equal(options.interactive, true);
  assert.equal(options.record, undefined);
});

test('concurrent callers share authentication and an approaching expiry renews once', async () => {
  let now = Date.now(); let acquisitions = 0;
  const provider = createAuthProvider({ ...providerOptions, source: 'wam', now: () => now,
    acquire: async () => { acquisitions++; return { token: token({}, now), record }; },
  });
  const first = await Promise.all([provider.getCredentials(), provider.getCredentials(), provider.getCredentials()]);
  assert.equal(acquisitions, 1);
  assert.equal(first[0], first[1]);
  await provider.getCredentials();
  assert.equal(acquisitions, 1);
  now += 3500 * 1000;
  const refreshed = await Promise.all([provider.getCredentials(), provider.getCredentials()]);
  assert.equal(acquisitions, 2);
  assert.notEqual(refreshed[0].authorization, first[0].authorization);
});

test('refresh pins the existing session user and tenant', async () => {
  let acquisitions = 0;
  const provider = createAuthProvider({ ...providerOptions, source: 'wam', acquire: async () => ({
    token: token(++acquisitions === 1 ? {} : { oid: tenant }), record,
  }) });
  await provider.getCredentials();
  await assert.rejects(provider.getCredentials({ force: true }), /account changed/);
});

test('failed authentication can be retried and browser auth is an explicit provider', async () => {
  let attempts = 0;
  const provider = createAuthProvider({ ...providerOptions, source: 'wam', acquire: async () => {
    if (++attempts === 1) throw new Error('User canceled sign-in');
    return { token: token(), record };
  } });
  await assert.rejects(provider.getCredentials(), /canceled/);
  assert.equal((await provider.getCredentials()).authProvider, 'wam');
  const browser = createAuthProvider({ ...providerOptions, source: 'browser', browserAcquire: async () => credentialsFromToken(token()), acquire: async () => { throw new Error('Unexpected WAM access'); } });
  assert.equal((await browser.getCredentials()).authProvider, 'browser');
  assert.throws(() => createAuthProvider({ source: 'other' }), /MCP_AUTH/);
});

test('the gateway renews an expiring upstream credential through its selected provider', async () => {
  const old = credentialsFromToken(token({ exp: Math.floor(Date.now() / 1000) + 90 }));
  const fresh = credentialsFromToken(token());
  const key = 'a'.repeat(32); let renewed = 0; let used;
  const proxy = createProxy({ key, credentials: old,
    refreshCredentials: async () => { renewed++; return fresh; },
    generator: async credentials => { used = credentials; return { text: 'hello', stop: 'end_turn' }; },
  });
  const base = await proxy.listen();
  try {
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: defaultModel, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(renewed, 1);
    assert.equal(used.authorization, fresh.authorization);
  } finally { await proxy.close(); }
});

function fakeHelper(reply) {
  const child = new EventEmitter();
  child.send = value => { child.request = value; if (reply) queueMicrotask(() => child.emit('message', reply)); };
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
  return child;
}

test('the native helper sends credentials over IPC and is closed before returning', async () => {
  const reply = { type: 'token', token: token(), record };
  const child = fakeHelper(reply); let spawnOptions; let argv;
  const result = await runWamHelper({ interactive: false, tenantId: tenant }, { platform: 'win32',
    spawnChild: (_path, args, options) => { argv = args; spawnOptions = options; return child; },
  });
  assert.equal(result.token, reply.token);
  assert.equal(child.killed, true);
  assert.deepEqual(argv, []);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(spawnOptions.windowsHide, true);
  assert.deepEqual(child.request, { interactive: false, tenantId: tenant });
});

test('timeout and shutdown terminate the owned authentication helper', async () => {
  const timed = fakeHelper();
  await assert.rejects(runWamHelper({}, { platform: 'win32', spawnChild: () => timed, timeoutMs: 5 }), /timed out/);
  assert.equal(timed.killed, true);
  const canceled = fakeHelper(); const controller = new AbortController();
  const pending = runWamHelper({ signal: controller.signal }, { platform: 'win32', spawnChild: () => canceled });
  controller.abort();
  await assert.rejects(pending, /canceled/);
  assert.equal(canceled.killed, true);
  assert.equal('signal' in canceled.request, false);
});
