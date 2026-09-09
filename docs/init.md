# `daykeeper init`

Status: specification, 2026-09-09. Implements the agent-first onboarding
direction: one command gives an AI agent a working support inbox with no human
login, credit card, website, or DNS. Human signup stays in the console.

## Outcome

```sh
npx @skyporch/daykeeper-cli init --name "Acme Support" --plan free --json
```

Run once, the command enrolls a machine owner, stores the credential locally,
creates a Free workspace with one API inbox, waits for provisioning, activates
the inbox, and prints the inbox identifiers plus ready-to-paste SDK and MCP
configuration. Run again, it resumes from wherever it stopped and never creates
a second workspace, credential, or inbox. It finishes in about a minute.

Reference experiences: Atomic Mail (a registration command leads the page and
is immediately followed by usage), Neon Claimable (provision first, claim
later), Resend (predictable commands, structured output).

## Contract

`init` is the only command that persists state. Every other command stays
stateless as documented in `COMMANDS.md`; that rule is revised, not removed.

| Flag                                              | Required | Meaning                                                                                                                                                 |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <text>`                                   | yes      | Workspace and inbox name, 2 to 120 characters after trimming.                                                                                           |
| `--plan free`                                     | no       | Only `free` is accepted today. Anything else is `INVALID_ARGUMENT`. The value is validated, never sent: enrollment always creates the Free entitlement. |
| `--origin <https url>`                            | no       | Canonical HTTPS origin that serves both onboarding and the management API. Default: `DAYKEEPER_ORIGIN`, then the built-in hosted origin.                |
| `--onboarding-url`, `--base-url`, `--gateway-url` | no       | Per-service overrides. Env: `DAYKEEPER_ONBOARDING_URL`, `DAYKEEPER_API_URL`, `DAYKEEPER_GATEWAY_URL`.                                                   |
| `--slug <slug>`                                   | no       | Inbox slug. Default: slugified `--name`, truncated to 63, fallback `inbox`.                                                                             |
| `--locale <tag>`                                  | no       | Default `en`.                                                                                                                                           |
| `--home <dir>`                                    | no       | Where state lives. Default: `DAYKEEPER_HOME`, then `$XDG_CONFIG_HOME/daykeeper`, then `~/.config/daykeeper`.                                            |
| `--wait-ms <n>`                                   | no       | Budget for provisioning polling and rate-limit sleeps, 10000 to 900000. Default 300000. It does not bound request time; `--timeout-ms` does.            |
| `--reveal-key`                                    | no       | Include the literal server key in the JSON output. Off by default; see Secrets.                                                                         |
| `--json`                                          | no       | Accepted for symmetry with the documented command. Output is always JSON.                                                                               |

Global `--timeout-ms` applies per request. `--token-stdin` and
`DAYKEEPER_ACCESS_TOKEN` are rejected with `INVALID_ARGUMENT`: `init` creates
its own credential and must not be run under someone else's.

The built-in hosted origins are two constants in `src/constants.ts`:
`https://api.mydaykeeper.com` serves the management API and machine onboarding,
and `https://gateway.mydaykeeper.com` serves customer SDK traffic. A custom
`--origin` pairs with itself as the gateway unless `--gateway-url` is given.
`ORIGIN_REQUIRED` remains only as a defensive error for a build with the
constants blanked.

## The flow

Each step persists its result before the next request is sent, so a crash at
any point leaves a state file the next run can resume from.

1. **Preflight.** `GET /v1/capabilities` with no credential is not available,
   so preflight is the origin check only: HTTPS, no path, no credentials, no
   query. `http://localhost` and `http://127.0.0.1` are the only plaintext
   exceptions, for development. A stored credential is then pinned to the
   origins that issued it: if the state file's `origin`, `onboardingUrl`,
   `apiUrl`, or `gatewayUrl` differs from the resolved one, the run fails with
   `STATE_ORIGIN_MISMATCH` before a single request is sent, so a stored token is
   never offered to a host that did not issue it. The error names the differing
   flags and reports the two hostnames; it never echoes a configured URL. It is
   not resumable: use a separate `--home` per origin, or remove the state file.
2. **Owner key.** If the state file has no private key, generate a P-256 key
   with `DaykeeperMachineSigner.generate()`, export the private JWK, and write
   it. The key is never regenerated. Losing it is unrecoverable by design, so
   the state file says so in a `warning` field.
3. **Enroll.** If there is no credential, build the intent
   `{ name, idempotencyKey, publicKey }`. The idempotency key is generated once
   and stored with the intent; a rerun reuses it verbatim. Request a challenge,
   sign it with audience `<onboardingUrl>/v1/machine-enrollments`, and create
   the enrollment. Store `ownerId`, `organizationId`, `organizationSlug`,
   credential `id` and `expiresAt`, and the token. A replay returns
   `token: null`; if the state file has no token either, go to Recover.
