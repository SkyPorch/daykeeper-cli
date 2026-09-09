# Daykeeper CLI

A command line for people, agents, and CI jobs managing Daykeeper. It calls the
published `@skyporch/daykeeper@0.2.0` SDK and returns one versioned JSON envelope
per invocation. It does not depend on a private application or workspace package.

This is an **unpublished foundation** for `@skyporch/daykeeper-cli`. The package
is marked private until its bootstrap release is reviewed and approved. The code
is Apache-2.0; see [LICENSE](LICENSE) and [RELEASING.md](RELEASING.md).

## Run from this repository

Use Node.js 20 or newer and pnpm 10.8.0:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

`pnpm daykeeper --help` runs the same CLI from source. The examples below use
`node dist/cli.js`; the package's executable will be `daykeeper` after an
approved publication. Do not assume this CLI is available from npm yet.

## Quickstart

One command gives an agent a working support inbox with no console login:

```sh
node dist/cli.js init --name "Acme Support" --plan free --origin https://your-daykeeper-origin.example --json
```

`init` enrolls a machine owner, stores the credential under
`~/.config/daykeeper` (mode `0700`, file mode `0600`), creates a Free workspace
with one API inbox, waits for provisioning, activates the inbox, and prints the
identifiers with ready-to-paste SDK and MCP configuration. Run it again and it
resumes from wherever it stopped; it never creates a second workspace,
credential, or inbox.

`init` talks to the hosted Daykeeper at `https://api.mydaykeeper.com` unless
you pass `--origin` or set `DAYKEEPER_ORIGIN`. The
credential is redacted from output unless you pass `--reveal-key`, but
`<home>/mcp.json` always carries the literal credential so an MCP client can
read it. `init` refuses `--token-stdin` and `DAYKEEPER_ACCESS_TOKEN`, because it
mints its own credential and must not run under someone else's. Full flags,
state layout, resume behavior, and error codes are in
[COMMANDS.md](COMMANDS.md).

## Authenticate

`init` is the only command that stores a credential. Every other command takes
one you supply. Set `DAYKEEPER_API_URL` to your intended management API origin, including any
reverse-proxy prefix. There is no default production endpoint. Remote origins
must use HTTPS; `http://127.0.0.1` and `http://localhost` are supported for local
development. URLs with credentials, query strings, or fragments are rejected,
and requests never follow redirects.

Supply a scoped access token using one of these sources:

- `DAYKEEPER_ACCESS_TOKEN`, injected by your secret manager or CI environment.
- `--token-stdin`, with the token piped from a trusted credential provider.

Use exactly one source. Outside `init`, the CLI accepts no token argument,
stores no credential, and never opens an interactive sign-in prompt. Tokens must be 20–16,384 bearer
characters. It uses the supplied token for one request and does not attempt a
credential refresh after a `401`.

```sh
# DAYKEEPER_API_URL and DAYKEEPER_ACCESS_TOKEN are supplied by your environment.
node dist/cli.js capabilities
node dist/cli.js tenants list

# With DAYKEEPER_ACCESS_TOKEN unset, a credential provider can pipe the token.
credential-provider print-daykeeper-access-token | node dist/cli.js capabilities --token-stdin
```

The credential provider above represents your existing secret-management
command, not a bundled Daykeeper command. Tenant IDs select resources; they do
not grant access or change the token's organization. The API remains responsible
for verifying credentials, scopes, and tenant membership.

## Plan, inspect, then apply

```sh
node dist/cli.js tenants plan --input tenant.json > tenant-plan.json

# Inspect the returned changes, warnings, requiredScopes, version, and expiry.
jq '.data' tenant-plan.json

# Apply only when approved, using the exact plan and a durable key for this action.
node dist/cli.js tenants apply \
  --plan-id 33333333-3333-4333-8333-333333333333 \
  --plan-version 1 \
  --idempotency-key daykeeper-acme-tenant-create-0001
```

`tenants plan` and `email-channels plan` create expiring server-side plans but do
not create provider resources. Apply is a separate explicit command. The CLI
does not generate plan IDs, fetch replacement plans, change versions, generate
idempotency keys, or automatically repeat mutations.

Use `--input -` to read a JSON body from stdin. JSON must match the command's
strict schema and stay within 512 KiB. Unknown fields—including organization,
role, or policy overrides—are rejected. When using `--token-stdin`, JSON must
come from a regular file; one stdin stream cannot carry both token and body.

The command names, exact flags, scope requirements, flow examples, and output
schema are documented in [COMMANDS.md](COMMANDS.md). `--help` provides the
command catalog as JSON without making a request.

## Errors, cancellation, and safe retries

Every result is one JSON line on stdout; `--json` is accepted for compatibility
but JSON is already the default. There are no prompts or progress messages.
Exit status is `0` for success and `1` for a command error. The executable uses
`130` for SIGINT and `143` for SIGTERM after emitting a cancellation error.

Use `--timeout-ms` or `DAYKEEPER_TIMEOUT_MS` to set one 1–60 second budget for
input reading and the API request (default: 30 seconds). Cancellation aborts the
local request, not work already accepted by the server. An interrupted mutation
reports `mutationOutcome: "unknown"`; inspect the relevant resource or operation
before retrying. For plan/apply and flow mutations, reuse the original idempotency
key for the exact same logical action. Operation retries have no idempotency key
in SDK `0.2.0`; they are never replayed automatically.

API failures retain their bounded error code, status, retryability, safe field
names, next actions, and correlation ID. Raw remote messages, request bodies,
stack traces, file paths, and credential-provider errors are not emitted as
diagnostics. Auth and tenant denials do not trigger broader lookups. Normal
successful resource output can contain authorized customer information; handle
stdout as application data, not a public log. Supplied access tokens are
redacted if reflected in output.

## What is not implemented

- Hosted OAuth login, human signup, account ownership verification, or token
  refresh. `init` performs machine enrollment only; human claim of an
  agent-created workspace stays in the console.
- Membership or API-key administration, billing, usage, or entitlement changes.
- Automatic DNS changes, operation polling, background workers, or flow execution.
- Customer-session token issuance from the CLI; credentials are never minted to stdout.

Flow create/version/publish commands manage stored definitions only. Inspect
`capabilities` for the server's actual execution status. A successful publish
does not mean that a flow is executing against conversations.

## Validate

```sh
pnpm check
```

Checks cover all 16 single-call command mappings through the real published SDK,
the whole `init` step machine against loopback onboarding and management
fixtures with state in a temporary home, input and credential boundaries, denial/redaction behavior, deadlines and cancellation,
the compiled executable against a synthetic loopback API, and an unpacked npm
tarball with its pinned production dependencies installed offline using a
verification-only copy of this repository's frozen lockfile. That lockfile is
not shipped in the tarball. These checks do not certify a deployed server's
tenant isolation or production availability.
