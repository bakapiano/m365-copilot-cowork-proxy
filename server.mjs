import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { generateText, tokenExpiry } from './upstream.mjs';
import { buildPrompt, decodeCompletion, completionMessage, messageEvents, defaultModel, RequestError } from './protocol.mjs';

const limit = 4 * 1024 * 1024;
export function createProxy({ key, credentials, refreshCredentials, generator = generateText, log = () => {} }) {
  if (!key || key.length < 24) throw new Error('A random local gateway key is required.');
  let currentCredentials = credentials;
  let active = 0;
  const stats = { requests: 0, upstreamTurns: 0, toolCalls: 0, toolResults: 0, errors: 0 };
  const controllers = new Set();
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const authState = req => {
    const matches = value => {
      const a = Buffer.from(String(value || '')); const b = Buffer.from(key);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    return {
      apiKeyPresent: !!req.headers['x-api-key'], authorizationPresent: !!req.headers.authorization,
      apiKeyMatches: matches(req.headers['x-api-key']), authorizationMatches: matches(bearer),
    };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.origin) return json(res, 403, { type: 'error', error: { type: 'permission_error', message: 'Local CLI clients only.' } });
    // Claude's connection warmup is intentionally unauthenticated and carries
    // no inference or account data. All model/data routes remain authenticated.
    if (['HEAD', 'GET'].includes(req.method) && url.pathname === '/api/hello') {
      res.writeHead(200, { 'cache-control': 'no-store', 'content-length': '0' });
      res.end();
      return;
    }
    const authentication = authState(req);
    // Both supported headers authenticate the same single local identity.
    // A stale SDK x-api-key must not hide a valid explicit gateway bearer token.
    if (!authentication.apiKeyMatches && !authentication.authorizationMatches) {
      log({ event: 'local_auth_error', method: req.method, path: url.pathname, ...authentication });
      return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'A valid local gateway key is required.' } });
    }
    if (authentication.apiKeyPresent && authentication.authorizationPresent && authentication.apiKeyMatches !== authentication.authorizationMatches) {
      log({ event: 'gateway_auth_header_mix', ...authentication });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { data: [{ type: 'model', id: defaultModel, display_name: 'Fable 5.1 (Cowork)', created_at: '2026-09-09T00:00:00Z' }], has_more: false, first_id: defaultModel, last_id: defaultModel });
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', backend: 'cowork-aether', model: 'melon' });
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unknown endpoint.' } });
    }
    let timer; let controller; let ping;
    try {
      if (!(req.headers['content-type'] || '').includes('application/json')) throw new RequestError('Use application/json.');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new RequestError('Request exceeds 4 MiB.', 413); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { throw new RequestError('Invalid JSON.'); }
      if (url.pathname.endsWith('/count_tokens')) {
        res.setHeader('x-mcp-token-count', 'estimated-utf8-bytes-divided-by-3');
        return json(res, 200, { input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(raw) / 3)) });
      }
      log({
        event: 'request_shape', model: body?.model,
        keys: body && typeof body === 'object' ? Object.keys(body) : [],
        messages: Array.isArray(body?.messages) ? body.messages.slice(0, 12).map(message => ({
          role: typeof message?.role === 'string' ? message.role : `<${typeof message?.role}>`,
          keys: message && typeof message === 'object' ? Object.keys(message) : [],
          contentType: Array.isArray(message?.content) ? 'array' : typeof message?.content,
          blocks: Array.isArray(message?.content) ? message.content.slice(0, 8).map(block => block?.type) : [],
        })) : [],
      });
      const prompt = buildPrompt(body);
      if (active >= 4) throw new RequestError('Four local requests are already active.', 429);
      active++; stats.requests++;
      stats.toolResults += body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result').length;
      controller = new AbortController(); controllers.add(controller);
      timer = setTimeout(() => controller.abort(), Number(process.env.MCP_UPSTREAM_TIMEOUT_MS || 180000));
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      if (tokenExpiry(currentCredentials) < Date.now() + 120000) {
        if (!refreshCredentials) throw new Error('Fresh upstream credentials are required. Restart mcp.');
        currentCredentials = await refreshCredentials();
      }
      const effort = body.output_config?.effort || process.env.MCP_REASONING_EFFORT || 'medium';
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new RequestError('Unsupported reasoning effort.');
      const inputTools = (body.tools || []).map(tool => tool.name);
      log({ event: 'request', number: stats.requests, model: body.model, effort, tools: inputTools, messages: body.messages.length, stream: !!body.stream });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-mcp-usage': 'unavailable-zero-placeholders', 'x-mcp-streaming': 'buffered-completion' });
        res.write(': Cowork request accepted by local gateway\n\n');
        ping = setInterval(() => { if (!res.destroyed) res.write('event: ping\ndata: {"type":"ping"}\n\n'); }, 8000);
      }
      stats.upstreamTurns++;
      const upstream = await generator(currentCredentials, prompt, { signal: controller.signal, effort,
        onEvent: (kind, metadata) => {
          if (['fr', 'rl', 'error', 'err'].includes(kind)) log({ event: 'upstream_event', kind, compressed: metadata?.compressed === true });
        },
      });
      const decoded = decodeCompletion(upstream.text, body);
      const message = completionMessage(decoded, body.model);
      const proposed = message.content.filter(block => block.type === 'tool_use').map(block => block.name);
      stats.toolCalls += proposed.length;
      log({ event: 'response', toolCalls: proposed, stopReason: message.stop_reason, upstreamStop: upstream.stop, parsedEnvelope: decoded.parsedEnvelope });
      if (body.stream) {
        for (const event of messageEvents(message)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else {
        res.setHeader('x-mcp-usage', 'unavailable-zero-placeholders');
        json(res, 200, message);
      }
    } catch (error) {
      stats.errors++;
      const status = error.status || 502;
      const detail = error.name === 'AbortError' ? 'Cowork request timed out or the client disconnected.' : error.message;
      const body = { type: 'error', error: { type: error instanceof RequestError ? 'invalid_request_error' : 'api_error', message: detail } };
      log({ event: 'error', status, message: detail });
      if (!res.destroyed) {
        if (res.headersSent) { res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`); res.end(); }
        else json(res, status, body);
      }
    } finally {
      clearTimeout(timer); clearInterval(ping);
      if (controller) { controller.abort(); controllers.delete(controller); active--; }
    }
  });
  return {
    server, stats,
    async listen(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
