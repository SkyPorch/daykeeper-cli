# Daykeeper CLI

A command line for people, agents, and CI jobs managing Daykeeper. It calls the
`@skyporch/daykeeper@0.3.0` SDK and returns one versioned JSON envelope
per invocation. The code is Apache-2.0; see [LICENSE](LICENSE) and
[RELEASING.md](RELEASING.md).

## Get a support inbox with one command

```sh
npx @skyporch/daykeeper-cli init --name "Acme Support"
```

That's it. No sign-up, card, website, or DNS. `init` enrolls a machine owner,
creates a Free workspace with one API inbox, waits for it to be ready, turns it
on, and stores the credential under `~/.config/daykeeper` (directory mode
`0700`, file mode `0600`). It prints the workspace and inbox IDs, the next steps,
and ready-to-paste SDK and MCP configuration. Run it again and it picks up where
it stopped; it never creates a second workspace, credential, or inbox.

Run in a terminal, `init` prints readable text. Add `--json`, or capture stdout
from an agent or script, for the JSON envelope.

Every other command then uses the stored credential, with nothing to export:

```sh
npx @skyporch/daykeeper-cli tenants list
```

Hand the workspace to a person:

```sh
npx @skyporch/daykeeper-cli claim --email you@company.com
```

`claim` issues an owner invitation for that address and prints the link that
accepts it. Send the link to that person; they sign in at
https://app.mydaykeeper.com and own the workspace. The link carries its token in
the URL fragment and is printed unredacted, once, because it is the handoff —
treat it like a password reset link. It is never written to the state file.
Rerunning returns the pending claim without a link; `--reissue` revokes it and
issues a new one, and `claim status` lists what the server holds.

Install it globally to type `daykeeper` instead of `npx @skyporch/daykeeper-cli`:

```sh
npm install --global @skyporch/daykeeper-cli
daykeeper tenants list
```

The credential is redacted from output unless you pass `--reveal-key`, but
`<home>/mcp.json` always carries the literal credential so an MCP client can
read it. Full flags, state layout, resume behavior, and error codes are in
[COMMANDS.md](COMMANDS.md).

## Authenticate

Each command uses the first credential it finds:

1. `--token-stdin`, with the token piped from a trusted credential provider.
2. `DAYKEEPER_API_KEY`, injected by your secret manager or CI environment.
   `DAYKEEPER_ACCESS_TOKEN` still works as a deprecated alias.
3. The credential `init` stored in `<home>/credentials.json`.

Set at most one of the first two. A supplied credential goes to `--base-url`,
then `DAYKEEPER_API_URL`, then `https://api.mydaykeeper.com`. Include any
reverse-proxy prefix in the URL. Remote origins must use HTTPS;
`http://127.0.0.1` and `http://localhost` are supported for local development.
URLs with credentials, query strings, or fragments are rejected, and requests
never follow redirects.

The stored credential is only ever sent to the origin that issued it. If you ran
`init` with `--origin` or `DAYKEEPER_ORIGIN`, set the same origin for later
commands; a different one fails with `STATE_ORIGIN_MISMATCH` before any request.
Use `--home` or `DAYKEEPER_HOME` to point at a state file outside the default
location. A stored credential near expiry is rotated before it is used.

`init` and `claim` always run under the stored credential. They refuse
`--token-stdin`, and a supplied `DAYKEEPER_API_KEY` that is not the stored one.

```sh
# DAYKEEPER_API_KEY is supplied by your environment.
daykeeper capabilities

# A credential provider can pipe the token instead.
credential-provider print-daykeeper-api-key | daykeeper capabilities --token-stdin
```

The credential provider above represents your existing secret-management
command, not a bundled Daykeeper command. Tenant IDs select resources; they do
not grant access or change the token's organization. The API remains responsible
for verifying credentials, scopes, and tenant membership. Tokens must be
20–16,384 bearer characters. The CLI accepts no token argument and never opens
an interactive sign-in prompt.

## Run from this repository

Use Node.js 20 or newer and pnpm 10.8.0:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

`pnpm daykeeper --help` runs the same CLI from source.

## Plan, inspect, then apply

```sh
daykeeper tenants plan --input tenant.json > tenant-plan.json

# Inspect the returned changes, warnings, requiredScopes, version, and expiry.
jq '.data' tenant-plan.json

# Apply only when approved, using the exact plan and a durable key for this action.
daykeeper tenants apply \
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

Every result is one JSON line on stdout. The one exception is `init` run in a
terminal without `--json`, which prints readable text. There are no prompts or
progress messages.
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
  refresh. `init` performs machine enrollment only, and `claim` only issues the
  invitation: accepting it, and every sign-in it needs, stays in the console.
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

Checks cover all 16 single-call command mappings through the real SDK, the whole
`init` step machine and both `claim` forms against loopback onboarding and
management fixtures with state in a temporary home, input and credential boundaries, denial/redaction behavior, deadlines and cancellation,
the compiled executable against a synthetic loopback API, and an unpacked npm
tarball with its pinned production dependencies installed offline using a
verification-only copy of this repository's frozen lockfile. That lockfile is
not shipped in the tarball. These checks do not certify a deployed server's
tenant isolation or production availability.