4. **Recover.** A known owner with no usable token rotates: build a rotation
   intent `{ ownerId, expectedCredentialId, intentId }` with a fresh stored
   `intentId`, challenge, sign with audience
   `<onboardingUrl>/v1/machine-credential-rotations`, create. If
   `expectedCredentialId` is unknown or stale, call `credentialRotations.current`
   with a fresh proof first. Store the new credential and token. A credential
   that expires within 24 hours is rotated the same way before use; credentials
   last seven days.
5. **Find or create the inbox.** `tenants.list()`. If a tenant exists, adopt it
   and store its id; the Free plan allows exactly one. Otherwise
   `tenants.plan({ name, slug, locale, inbox: { type: "api" } })` and
   `tenants.apply({ planId, planVersion }, { idempotencyKey })` with a stored
   apply key. Only the plan call may answer `RESOURCE_CONFLICT` with a taken
   slug, and only it appends `-2`, `-3`; the attempt counter is stored, so a
   conflict followed by a crash resumes at the next unused suffix instead of
   resending a slug the server already refused. The accepted plan id and
   version are stored before the apply is sent: a failed apply propagates with
   its idempotency key intact, and the rerun replays that same key against that
   same plan rather than minting a second plan under a new slug. A
   `TENANT_QUOTA_EXCEEDED` means a tenant exists that the list did not show;
   surface it, do not retry.
6. **Wait.** Poll `tenants.getProvisioningOperation(tenantId)` every 3 seconds
   until `succeeded`, within `--wait-ms`. `failed` or `cancelled` ends the run
   with `PROVISIONING_FAILED`, the operation id, and next action
   `operations retry`. `init` never retries an operation on its own.
7. **Activate.** `inboxes.get(tenantId)`. If `trafficEnabled` is already true,
   skip. Otherwise `inboxActivations.create(tenantId, { idempotencyKey })` with
   a stored activation intent, then read the inbox again and require
   `trafficEnabled: true`. `FEATURE_UNAVAILABLE` ends the run with
   `ACTIVATION_UNAVAILABLE` and the state saved, so a rerun picks up here.
8. **Write config and print.** Write `<home>/mcp.json` containing the literal
   MCP block, mode 0600, and print the result below.

Every request honors `Retry-After` on 429 and never exceeds the wait budget. A
429 on a challenge-bound mutation — enrollment create, rotation create, and the
rotation `current` probe — is not resent with the same proof, because that proof
is single-use and expires in a minute: the run waits out the delay, then asks
for a new challenge and signs again. A delay that would outlast the remaining
budget fails with `RATE_LIMITED`, which is resumable. Management-API 429s carry
no projected `Retry-After` through the SDK, so they use a fixed three-second
delay and are retried at most twice.

Mutations are sent exactly once per stored intent. An `outcomeUnknown` error
is reported as `mutationOutcome: "unknown"` and the state file keeps the intent,
so the rerun replays it instead of minting a second one.

## State file

`<home>/credentials.json`, directory mode 0700, file mode 0600, written with a
temporary file and rename. Refuse to read a file whose mode allows group or
world access.

A home directory this command creates is set to 0700. A `--home` that already
exists is inspected instead: any group or world bit fails with `STATE_INSECURE`
rather than being silently re-permissioned, because the caller may have set that
mode deliberately and a credential must not be written into it. The state file
is opened with `O_NOFOLLOW` where the platform has it, so a symlinked path is
refused rather than followed, and a state file whose directory is writable by
another account is refused as well: that account could replace the file whole,
which the file's own 0600 mode would not reveal.

```json
{
  "version": 1,
  "origin": "https://…",
  "onboardingUrl": "https://…",
  "apiUrl": "https://…",
  "gatewayUrl": "https://…",
  "owner": { "privateJwk": { "kty": "EC", "crv": "P-256", "…": "…" } },
  "enrollment": { "name": "Acme Support", "idempotencyKey": "…" },
  "workspace": {
    "ownerId": "…",
    "organizationId": "…",
    "organizationSlug": "…"
  },
  "credential": {
    "id": "…",
    "expiresAt": "…",
    "token": "dk_machine_…",
    "rotationIntentId": null
  },
  "inbox": {
    "tenantId": "…",
    "slug": "acme-support",
    "slugAttempt": 0,
    "planId": "…",
    "planVersion": 1,
    "applyIdempotencyKey": "…",
    "operationId": "…",
    "activationIntent": "…"
  },
  "updatedAt": "…"
}
```

The private key and token never appear in logs, errors, or output unless
`--reveal-key` is set, and then only the token.

## Output

Success envelope, `data` shape:

