import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createProxy } from './server.mjs';
import { browserCredentials, verifyModel, runBrowserCli, tokenExpiry } from './upstream.mjs';
import { defaultModel, modelAliases } from './protocol.mjs';
import { localRouting } from './routing.mjs';

function help() {
  console.log(`mcp - Claude CLI through Microsoft 365 Cowork / Fable 5.1

  mcp [Claude arguments...]            Start Claude with the local proxy
  mcp -Model claude-fable-5-1 [...]     Choose the Fable alias explicitly
  mcp doctor                          Verify browser credentials and model access
  mcp auth                            Open Cowork for normal browser sign-in
  mcp models                          Show the routed model
  mcp -- --help                       Forward help to Claude

The proxy binds only to 127.0.0.1, uses an in-memory random local key,
and exits with Claude. Claude's own permission checks remain active.
PLAYWRIGHT_SESSION defaults to cowork-inspect. No account token is saved.
`);
}

async function authenticate() {
  console.error('[mcp] Opening the authorized Edge profile. Complete any browser sign-in/connection prompt.');
  try { await runBrowserCli(['snapshot'], 15000); }
  catch { await runBrowserCli(['attach', '--extension=msedge', `--session=${process.env.PLAYWRIGHT_SESSION || 'cowork-inspect'}`], 90000); }
  await runBrowserCli(['tab-new', 'https://copilot.cloud.microsoft/cowork'], 30000);
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const credentials = await browserCredentials();
      const model = await verifyModel(credentials);
      console.log(`[mcp] Ready: ${model.displayName}; credential expires ${new Date(tokenExpiry(credentials)).toISOString()}.`);
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Complete sign-in in the opened Cowork tab, then run mcp doctor.');
}

async function main() {
  const args = process.argv.slice(2);
  if (['--help', '-h', 'help'].includes(args[0])) return help();
  if (args[0] === 'auth') return authenticate();
  const credentials = await browserCredentials();
  const model = await verifyModel(credentials);
  if (args[0] === 'doctor' || args[0] === 'models') {
    console.log(JSON.stringify({ status: 'ok', model: defaultModel, upstream: model, credentialExpires: new Date(tokenExpiry(credentials)).toISOString() }, null, 2));
    return;
  }
  let selected = defaultModel;
  const forwarded = [];
  let additionalSettings = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') { forwarded.push(...args.slice(index + 1)); break; }
    if (/^--?model$/i.test(args[index])) { selected = args[++index]; continue; }
    if (args[index] === '--settings' || args[index].startsWith('--settings=')) {
      const value = args[index] === '--settings' ? args[++index] : args[index].slice('--settings='.length);
      if (!value) throw new Error('--settings requires JSON or a filename.');
      const settings = JSON.parse(value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'));
      additionalSettings = { ...additionalSettings, ...settings, env: { ...additionalSettings.env, ...settings.env } };
      continue;
    }
    forwarded.push(args[index]);
  }
  if (!modelAliases.has(selected)) throw new Error(`Choose model ${defaultModel}.`);
  const key = randomBytes(32).toString('hex');
  const trace = process.env.MCP_TRACE === '1';
  const proxy = createProxy({ key, credentials, log: event => { if (trace) console.error(`[mcp:trace] ${JSON.stringify(event)}`); } });
  const base = await proxy.listen(Number(process.env.MCP_PORT || 0));
  const routing = localRouting(base, key, selected, { bare: forwarded.includes('--bare') || process.env.CLAUDE_CODE_SIMPLE === '1' });
  const env = { ...process.env, ...routing };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  const executable = process.env.CLAUDE_CLI_PATH || join(homedir(), '.local/bin/claude.exe');
  console.error(`[mcp] model=${selected} upstream=melon proxy=${base}`);
  // Claude settings.json.env can override inherited environment variables.
  // A process-scoped settings overlay pins only routing/model values while
  // keeping normal user/project permissions, hooks and other settings intact.
  const overlay = { ...additionalSettings, model: selected, env: { ...additionalSettings.env, ...routing } };
  if (trace) {
    const optionValues = flag => {
      const start = forwarded.indexOf(flag);
      if (start < 0) return [];
      const values = [];
      for (let index = start + 1; index < forwarded.length && !forwarded[index].startsWith('-'); index++) values.push(forwarded[index]);
      return values;
    };
    console.error(`[mcp:trace] ${JSON.stringify({ event: 'cli_options', tools: optionValues('--tools'), allowedTools: optionValues('--allowedTools') })}`);
  }
  const child = spawn(executable, [...forwarded, '--settings', JSON.stringify(overlay), '--model', selected], { env, stdio: 'inherit', windowsHide: true });
  const stop = () => child.kill();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    if (process.exitCode === 0 && forwarded.some(value => ['-p', '--print'].includes(value)) && proxy.stats.upstreamTurns === 0) {
      console.error('[mcp] Routing verification failed: Claude completed without reaching this proxy.');
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (trace) console.error(`[mcp:summary] ${JSON.stringify(proxy.stats)}`);
    await proxy.close();
  }
}

main().catch(error => { console.error(`[mcp] ${error.message}`); process.exitCode = 1; });
