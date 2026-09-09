# Microsoft 365 Copilot Cowork Proxy

`mcp`: a local Anthropic-compatible gateway for Claude CLI, backed by the
user's authorized Microsoft 365 Copilot Cowork account.

Local Windows prototype using Azure Identity/MSAL and Windows Web Account
Manager (WAM) for sign-in.
Default model: `claude-fable-5-1`, explicitly mapped to Cowork's `melon` (Fable 5.1).

## Install (Windows)

Requirements: Windows, Node.js 22+, Claude Code, and a work account with Cowork
access. Authentication uses the Microsoft account connected to Windows and
opens the Microsoft system sign-in window when confirmation is needed.

```powershell
git clone https://github.com/bakapiano/m365-copilot-cowork-proxy.git
cd m365-copilot-cowork-proxy
npm ci
.\install.ps1
mcp auth
mcp doctor
```

The installer reuses the local `ccp` launcher directory when present; otherwise
it uses a dedicated user-local bin directory. It installs only this project's
`mcp.ps1` and `mcp.cmd`, preserves unrelated commands, and needs no administrator
service. `-WhatIf` previews installation; `-BinDirectory` selects a destination.

`mcp auth` reuses the Windows account when possible. `mcp auth --interactive`
opens the Microsoft account picker directly. Complete any sign-in/MFA prompt
yourself. Subsequent requests use WAM's account/token management.

## Commands

```powershell
mcp doctor
mcp -p "Reply with a short greeting"
mcp
mcp -Model claude-fable-5-1
mcp auth
mcp auth --interactive
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

### Windows WAM (default)

The gateway uses `@azure/identity` with the official `@azure/identity-broker`
plugin. It uses Cowork's public **M365ChatClient** application ID
`c0ab8ce9-e9a0-42e7-b064-33d422df41f1` and the delegated scope
`6ab48b67-cd74-4ad4-81af-5932984589be/access_as_user`.

WAM carries the Windows account/device identity through the normal Microsoft
authentication flow. Existing sign-in is reused; interaction opens the system
account picker or verification window directly. Organizational conditional
access, device compliance, MFA, and model entitlement remain enforced.

The gateway saves an allowlisted **account selector** (username, tenant, account
ID and Azure Identity metadata) in
`%LOCALAPPDATA%\m365-copilot-cowork-proxy\account.json`. Windows owns token caching.
The gateway keeps bearer tokens in memory and passes them through a private
parent/child IPC channel. Account tokens are excluded from files, command-line
arguments, and logs. A short-lived helper isolates the native MSAL runtime and
is terminated when authentication finishes. Credentials approaching expiration
are reacquired through WAM; concurrent requests share one authentication attempt.
An active CLI session stays pinned to its original account and tenant.

The npm dependencies include the Microsoft authentication libraries. Azure CLI,
Python, Playwright, and browser extensions are optional for this default path.

### Optional browser provider

For the original authorized-browser workflow, install Playwright CLI and its
official browser extension in the signed-in Edge work profile, then select it
explicitly for the current shell:

```powershell
$env:MCP_AUTH = 'browser'
mcp auth
mcp doctor
```

This provider reads recent authorized Cowork request headers into memory from
Playwright session `cowork-inspect`. Keep that browser session available for
credential discovery. To return to Windows sign-in, set `$env:MCP_AUTH = 'wam'`.

### Authentication investigation (2026-09-09)

- Azure CLI's own client returned `AADSTS65002` for the Cowork resource, which
  requires API-owner preauthorization for that client.
- MSAL device-code sign-in using M365ChatClient reached a device conditional
  access check with error `530033` in the tested corporate tenant.
- M365ChatClient + Windows WAM acquired an `access_as_user` token accepted by
  Cowork `/v1/models`, with Fable 5.1 (`melon`) present. The default implementation
  uses this verified authentication path.

Optional environment settings:

- `MCP_AUTH`: `wam` (default) or `browser`.
- `MCP_TENANT_ID`: optional tenant UUID; otherwise use saved account metadata or
  the `organizations` authority for initial Windows account selection.
- `MCP_ACCOUNT`: optional expected username; token identity is checked before
  sending requests to Cowork.
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

`npm test` runs the explicit protocol and authentication test files. For true
TTY coverage, run `npm run test:interactive` after installing npm dependencies.
The interactive test creates and inspects a dedicated scratch directory and
confirms only that directory's workspace-trust prompt. It never confirms trust
for the user's home directory. Test reports and scratch content are gitignored.

The live E2E test uses the real Claude executable, a dedicated synthetic fixture,
and a limited Read/Write tool allowlist. It verifies that the generated local
program contains the fixture marker and produces the expected output.

### Verified on 2026-09-09

- Claude Code **2.1.229** through the installed `mcp` launcher.
- Default WAM authentication and explicit `mcp auth --interactive` both returned
  successful model-access checks for the intended work account.
- Text-only request: exact expected marker, one observed Fable upstream turn.
- Coding E2E: three observed Fable upstream turns, real local `Read` and `Write`,
  tool results returned to the model, final `E2E_DONE`, zero permission denials.
- The verifier inspected the exact generated JavaScript before running it and
  confirmed its output against a randomly generated fixture marker.
- Detailed local coding E2E evidence:
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
- Twenty-one unit/regression tests cover WAM token validation, account selection,
  single-flight refresh, account pinning, token-free account metadata, both local
  credential paths, helper IPC/timeout/shutdown, mixed SDK headers,
  unauthenticated connection warmup, system-context normalization, SSE framing,
  local tool translation, and rejection of invalid credentials/tools.

## References

- Claude gateway wire protocol: https://code.claude.com/docs/en/llm-gateway-protocol
- Playwright CLI: https://github.com/microsoft/playwright-cli
- Azure Identity broker: https://learn.microsoft.com/javascript/api/overview/azure/identity-broker-readme
- Anthropic translation reference reviewed during development:
  https://github.com/mahmoudsallem/m365-copilot-proxy-claude

The Aether transport and local launcher in this repository were implemented
locally from authorized request captures. No third-party bootstrap script is
downloaded or executed by this gateway.
