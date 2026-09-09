# Microsoft 365 Copilot Cowork Proxy

`mcp`: a local Anthropic-compatible gateway for Claude CLI, backed by the
user's authorized Microsoft 365 Copilot Cowork session.

Local Windows prototype using the already authorized Cowork browser session.
Default model: `claude-fable-5-1`, explicitly mapped to Cowork's `melon` (Fable 5.1).

## Install (Windows)

Requirements: Node.js 22+, Claude Code, Playwright CLI installed globally, and
the official Playwright browser extension in the signed-in Edge work profile.

```powershell
git clone https://github.com/bakapiano/m365-copilot-cowork-proxy.git
cd m365-copilot-cowork-proxy
.\install.ps1
mcp auth
mcp doctor
```

The installer reuses the local `ccp` launcher directory when present; otherwise
it uses a dedicated user-local bin directory. It installs only this project's
`mcp.ps1` and `mcp.cmd`, preserves unrelated commands, and needs no administrator
service. `-WhatIf` previews installation; `-BinDirectory` selects a destination.

`mcp auth` opens Cowork in the authorized browser session. Complete the normal
extension approval and Microsoft sign-in if prompted. Keep that browser session
available for subsequent credential discovery.

## Commands

```powershell
mcp doctor
mcp -p "Reply with a short greeting"
mcp
mcp -Model claude-fable-5-1
mcp auth
```

For interactive use, change to a code directory you own and run `mcp` without
`-p`. On first use, review and confirm Claude's workspace-trust prompt for that
directory. Existing running sessions keep their loaded proxy code; exit and
start a new `mcp` session after updating this repository.

On the existing `ccp` setup, `mcp.ps1` and `mcp.cmd` live next to its launchers in
`%LOCALAPPDATA%\gc2cc\bin`, already on the user PATH. Other installations use the
dedicated user-local directory described above. Existing `ccp` files, its service,
and its settings are preserved.

Each invocation starts a loopback-only proxy on an available port, supplies a
random local API key to its Claude child process, and stops the proxy when that
child exits. Parent-shell authentication variables are preserved. Claude's own
permission checks remain active; the launcher adds no permission-bypass flag.
Ordinary launches use `ANTHROPIC_AUTH_TOKEN` bearer authentication, following the
local `ccp` convention. `--bare` uses its required `ANTHROPIC_API_KEY` path.
If an SDK also sends a stale secondary auth header, at least one credential must
still exactly match the gateway's random local key. Anonymous inference and
incorrect credentials remain rejected.
An invocation-scoped `--settings` overlay pins model/routing values so existing
Claude `settings.json.env` entries cannot silently send requests to another proxy.
The global Claude settings files remain unchanged. Print-mode success with zero
requests through this gateway is treated as a failed routing check.

## Authentication

The source is Playwright CLI session `cowork-inspect`, connected through the
official extension to the user's signed-in Edge profile. Request headers are
read into memory; the gateway never saves the Microsoft bearer token or the
extension connection token. It discovers recent captured Cowork requests and
checks token expiration. `mcp auth` opens a new Cowork tab for normal user sign-in
when a fresh request is needed. Installation/enabling of browser extensions and
MFA are performed by the user. Organizational access policies remain in force.

Optional environment settings:

- `PLAYWRIGHT_SESSION`: source browser session (default `cowork-inspect`).
- `PLAYWRIGHT_CWD`: authentication workspace (default user home), independent of
  the code repository from which `mcp` is launched.
- `COWORK_REQUEST_INDEX`: explicit captured request override for diagnostics.
- `MCP_TRACE=1`: sanitized request/response metadata, never headers or prompts.
- `MCP_REASONING_EFFORT`: low, medium, high, xhigh, or max (default medium).
- `MCP_PORT`: fixed loopback port; default uses an available ephemeral port.
- `CLAUDE_CLI_PATH`: optional path to the installed Claude executable.

## Protocol and boundaries

