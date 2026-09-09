import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(join(root, '.e2e'), { recursive: true });
const directory = await mkdtemp(join(root, '.e2e/compression-'));
const expected = Array.from({ length: 80 }, (_, index) => `TRANSPORT_GZIP_OK ${String(index + 1).padStart(3, '0')}`);
const prompt = 'Transport regression test. Reply with exactly 80 plain text lines, with no extra text or markdown fences. '
  + 'Each line is TRANSPORT_GZIP_OK followed by one space and a three-digit number, from 001 through 080 in order. Use only text.';
const started = Date.now();
let stdout = ''; let stderr = ''; let exitCode = 0;
try {
  ({ stdout, stderr } = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(root, 'launcher.mjs'),
      '--safe-mode', '--tools', 'Read', '--permission-mode', 'dontAsk', '--no-session-persistence', '--effort', 'high', '-p', prompt,
    ], { cwd: directory, env: { ...process.env, MCP_TRACE: '1' }, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    child.stdin.end();
  }));
} catch (error) { stdout = error.stdout || ''; stderr = error.stderr || ''; exitCode = error.code || 1; }
const trace = stderr.split(/\r?\n/).flatMap(line => {
  try { return line.startsWith('[mcp:trace] ') ? [JSON.parse(line.slice('[mcp:trace] '.length))] : []; } catch { return []; }
});
const summary = /\[mcp:summary\] (\{[^\n]+\})/.exec(stderr);
const stats = summary ? JSON.parse(summary[1]) : undefined;
const report = {
  date: new Date().toISOString(), durationMs: Date.now() - started, exitCode,
  authProvider: /\[mcp\] auth=(\w+)/.exec(stderr)?.[1],
  compressedFinalReceived: trace.some(event => event.event === 'upstream_event' && event.kind === 'fr' && event.compressed),
  lineCount: stdout.trim().split(/\r?\n/).length, proxyStats: stats,
};
try {
  assert.equal(exitCode, 0);
  assert.deepEqual(stdout.trim().split(/\r?\n/), expected);
  assert.equal(report.compressedFinalReceived, true, 'Require a real compressed final frame, not just a long answer.');
  assert.equal(stats?.errors, 0);
  assert.equal(stats?.upstreamTurns, 1);
  assert.equal(stats?.toolCalls, 0);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
await writeFile(join(root, '.e2e/compression-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
