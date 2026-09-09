import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { loadPty } from './test-pty.mjs';
const pty = loadPty();
const terminal = pty.spawn(process.execPath, ['-e', 'console.log("PTY_READY:" + process.stdin.isTTY)'], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: homedir(), env: process.env,
});
let output = '';
const timer = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 10000);
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  const text = stripVTControlCharacters(output).trim();
  console.log(JSON.stringify({ exitCode, ttyVerified: text.includes('PTY_READY:true'), output: text }));
  process.exitCode = exitCode || (text.includes('PTY_READY:true') ? 0 : 1);
  setTimeout(() => process.exit(process.exitCode), 50);
});
