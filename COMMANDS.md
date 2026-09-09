# Daykeeper CLI command contract

Envelope version: `daykeeper.cli.v1`. CLI foundation: `0.1.0`. Runtime management
SDK: the published `@skyporch/daykeeper@0.2.0`.

## Commands

`init` is described in its own section below: it is the one command that makes
several SDK calls and the one command that persists state. Every other network
command requires an explicit API base URL and one scoped access token, and calls
exactly one SDK method. Scope names below are required by the API, not
permissions granted by a CLI option.

| Command                  | Required flags                                                               | Optional flags | API scope                      | Effect                                        |
| ------------------------ | ---------------------------------------------------------------------------- | -------------- | ------------------------------ | --------------------------------------------- |
| `capabilities`           | —                                                                            | —              | `daykeeper.accounts:read`      | Read server capabilities                      |
| `tenants list`           | —                                                                            | —              | `daykeeper.accounts:read`      | Read visible tenants                          |
| `tenants get`            | `--tenant-id`                                                                | —              | `daykeeper.accounts:read`      | Read one tenant                               |
| `tenants plan`           | `--input`                                                                    | —              | `daykeeper.accounts:write`     | Create an expiring plan                       |
| `tenants apply`          | `--plan-id`, `--plan-version`, `--idempotency-key`                           | —              | `daykeeper.provisioning:apply` | Apply the exact tenant plan                   |
| `email-channels get`     | `--tenant-id`                                                                | —              | `daykeeper.accounts:read`      | Read channel and DNS status                   |
| `email-channels plan`    | `--tenant-id`, `--input`                                                     | —              | `daykeeper.accounts:write`     | Create an expiring plan                       |
| `email-channels apply`   | `--plan-id`, `--plan-version`, `--idempotency-key`                           | —              | `daykeeper.provisioning:apply` | Apply the exact channel plan                  |
| `operations get`         | `--operation-id`                                                             | —              | `daykeeper.provisioning:read`  | Read operation state                          |
| `operations retry`       | `--operation-id`                                                             | —              | `daykeeper.provisioning:apply` | Request one retry explicitly                  |
| `flows list`             | —                                                                            | `--tenant-id`  | `daykeeper.flows:read`         | Read visible flows                            |
| `flows get`              | `--flow-id`                                                                  | —              | `daykeeper.flows:read`         | Read flow and latest version                  |
| `flows create`           | `--tenant-id`, `--input`, `--idempotency-key`                                | —              | `daykeeper.flows:write`        | Create a draft, not a publication             |
| `flows versions get`     | `--flow-id`, `--version`                                                     | —              | `daykeeper.flows:read`         | Read exact immutable revision                 |
| `flows versions create`  | `--flow-id`, `--input`, `--idempotency-key`                                  | —              | `daykeeper.flows:write`        | Create a revision with optimistic concurrency |
| `flows versions publish` | `--flow-id`, `--version`, `--expected-resource-version`, `--idempotency-key` | —              | `daykeeper.flows:publish`      | Publish an existing revision                  |

Identifiers must be UUIDs. Version flags must be positive safe integers.
Idempotency keys must contain 16–128 ASCII letters, digits, periods, underscores,
colons, or hyphens. Flags may appear before or after the command, but unknown,
duplicate, missing, or irrelevant options are errors. `--help` returns the full
catalog, or a single command's catalog when supplied with its command name.
`daykeeper --version` returns the CLI and SDK versions without authentication.

Global options are `--base-url`, `--timeout-ms`, `--token-stdin`, `--json`, and
`--help`. `DAYKEEPER_API_URL`, `DAYKEEPER_ACCESS_TOKEN`, and
`DAYKEEPER_TIMEOUT_MS` are the configuration environment variables every command
reads; `init` additionally reads `DAYKEEPER_ORIGIN`, `DAYKEEPER_ONBOARDING_URL`,
`DAYKEEPER_GATEWAY_URL`, `DAYKEEPER_HOME`, and `XDG_CONFIG_HOME`. Explicit flags
override their environment values. Apart from the files `init` writes under its
own home, there are no config files, saved profiles, token arguments, or
interactive prompts.

## `init`

`init` is the only command that persists state and the only command that makes
more than one SDK call. It enrolls a machine owner, stores the credential
locally, creates one Free workspace with an API inbox, waits for provisioning,
activates the inbox, and prints the identifiers with ready-to-paste SDK and MCP
configuration. Run it again and it resumes from wherever it stopped; it never
creates a second workspace, credential, or inbox.

```sh
daykeeper init --name "Acme Support" --plan free --json
```

