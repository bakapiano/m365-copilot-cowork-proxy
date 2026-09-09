import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const maxSseFrameBytes = 1024 * 1024;
const maxDecodedEventBytes = 4 * 1024 * 1024;
export const upstreamOrigin = 'https://mcsaetherruntime-seas.as-ia101.gateway.prod.island.powerapps.com';

// The existing, user-authorized browser request is the credential source.
// Its headers are captured in memory, never logged or written to a file.
export async function runBrowserCli(args, timeout = 20000) {
  const cli = join(process.env.APPDATA, 'npm/node_modules/@playwright/cli/playwright-cli.js');
  const session = process.env.PLAYWRIGHT_SESSION || 'cowork-inspect';
  const { stdout } = await execFileAsync(process.execPath, [cli, `-s=${session}`, ...args], {
    // Browser sessions belong to the authentication workspace, not whichever
    // code repository the caller happens to launch Claude from.
    cwd: process.env.PLAYWRIGHT_CWD || homedir(),
    windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

export function tokenExpiry(credentials) {
  try {
    const payload = JSON.parse(Buffer.from(credentials.authorization.split('.')[1], 'base64url').toString('utf8'));
    return Number(payload.exp) * 1000;
  } catch { return 0; }
}

function parseHeaders(stdout) {
  const headers = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9-]+):\s*(.*)$/i.exec(line);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  return headers;
}

export async function browserCredentials() {
  let indexes;
  if (process.env.COWORK_REQUEST_INDEX) indexes = [process.env.COWORK_REQUEST_INDEX];
  else {
    let listing;
    try { listing = await runBrowserCli(['requests', '--filter', 'mcsaetherruntime']); }
    catch { throw new Error('The Cowork browser session is disconnected. Run mcp auth to reconnect, then retry.'); }
    indexes = [...listing.matchAll(/^(\d+)\. \[(?:GET|POST|PUT)\] https:\/\/mcsaetherruntime-seas\.as-ia101\.gateway\.prod\.island\.powerapps\.com\//gm)]
      .map(match => match[1]).reverse().slice(0, 4);
  }
  for (const index of indexes) {
    const headers = parseHeaders(await runBrowserCli(['request-headers', index]));
    if (headers.authorization?.startsWith('Bearer ') && headers['x-tenant-id'] && headers['x-user-id']
      && tokenExpiry(headers) > Date.now() + 30000) return headers;
  }
  throw new Error('A fresh authorized Cowork request is required. Run mcp auth, complete sign-in, then retry.');
}

export function conversationId(credentials) {
  return `${credentials['x-tenant-id']}:${credentials['x-user-id']}:${randomUUID()}`;
}

export function upstreamHeaders(credentials, conversation, { model = 'melon', effort } = {}) {
  const config = (credentials['x-container-config'] || '').split(';').filter(Boolean)
    .filter(part => !part.startsWith('model='));
  config.push(`model=${model}`);
  if (effort) {
    for (let i = config.length - 1; i >= 0; i--) if (config[i].startsWith('reasoningEffort=')) config.splice(i, 1);
    config.push(`reasoningEffort=${effort}`);
  }
  return {
    authorization: credentials.authorization,
    'content-type': 'application/json',
    origin: 'https://copilot.cloud.microsoft',
    referer: 'https://copilot.cloud.microsoft/',
    'x-tenant-id': credentials['x-tenant-id'],
    'x-user-id': credentials['x-user-id'],
    'x-conversation-id': conversation,
    'x-request-id': randomUUID(),
    'x-copilot-timezone': credentials['x-copilot-timezone'] || 'Asia/Shanghai',
    'x-container-config': config.join(';'),
  };
}

export async function verifyModel(credentials) {
  const response = await fetch(`${upstreamOrigin}/v1/models`, {
    headers: upstreamHeaders(credentials, conversationId(credentials)),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Upstream model check returned HTTP ${response.status}.`);
  const data = await response.json();
  const model = data.models?.find(item => item.id === 'melon');
  if (!model) throw new Error('Fable model alias melon was absent from the authorized model list.');
  return { id: model.id, displayName: model.display_name, provider: model.provider };
}

export async function startTurn(credentials, text, { signal, conversation = conversationId(credentials), additionalBody = {}, effort } = {}) {
  const headers = upstreamHeaders(credentials, conversation, { effort });
  const subscriptionUrl = `${upstreamOrigin}/v1/subscribe?conversationId=${encodeURIComponent(conversation)}&_nonce=${randomUUID()}`;
  const subscription = await fetch(subscriptionUrl, { headers, signal });
  if (!subscription.ok) throw new Error(`Upstream subscription returned HTTP ${subscription.status}.`);
  if (!subscription.headers.get('content-type')?.includes('text/event-stream')) {
    await subscription.body?.cancel();
    throw new Error('Upstream subscription did not return an SSE content type.');
  }
  const messageId = randomUUID();
  const response = await fetch(`${upstreamOrigin}/v1/messages`, {
    method: 'POST', headers, signal,
    body: JSON.stringify({
      content: [{ text, type: 'text' }], conversationId: conversation,
      messageId, queue: true, role: 'user', ...additionalBody,
    }),
  });
  if (!response.ok) {
    await subscription.body?.cancel();
    throw new Error(`Upstream message submission returned HTTP ${response.status}.`);
  }
  const accepted = await response.json();
  return { subscription, conversation, messageId, acceptedStatus: accepted.status, httpStatus: response.status };
}

export async function generateText(credentials, text, { signal, effort, onEvent = () => {} } = {}) {
  const turn = await startTurn(credentials, text, {
    signal, effort,
    additionalBody: { connectorsConfig: { connectors: [], include_defaults: false, packages: [] } },
  });
  return readCompletion(turn.subscription, { onEvent });
}

export async function readCompletion(subscription, { onEvent = () => {} } = {}) {
  let streamedCharacters = 0;
  let finalText;
  let stop;
  for await (const event of sseEvents(subscription)) {
    onEvent(event.event, { compressed: event.compressed });
    if (event.event === 'dx' && typeof event.data?.t === 'string') streamedCharacters += event.data.t.length;
    if (event.event === 'fr') {
      if (typeof event.data?.content !== 'string') throw new Error('Cowork final response contained an invalid content payload.');
      finalText = event.data.content;
      stop = event.data.stop;
    }
    if (event.event === 'rl' && event.data?.st === 'ok') {
      if (finalText === undefined) throw new Error('Cowork completed without an authoritative final response.');
      return { text: finalText, stop, streamedCharacters };
    }
    if (['error', 'err'].includes(event.event)) throw new Error('Cowork reported an upstream generation error.');
  }
  if (finalText !== undefined) return { text: finalText, stop, streamedCharacters };
  throw new Error('Cowork stream ended before an authoritative final response.');
}

async function decodeEventData(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return { data: null, compressed: false }; }
  if (data?.compressed !== true) return { data, compressed: false };
  const encoded = data.data;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Cowork compressed event contained invalid Base64 data.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Cowork compressed event contained invalid Base64 data.');
  let decoded;
  try { decoded = await gunzipAsync(bytes, { maxOutputLength: maxDecodedEventBytes }); }
  catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Cowork decoded event exceeded the 4 MiB size limit.');
    throw new Error('Cowork compressed event contained invalid Gzip data.');
  }
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); }
  catch { throw new Error('Cowork compressed event contained invalid UTF-8 JSON.'); }
  return { data, compressed: true };
}

export async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let separator;
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, separator.index);
        if (Buffer.byteLength(block) > maxSseFrameBytes) throw new Error('Upstream SSE frame exceeded the 1 MiB size limit.');
        buffer = buffer.slice(separator.index + separator[0].length);
        let event = 'message';
        let id;
        const data = [];
        for (const line of block.split(/\r\n|\n|\r/)) {
          if (line.startsWith('event:')) event = line.slice(6).trimStart();
          if (line.startsWith('id:')) id = line.slice(3).trimStart();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) {
          const raw = data.join('\n');
          const parsed = await decodeEventData(raw);
          yield { event, id, ...parsed, raw };
        }
      }
      if (done) break;
      if (Buffer.byteLength(buffer) > maxSseFrameBytes) throw new Error('Upstream SSE frame exceeded the 1 MiB size limit.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function safeShape(value, key = '', depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '<nested>';
  if (Array.isArray(value)) return value.slice(0, 3).map(item => safeShape(item, key, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50)
    .map(([name, item]) => [name, safeShape(item, name, depth + 1)]));
  if (typeof value !== 'string') return value;
  if (/^(?:type|role|status|st|event|eventType|stop_reason|model|name)$/.test(key)
    && /^[a-zA-Z0-9_.:-]{1,70}$/.test(value)) return value;
  return `<string:${value.length}>`;
}