- `POST /v1/messages`: Anthropic-style text and client tool blocks, including SSE.
- `POST /v1/messages/count_tokens`: **estimate** based on UTF-8 byte count / 3.
- `GET /v1/models`: Fable alias metadata.
- `HEAD/GET /api/hello`: empty unauthenticated connection-warmup response;
  inference and account-data endpoints continue to require the local key.
- Ordinary Claude sessions can include `role: system` context entries inside
  `messages`; these are retained and normalized into the client system context.
- Microsoft upstream: `POST /v1/messages` => `202 accepted`, followed by independent
  `/v1/subscribe` SSE. Observed `dx` carries text increments, `fr` authoritative
  final content, and `rl` with `st=ok` marks completion.
- Client tools are **prompt-emulated**: the model proposes a JSON tool envelope;
  the proxy validates names against the caller's catalog and emits Anthropic
  `tool_use`. Execution and permissions belong to the local Claude CLI. Tool
  results are included in the next upstream prompt. This is not native Cowork
  forwarding of arbitrary client tools.
- Each API turn uses a fresh Cowork conversation with serialized client history.
- SSE output is buffered until the model's tool envelope can be validated.
- Upstream token usage is unavailable; `usage` contains zero placeholders and
  `x-mcp-usage: unavailable-zero-placeholders`. It is not billing telemetry.
- `max_tokens` is an advisory prompt budget because an equivalent enforceable
  upstream field has not been established. Images and native thinking signatures
  are outside the verified compatibility scope.
- Local client disconnect closes the subscription; server-side cancellation has
  not been implemented. Fresh conversations will appear in Cowork history.
- This is a user-authorized experimental bridge, not a Microsoft or Anthropic
  supported API contract. Review organizational rules before regular use.

## Tests

```powershell
npm test
npm run test:e2e
```

`npm test` runs the explicit unit-test file. For true TTY coverage, install the
development dependency (`npm install`) and run `npm run test:interactive`.
The interactive test creates and inspects a dedicated scratch directory and
confirms only that directory's workspace-trust prompt. It never confirms trust
for the user's home directory. Test reports and scratch content are gitignored.

The live E2E test uses the real Claude executable, a dedicated synthetic fixture,
and a limited Read/Write tool allowlist. It verifies that the generated local
program contains the fixture marker and produces the expected output.

### Verified on 2026-09-09

- Claude Code **2.1.229** through the installed `mcp` launcher.
- Text-only request: exact expected marker, one observed Fable upstream turn.
- Coding E2E: three observed Fable upstream turns, real local `Read` and `Write`,
  tool results returned to the model, final `E2E_DONE`, zero permission denials.
- The verifier inspected the exact generated JavaScript before running it and
  confirmed its output against a randomly generated fixture marker.
- Latest coding E2E completed in about 46 seconds. Detailed local evidence:
  `e2e-results.json` (gitignored).
- Tests use `--safe-mode`, an explicit tool catalog, `dontAsk`, and home-relative
  permissions for only the test files. `Edit(...)` covers the file-writer rule.
  Normal `mcp` sessions keep the user's ordinary Claude permission behavior.
- Ordinary `mcp -p` regression: preserves embedded system-role context and
  verifies a real Fable response with the normal user configuration loaded.
- True interactive TTY regression: starts `mcp`, confirms only a reviewed scratch
  workspace, enters an arithmetic prompt, verifies the answer, and exits cleanly.
  Passed in about 20 seconds with zero proxy errors (`interactive-results.json`,
  gitignored).
- Ten unit/regression tests cover both credential paths, mixed SDK headers,
  unauthenticated connection warmup, system-context normalization, SSE framing,
  local tool translation, and rejection of invalid credentials/tools.

## References

- Claude gateway wire protocol: https://code.claude.com/docs/en/llm-gateway-protocol
- Playwright CLI: https://github.com/microsoft/playwright-cli
- Anthropic translation reference reviewed during development:
  https://github.com/mahmoudsallem/m365-copilot-proxy-claude

The Aether transport and local launcher in this repository were implemented
locally from authorized request captures. No third-party bootstrap script is
downloaded or executed by this gateway.