| Flag                                              | Required | Meaning                                                                                                 |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `--name <text>`                                   | yes      | Workspace and inbox name, 2–120 characters after trimming.                                              |
| `--plan free`                                     | no       | Only `free` is accepted. The value is validated, never sent.                                            |
| `--origin <https url>`                            | no       | HTTPS origin serving onboarding and the management API. Env `DAYKEEPER_ORIGIN`.                         |
| `--onboarding-url`, `--base-url`, `--gateway-url` | no       | Per-service overrides. Env `DAYKEEPER_ONBOARDING_URL`, `DAYKEEPER_API_URL`, `DAYKEEPER_GATEWAY_URL`.    |
| `--slug <slug>`                                   | no       | Inbox slug. Default: the slugified name, truncated to 63, falling back to `inbox`.                      |
| `--locale <tag>`                                  | no       | Default `en`.                                                                                           |
| `--home <dir>`                                    | no       | Where state lives. Env `DAYKEEPER_HOME`, then `$XDG_CONFIG_HOME/daykeeper`, then `~/.config/daykeeper`. |
| `--wait-ms <n>`                                   | no       | Budget for provisioning polling and rate-limit sleeps, 10000–900000. Default 300000.                    |
| `--reveal-key`                                    | no       | Print the literal credential in the JSON output. Off by default.                                        |

`--timeout-ms` applies per request; `--wait-ms` bounds provisioning polling and
rate-limit sleeps only, not the run's total duration and not any single request.
`--token-stdin` and `DAYKEEPER_ACCESS_TOKEN` are rejected with
`INVALID_ARGUMENT`: `init` creates its own credential and must not run under
someone else's. Without `--origin` or `DAYKEEPER_ORIGIN`, `init` uses the hosted
`https://api.mydaykeeper.com` for the API and machine onboarding and
`https://gateway.mydaykeeper.com` for the customer gateway. A custom origin
pairs with itself as the gateway unless `--gateway-url` is given.

### State

`<home>/credentials.json`, directory mode `0700`, file mode `0600`, written
through a temporary file and a rename. A state file that any other account can
read is refused with `STATE_INSECURE` rather than used. The file holds the
machine owner private key, the enrollment intent and its idempotency key, the
workspace and credential identifiers, the reveal-once credential, and the
inbox's slug attempt counter, recorded plan, apply key, operation id,
provisioning timestamp, and activation intent. The private key is never
transmitted and cannot be recovered if the file is lost, which the file's own
`warning` field states.

A home directory `init` creates is set to `0700`. A `--home` that already exists
is inspected, never re-permissioned: any group or world bit fails with
`STATE_INSECURE`. The state file is opened with `O_NOFOLLOW` where the platform
provides it, so a symlinked path is refused, and a state file whose directory
another account can write to is refused as well.

The state file also records the origins its credential was minted against. If a
later run resolves a different `--origin`, `--onboarding-url`, `--base-url`, or
`--gateway-url`, it fails with `STATE_ORIGIN_MISMATCH` before any request is
sent, so a stored credential is never offered to a host that did not issue it.
The error names the differing flags and the two hostnames, never the configured
URLs, and it is not resumable: use a separate `--home` per origin.

`<home>/mcp.json` is written at mode `0600` and is the one place besides the
state file that carries the literal credential, because MCP clients read
configuration files rather than stdin.

### Steps and resume

Each step persists its result before the next request is sent. `steps` lists
what ran in this invocation, and `resumed` is true when any step was skipped
because the state file already had its result:

`owner_key`, `enroll`, `recover`, `inbox_adopt`, `inbox_apply`, `inbox_wait`,
`inbox_activate`.

Mutations are sent exactly once per stored intent. A rerun reuses the stored
enrollment idempotency key, tenant apply key, rotation intent, and activation
intent verbatim, so the server replays the stored result instead of applying a
second change. A replayed enrollment never re-reveals its credential, so a run
that finds a claimed workspace with no stored token rotates instead; a
credential inside its last 24 hours rotates the same way. A slug conflict from
the plan call appends `-2`, `-3`, and the attempt counter is stored so a crash
mid-conflict resumes at the next unused suffix; the accepted plan is stored
before the apply is sent, so an apply that fails propagates and the rerun
replays the same key against the same plan instead of creating a second one. A
`TENANT_QUOTA_EXCEEDED` is surfaced and never retried.

Provisioning is polled every 3 seconds inside `--wait-ms`, and a `429` is
honored for its `Retry-After` without ever exceeding that budget. A `429` on a
challenge-bound mutation is never resent with the same proof: the run waits, then
requests a new challenge and signs again, and refuses with a resumable
`RATE_LIMITED` when the delay would outlast the remaining budget. Management-API
`429`s use a fixed 3-second delay and are retried at most twice, because the
published SDK does not project `Retry-After` on `DaykeeperApiError`; once it
does, that delay follows the header like the onboarding ones.

### Output

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
    "state": "prepared",
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
        "args": ["--yes", "@skyporch/daykeeper-mcp@0.2.0"],
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

