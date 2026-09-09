import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { loadPty } from './test-pty.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const pty = loadPty();
const expected = '77994';
const prompt = 'Compute 29371 + 48623. Reply only with the integer.';
await mkdir(join(root, '.e2e'), { recursive: true });
const directory = await mkdtemp(join(root, '.e2e/interactive-'));
await writeFile(join(directory, 'README.md'), '# Owned interactive test workspace\n\nOnly a synthetic arithmetic prompt is used here.\n', 'utf8');
if (JSON.stringify(await readdir(directory)) !== JSON.stringify(['README.md'])) throw new Error('Unexpected file in the new test workspace.');
const terminal = pty.spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'mcp'], {
  name: 'xterm-256color', cols: 120, rows: 36, cwd: directory,
  env: { ...process.env, MCP_TRACE: '1', TERM: 'xterm-256color' },
});
let output = ''; let sent = false; let exiting = false; let blockedReason; let timedOut = false;
let trustedTestDirectory = false; let screenOffset = 0;
const started = Date.now();
console.log(JSON.stringify({ stage: 'interactive_started', processId: terminal.pid, directory }));

const timeout = setTimeout(() => {
  timedOut = true;
  console.log(JSON.stringify({ stage: 'interactive_timeout', tail: stripVTControlCharacters(output).slice(-2500) }));
  terminal.kill();
}, 120000);
const progressTimer = setInterval(() => {
  if (!sent) console.log(JSON.stringify({ stage: 'interactive_waiting', tail: stripVTControlCharacters(output.slice(screenOffset)).slice(-1800) }));
}, 15000);

terminal.onData(data => {
  output = (output + data).slice(-256000);
  const text = stripVTControlCharacters(output);
  const screen = stripVTControlCharacters(output.slice(screenOffset));
  const compact = screen.replace(/\s/g, '').toLowerCase();
  if (!sent && compact.includes('yes,itrustthisfolder')) {
    const expectedPath = directory.replace(/\s/g, '').toLowerCase();
    if (!trustedTestDirectory && compact.includes(expectedPath) && compact.includes('❯1.yes,itrustthisfolder')) {
      // Approve only the exact, newly created workspace whose sole file we
      // inspected above. Never approve the user's home or another workspace.
      trustedTestDirectory = true;
      screenOffset = output.length;
      console.log(JSON.stringify({ stage: 'owned_test_workspace_confirmed' }));
      terminal.write('\r');
      return;
    }
    blockedReason = 'Workspace trust prompt did not match the reviewed test directory.';
    console.log(JSON.stringify({ stage: 'user_input_required', tail: screen.slice(-1800) }));
    terminal.kill();
    return;
  }
  if (!sent && /use(?:this|the)apikey|choosethetextstyle|choose.*theme/i.test(compact)) {
    blockedReason = 'An interactive trust/sign-in/setup prompt requires user input.';
    console.log(JSON.stringify({ stage: 'user_input_required', tail: text.slice(-2500) }));
    terminal.kill();
    return;
  }
  if (!sent && compact.includes('claudecode') && screen.includes('❯')) {
    sent = true;
    console.log(JSON.stringify({ stage: 'interactive_prompt_ready' }));
    terminal.write(prompt);
    setTimeout(() => terminal.write('\r'), 300);
  }
  if (sent && !exiting && text.includes(expected) && /"event":"response"/.test(text)) {
    exiting = true;
    console.log(JSON.stringify({ stage: 'interactive_reply_verified', expected }));
    setTimeout(() => terminal.write('/exit\r'), 800);
  }
});

terminal.onExit(async ({ exitCode }) => {
  clearTimeout(timeout);
  clearInterval(progressTimer);
  const text = stripVTControlCharacters(output);
  if (exitCode !== 0 || !exiting) {
    const tail = text.slice(-3500).replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
      .replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9_.-]+/gi, '[REDACTED_CREDENTIAL]');
    console.log(JSON.stringify({ stage: 'interactive_exit_diagnostic', tail }));
  }
  const summary = /\[mcp:summary\]\s*(\{[^\r\n]+\})/.exec(text);
  let proxyStats;
  try { proxyStats = summary ? JSON.parse(summary[1]) : undefined; } catch {}
  const report = {
    date: new Date().toISOString(), durationMs: Date.now() - started,
    interactiveTTY: true, directory, trustedTestDirectory, promptSent: sent, expectedReply: expected,
    replyVerified: exiting, exitCode, proxyStats, blockedReason, timedOut,
    passed: exitCode === 0 && exiting && proxyStats?.upstreamTurns >= 1 && proxyStats.errors === 0,
  };
  await writeFile(join(root, 'interactive-results.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  setTimeout(() => process.exit(report.passed ? 0 : 1), 50);
});
