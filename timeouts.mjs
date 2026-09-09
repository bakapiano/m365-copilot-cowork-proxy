export const defaultUpstreamTimeoutMs = 15 * 60 * 1000;
const clientGraceMs = 60 * 1000;
const maximumTimerMs = 2147483647;

export function requestTimeouts(value = process.env.MCP_UPSTREAM_TIMEOUT_MS) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const upstreamTimeoutMs = raw == null || raw === '' ? defaultUpstreamTimeoutMs : Number(raw);
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0 || upstreamTimeoutMs > maximumTimerMs - clientGraceMs) {
    throw new Error(`MCP_UPSTREAM_TIMEOUT_MS must be a positive integer no greater than ${maximumTimerMs - clientGraceMs}.`);
  }
  return { upstreamTimeoutMs, clientTimeoutMs: upstreamTimeoutMs + clientGraceMs };
}