The credential is redacted from output unless `--reveal-key` is supplied, and
the machine owner private key is redacted unconditionally. `mcp.json` on disk
carries the literal credential either way. With `--reveal-key`, both
`DAYKEEPER_API_KEY` values above are the literal credential.

### Errors

`init` adds `ORIGIN_REQUIRED`, `STATE_UNREADABLE`, `STATE_INSECURE`,
`STATE_ORIGIN_MISMATCH`, `RATE_LIMITED`, `PROVISIONING_FAILED`,
`PROVISIONING_TIMEOUT`, `ACTIVATION_UNAVAILABLE`, and
`CREDENTIAL_UNRECOVERABLE`. Every error reports the step it reached in `fields`
and carries `nextActions: ["run_init_again"]` whenever a rerun can resume.
`PROVISIONING_FAILED` also carries the `operationId` and next action
`operations_retry`; `init` never retries an operation on its own.

## JSON input

Use `--input path.json` or `--input -`. Input is one UTF-8 JSON value, at most
512 KiB. Schema objects reject additional properties. The CLI does not silently
strip unknown fields or add authority, policies, or secrets.

Tenant plan:

```json
{
  "name": "Acme Support",
  "slug": "acme-support",
  "locale": "en-US",
  "administrator": {
    "name": "Support Lead",
    "email": "support-lead@example.com"
  }
}
```

Optional tenant fields are `region` and `supportEmail`. Name limits are 2–120
characters; locale/region limits are 2–35. Slugs are 1–63 lowercase letters,
digits, and internal hyphens, starting and ending with a letter or digit.

Email-channel plan:

```json
{ "address": "support@example.com", "region": "us-east-1" }
```

`region` is optional and accepts `us-east-1`, `eu-west-1`, `sa-east-1`, or
`ap-northeast-1`. Email addresses are limited to 254 characters.

Flow creation:

```json
{
  "name": "Acme support routing",
  "slug": "acme-support-routing",
  "definition": {
    "schemaVersion": "2026-08-01",
    "trigger": { "event": "message.received", "channel": "email" },
    "conditions": [],
    "actions": [{ "id": "handoff", "type": "handoff", "target": "human" }]
  }
}
```

An optional `description` is limited to 500 characters. Triggers are
`conversation.created` or `message.received`, currently on the `email` channel.
Definitions allow up to 20 conditions and 1–25 actions with unique IDs. Condition
fields are `contact.email_domain`, `conversation.tag`, and `message.text`;
operators are `equals`, `contains`, and `ends_with`; values are 1–500 characters.
Actions are `reply` (text up to 4,000 characters), `tag` (tag up to 64 characters),
`handoff` (`human`, `agent`, or `hybrid`), and `set_priority` (`low`, `medium`,
`high`, or `urgent`). Each action ID is 1–64 characters. Arbitrary code and
additional action properties are rejected.

Flow revision creation:

```json
{
  "expectedLatestVersion": 1,
  "definition": {
    "schemaVersion": "2026-08-01",
    "trigger": { "event": "message.received", "channel": "email" },
    "conditions": [],
    "actions": [{ "id": "handoff", "type": "handoff", "target": "human" }]
  }
}
```

`flows versions publish` accepts the existing revision through `--version` and
the flow's current optimistic concurrency value through
`--expected-resource-version`. It does not create or repair a missing revision.

## Output and errors

Success (the `data` member is the actual SDK result):

```json
{
  "schemaVersion": "daykeeper.cli.v1",
  "ok": true,
  "command": "tenants list",
  "data": []
}
```

Failure:

```json
{
  "schemaVersion": "daykeeper.cli.v1",
  "ok": false,
  "command": "tenants get",
  "error": {
    "kind": "api",
    "code": "NOT_FOUND",
    "message": "The request is not authorized or the resource is unavailable.",
    "retryable": false,
    "status": 404,
    "fields": [],
    "nextActions": []
  }
}
```

`command` is `null` if argument parsing fails before a valid command is selected.
Error `kind` is `cli`, `api`, or `transport`. A safe `correlationId` may be included.
`mutationOutcome: "unknown"` is included when a mutating request was sent and
its result was lost to transport failure, timeout, cancellation, or a server-side
`5xx` response. It is not a claim that the server rejected or rolled back the
work, and does not establish that a mutation is safe to repeat.

`retryable` describes the reported failure, not permission to repeat a mutation.
No command other than `init` retries automatically, including on `401`, `429`, or
`5xx`. The published management SDK does not expose `Retry-After` through its
error object; this CLI does not invent a retry delay outside `init`. Use plan/apply idempotency or inspect resource
state before explicitly trying again. For automation, rely on `code`, `status`,
and `nextActions`, not human-readable message text.