```json
{
  "workspace": {
    "organizationId": "…",
    "slug": "…",
    "name": "Acme Support",
    "plan": "free"
  },
  "inbox": {
    "tenantId": "…",
    "slug": "acme-support",
    "name": "Acme Support",
    "state": "ready",
    "trafficEnabled": true
  },
  "credential": {
    "id": "…",
    "expiresAt": "…",
    "storedAt": "/home/agent/.config/daykeeper/credentials.json"
  },
  "endpoints": { "apiUrl": "https://…", "gatewayUrl": "https://…" },
  "sdk": {
    "packages": {
      "backend": "@skyporch/daykeeper@0.2.0",
      "reactNative": "@skyporch/daykeeper-react-native@0.1.0"
    },
    "env": {
      "DAYKEEPER_API_URL": "https://…",
      "DAYKEEPER_API_KEY": "<stored; rerun with --reveal-key>"
    }
  },
  "mcp": {
    "configPath": "/home/agent/.config/daykeeper/mcp.json",
    "mcpServers": {
      "daykeeper": {
        "command": "npx",
        "args": ["--yes", "@skyporch/daykeeper-mcp"],
        "env": {
          "DAYKEEPER_API_URL": "https://…",
          "DAYKEEPER_API_KEY": "<stored; see configPath>",
          "DAYKEEPER_MCP_ENABLE_PLANNING": "true",
          "DAYKEEPER_MCP_ENABLE_MUTATIONS": "true",
          "DAYKEEPER_MCP_ENABLE_INBOX_TOOLS": "true",
          "DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS": "true",
          "DAYKEEPER_MCP_ENABLE_OPERATOR_TOOLS": "true"
        }
      }
    }
  },
  "resumed": false,
  "steps": [
    "owner_key",
    "enroll",
    "inbox_apply",
    "inbox_wait",
    "inbox_activate"
  ]
}
```

With `--reveal-key`, both `DAYKEEPER_API_KEY` values are the literal token.
Without it, `mcp.json` on disk still carries the literal token so an agent can
point its MCP client at the file. `resumed` is true when any step was skipped
because the state file already had its result. `steps` lists what ran.

Errors use the standard envelope. New CLI codes: `ORIGIN_REQUIRED`,
`STATE_UNREADABLE`, `STATE_INSECURE`, `STATE_ORIGIN_MISMATCH`, `RATE_LIMITED`,
`PROVISIONING_FAILED`, `PROVISIONING_TIMEOUT`, `ACTIVATION_UNAVAILABLE`,
`CREDENTIAL_UNRECOVERABLE`.
Every error carries `nextActions: ["run_init_again"]` when a rerun can resume,
and the step reached in `fields`.

## Secrets

- The token is a `dk_machine_` bearer with seven-day expiry and fixed scopes.
  It belongs on a server or in an agent's secret store, never in a mobile or
  browser bundle, never in source control.
- Output redaction stays on: the token and private key are added to the
  redaction list before anything is printed.
- `mcp.json` is the one place the literal token is written besides the state
  file, because MCP clients read config files, not stdin.

## Compatibility

- Bump the SDK pin to the published `@skyporch/daykeeper@0.2.0`. It ships
  `DaykeeperOnboardingClient`, `DaykeeperMachineSigner`, `inboxes.get`,
  `inboxActivations`, `tenants.getProvisioningOperation`, `customerSessions`,
  and `entitlements`. Record it in `COMPATIBILITY.md`.
- The MCP block targets the published `@skyporch/daykeeper-mcp@0.2.0`.
- Server behavior relied on: enrollment replay never re-reveals a token;
  `FREE_WORKSPACE_ALREADY_CLAIMED` on a second enrollment with the same key;
  one tenant per Free workspace; activation returns `FEATURE_UNAVAILABLE` when
  the service is not wired; rate limits answer 429 with `Retry-After`.

## Tests

Loopback fixtures only, synthetic keys and tokens, state in a temporary
`--home`. Cover: fresh run end to end; rerun is a no-op that reports
`resumed: true` and sends no mutation; crash after enrollment resumes without
a second enrollment; enrollment replay with a lost token rotates; expiring
credential rotates; slug conflict suffixes; provisioning failed, cancelled, and
timeout; activation unavailable; 429 with `Retry-After`; `outcomeUnknown` on
apply keeps the intent; token and private key never appear in output without
`--reveal-key`; `--plan pro` rejected; `--token-stdin` rejected; insecure state
file mode rejected; the hosted API and gateway origins are used when none is configured; a stored
credential refused for a second origin before any request; an apply conflict
that neither suffixes the slug nor re-plans on the rerun; a slug conflict
followed by a crash resuming at the next suffix; a credential echoed back by the
server redacted from the moment it was issued; a 429 on enrollment and rotation
create re-challenging; a rate limit past the budget refused; a management 429
capped at two retries; a pre-existing wide `--home` and a symlinked state file
both refused.

## Out of scope

Human claim of an agent-created workspace, the agent page on the website,
publishing the CLI, paid plans, website and email inboxes, and customer-session
minting from the CLI. Each is a separate change.
