import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access, mkdtemp, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const parent = join(root, '.e2e');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'live-'));
const marker = `MCP_FIXTURE_${randomUUID().replaceAll('-', '')}`;
await writeFile(join(directory, 'input.txt'), `${marker}\n`, 'utf8');
const outputPath = join(directory, 'result.cjs');
await assert.rejects(access(outputPath));

const launcher = process.env.MCP_LAUNCHER_PATH || (await execute('pwsh.exe', [
  '-NoProfile', '-Command', '(Get-Command mcp -CommandType ExternalScript -ErrorAction Stop).Source',
], { windowsHide: true, timeout: 10000 })).stdout.trim();
await access(launcher);
const relativeDirectory = relative(homedir(), directory).replaceAll('\\', '/');
const allowed = [
  `Read(~/${relativeDirectory}/input.txt)`,
  `Edit(~/${relativeDirectory}/result.cjs)`,
  `Write(~/${relativeDirectory}/result.cjs)`,
];
const prompt = [
  'Perform this small local coding task using the provided Read and Write tools.',
  'First read ./input.txt. Its entire trimmed content is a marker. Obtain the marker from the real Read result.',
  'Then write ./result.cjs with exactly one JavaScript statement: console.log followed by a parenthesized,',
  'JSON-double-quoted string consisting of MCP_E2E_OK: immediately followed by that marker, and a semicolon.',
  'Do not change input.txt or any other file. Do not run commands. After the successful Write result, reply E2E_DONE.',
].join(' ');

console.log(JSON.stringify({ stage: 'starting_real_claude', directory }));
const start = Date.now();
let stdout = ''; let stderr = ''; let exitCode = 0;
try {
  ({ stdout, stderr } = await new Promise((resolve, reject) => {
    const child = execFile('pwsh.exe', [
    '-NoProfile', '-File', launcher,
    '--safe-mode', '--tools', 'Read', 'Write',
    '--allowedTools', ...allowed,
    '--permission-mode', 'dontAsk', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '-p', prompt,
  ], {
    cwd: directory, env: { ...process.env, MCP_TRACE: '1' },
    windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    // execFile leaves a writable stdin pipe open. PowerShell may enumerate
    // pipeline input before starting its native child, so signal EOF explicitly.
    child.stdin.end();
    let progress = '';
    child.stderr.on('data', chunk => {
      progress += chunk;
      const lines = progress.split(/\r?\n/); progress = lines.pop();
      for (const line of lines) if (line.startsWith('[mcp:trace]')) console.log(line);
    });
  }));
} catch (error) {
  stdout = error.stdout || ''; stderr = error.stderr || ''; exitCode = error.code || 1;
}
const records = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const result = records.findLast(record => record.type === 'result');
const toolCalls = records.flatMap(record => record.type === 'assistant' ? record.message?.content || [] : [])
  .filter(block => block.type === 'tool_use').map(block => block.name);
const match = /\[mcp:summary\] (\{[^\n]+\})/.exec(stderr);
const proxyStats = match ? JSON.parse(match[1]) : null;
const trace = stderr.split(/\r?\n/).filter(line => line.startsWith('[mcp:trace]'));
const report = {
  date: new Date().toISOString(), directory, durationMs: Date.now() - start, exitCode,
  claudeResult: result ? { isError: result.is_error, result: result.result, permissionDenials: result.permission_denials, models: Object.keys(result.modelUsage || {}) } : null,
  toolCalls, proxyStats, trace, fileVerified: false, programOutput: null,
  declaredTools: records.find(record => record.type === 'system' && record.subtype === 'init')?.tools,
};

try {
  assert.equal(exitCode, 0, 'Claude process must exit successfully.');
  assert.equal(result?.is_error, false, 'Claude must report success.');
  assert.ok(result.result.includes('E2E_DONE'), 'Expected final marker.');
  assert.ok(result.modelUsage?.['claude-fable-5-1'], 'Expected explicit Fable model route.');
  assert.ok(toolCalls.includes('Read') && toolCalls.includes('Write'), 'Real Claude tool calls must include Read and Write.');
  assert.ok(proxyStats?.upstreamTurns >= 3 && proxyStats?.toolCalls >= 2 && proxyStats?.toolResults >= 2, 'Require multiple real upstream turns and returned tool results.');
  assert.equal(proxyStats.errors, 0);
  assert.deepEqual(result.permission_denials, []);
  const source = await readFile(outputPath, 'utf8');
  const expected = `console.log(${JSON.stringify(`MCP_E2E_OK:${marker}`)});`;
  assert.equal(source.trim(), expected, 'Verify exact safe source before executing the generated program.');
  assert.equal((await readFile(join(directory, 'input.txt'), 'utf8')).trim(), marker);
  report.fileVerified = true;
  const execution = await execute(process.execPath, [outputPath], { cwd: directory, windowsHide: true, timeout: 10000 });
  report.programOutput = execution.stdout.trim();
  assert.equal(report.programOutput, `MCP_E2E_OK:${marker}`);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
}
const reportPath = join(root, 'e2e-results.json');
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
