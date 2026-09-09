import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { browserCredentials, tokenExpiry } from './upstream.mjs';

// Public application/resource identifiers observed in the authorized Cowork session.
export const clientId = 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1';
export const resourceId = '6ab48b67-cd74-4ad4-81af-5932984589be';
export const scope = `${resourceId}/access_as_user`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const recordPath = () => join(process.env.LOCALAPPDATA || join(homedir(), '.local/share'), 'm365-copilot-cowork-proxy', 'account.json');

export function accountRecord(value) {
  if (!value || value.clientId !== clientId || value.authority !== 'login.microsoftonline.com'
    || !uuid.test(value.tenantId || '') || typeof value.homeAccountId !== 'string'
    || typeof value.username !== 'string' || value.version !== '1.0') throw new Error('Invalid saved WAM account metadata. Run mcp auth --interactive.');
  // Persist only Azure Identity account selectors. Tokens never enter this file.
  return Object.fromEntries(['authority', 'homeAccountId', 'clientId', 'tenantId', 'username', 'version'].map(key => [key, value[key]]));
}

async function readRecord() {
  try { return accountRecord(JSON.parse(await readFile(recordPath(), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Unable to read WAM account metadata. Run mcp auth --interactive.'); }
}

async function saveRecord(value) {
  const path = recordPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(accountRecord(value), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export function credentialsFromToken(token, { now = Date.now(), tenantId, account } = {}) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new Error('WAM returned an unreadable access token.'); }
  // Routing validation only: the upstream service verifies the token signature.
  if (claims.aud !== resourceId || (claims.azp || claims.appid) !== clientId
    || !String(claims.scp || '').split(' ').includes('access_as_user')) throw new Error('WAM returned a token for a different application or resource.');
  if (!uuid.test(claims.tid || '') || !uuid.test(claims.oid || '')) throw new Error('WAM returned a token without the required user identity.');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 30000) throw new Error('WAM returned an expired or nearly expired token.');
  if (tenantId && tenantId !== 'organizations' && claims.tid.toLowerCase() !== tenantId.toLowerCase()) throw new Error('WAM selected a different tenant. Run mcp auth --interactive.');
  const username = claims.preferred_username || claims.upn || '';
  if (account && username.toLowerCase() !== account.toLowerCase()) throw new Error('WAM selected a different account. Run mcp auth --interactive.');
  return {
    authorization: `Bearer ${token}`, 'x-tenant-id': claims.tid, 'x-user-id': claims.oid,
    'x-copilot-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    authProvider: 'wam', accountName: username,
  };
}

export function runWamHelper(options, { timeoutMs = 300000, spawnChild = fork, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('WAM authentication requires Windows. Use MCP_AUTH=browser for the browser provider.');
  const { signal, ...request } = options;
  if (signal?.aborted) return Promise.reject(new Error('Microsoft sign-in was canceled.'));
  return new Promise((resolve, reject) => {
    // The native MSAL runtime keeps Node handles alive. Keep it in a short-lived
    // process and terminate that owned process after its IPC reply is received.
    // Tokens travel through the private parent/child channel, never stdio/argv.
    const child = spawnChild(new URL('./wam-helper.mjs', import.meta.url), [], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, AZURE_LOG_LEVEL: '' },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.once('close', () => error ? reject(error) : resolve(result));
      child.kill();
    };
    const abort = () => finish(new Error('Microsoft sign-in was canceled.'));
    const timer = setTimeout(() => finish(new Error('Microsoft sign-in timed out. Run mcp auth again.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(new Error(`Unable to start the WAM helper (${error.code || error.name}).`)));
    child.once('exit', () => {
      if (!settled) finish(new Error('The WAM helper exited before authentication completed. Run npm ci, then mcp auth.'));
    });
    child.once('message', result => {
      if (result?.type === 'token' && typeof result.token === 'string') finish(null, result);
      else finish(new Error(`Microsoft WAM sign-in failed (${result?.code || 'unknown_error'}). Complete the Windows sign-in prompt or run mcp auth --interactive.`));
    });
    child.send(request, error => { if (error) finish(new Error('Unable to contact the WAM helper. Run mcp auth again.')); });
  });
}

export function createAuthProvider({
  source = process.env.MCP_AUTH || 'wam', tenantId = process.env.MCP_TENANT_ID,
  account = process.env.MCP_ACCOUNT, acquire = runWamHelper,
  loadRecord = readRecord, persistRecord = saveRecord, now = Date.now,
  browserAcquire = browserCredentials,
} = {}) {
  if (!['wam', 'browser'].includes(source)) throw new Error('Set MCP_AUTH to wam or browser.');
  if (tenantId && tenantId !== 'organizations' && !uuid.test(tenantId)) throw new Error('MCP_TENANT_ID must be a tenant UUID or organizations.');
  let current; let record; let pending;
  const lifetime = new AbortController();
  const getCredentials = async ({ interactive = false, force = false } = {}) => {
    if (lifetime.signal.aborted) throw new Error('The authentication provider is closed.');
    if (pending) return pending;
    if (!force && !interactive && current && tokenExpiry(current) > now() + 120000) return current;
    pending = (async () => {
      let next;
      if (source === 'browser') next = { ...await browserAcquire(), authProvider: 'browser' };
      else {
        const selected = interactive ? undefined : record || await loadRecord();
        const result = await acquire({ interactive, tenantId: tenantId || selected?.tenantId || 'organizations', record: selected, signal: lifetime.signal });
        next = credentialsFromToken(result.token, { now: now(), tenantId: tenantId || selected?.tenantId, account: account || selected?.username });
        if (current && !interactive && (current['x-tenant-id'] !== next['x-tenant-id'] || current['x-user-id'] !== next['x-user-id'])) {
          throw new Error('The Windows account changed during this session. Restart mcp to select an account.');
        }
        const nextRecord = accountRecord(result.record);
        if (nextRecord.tenantId !== next['x-tenant-id'] || nextRecord.username.toLowerCase() !== next.accountName.toLowerCase()) throw new Error('WAM account metadata did not match the access token.');
        await persistRecord(nextRecord);
        record = nextRecord;
      }
      current = next;
      return next;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
  return { source, getCredentials, close: () => lifetime.abort() };
}
