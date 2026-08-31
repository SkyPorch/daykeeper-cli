# Daykeeper CLI command contract

Envelope version: `daykeeper.cli.v1`. CLI foundation: `0.1.0`. Runtime management
SDK: the published `@skyporch/daykeeper@0.1.0`.

## Commands

Every network command requires an explicit API base URL and one scoped access
token. Each invocation calls exactly one SDK method. Scope names below are
required by the API, not permissions granted by a CLI option.

| Command                  | Required flags                                          | Optional flags | API scope                      | Effect                                        |
| ------------------------ | ------------------------------------------------------- | -------------- | ------------------------------ | --------------------------------------------- |
| `capabilities`           | —                                                       | —              | `daykeeper.accounts:read`      | Read server capabilities                      |
| `tenants list`           | —                                                       | —              | `daykeeper.accounts:read`      | Read visible tenants                          |
| `tenants get`            | `--tenant-id`                                           | —              | `daykeeper.accounts:read`      | Read one tenant                               |
| `tenants plan`           | `--input`                                               | —              | `daykeeper.accounts:write`     | Create an expiring plan                       |
| `tenants apply`          | `--plan-id`, `--plan-version`, `--idempotency-key`      | —              | `daykeeper.provisioning:apply` | Apply the exact tenant plan                   |
| `email-channels get`     | `--tenant-id`                                           | —              | `daykeeper.accounts:read`      | Read channel and DNS status                   |
| `email-channels plan`    | `--tenant-id`, `--input`                                | —              | `daykeeper.accounts:write`     | Create an expiring plan                       |
| `email-channels apply`   | `--plan-id`, `--plan-version`, `--idempotency-key`      | —              | `daykeeper.provisioning:apply` | Apply the exact channel plan                  |
| `operations get`         | `--operation-id`                                        | —              | `daykeeper.provisioning:read`  | Read operation state                          |
| `operations retry`       | `--operation-id`                                        | —              | `daykeeper.provisioning:apply` | Request one retry explicitly                  |
| `flows list`             | —                                                       | `--tenant-id`  | `daykeeper.flows:read`         | Read visible flows                            |
| `flows get`              | `--flow-id`                                             | —              | `daykeeper.flows:read`         | Read flow and latest version                  |
| `flows create`           | `--tenant-id`, `--input`                                | —              | `daykeeper.flows:write`        | Create a draft, not a publication             |
| `flows versions get`     | `--flow-id`, `--version`                                | —              | `daykeeper.flows:read`         | Read exact immutable revision                 |
| `flows versions create`  | `--flow-id`, `--input`                                  | —              | `daykeeper.flows:write`        | Create a revision with optimistic concurrency |
| `flows versions publish` | `--flow-id`, `--version`, `--expected-resource-version` | —              | `daykeeper.flows:publish`      | Publish an existing revision                  |

Identifiers must be UUIDs. Version flags must be positive safe integers.
Idempotency keys must contain 16–128 ASCII letters, digits, periods, underscores,
colons, or hyphens. Flags may appear before or after the command, but unknown,
duplicate, missing, or irrelevant options are errors. `--help` returns the full
catalog, or a single command's catalog when supplied with its command name.
`daykeeper --version` returns the CLI and SDK versions without authentication.

Global options are `--base-url`, `--timeout-ms`, `--token-stdin`, `--json`, and
`--help`. `DAYKEEPER_API_URL`, `DAYKEEPER_ACCESS_TOKEN`, and
`DAYKEEPER_TIMEOUT_MS` are the only configuration environment variables read by
the CLI. Explicit base URL and timeout flags override their environment values.
There are no config files, saved profiles, token arguments, or interactive prompts.

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
No command retries automatically, including on `401`, `429`, or `5xx`. The
published SDK does not expose `Retry-After` through its error object; this CLI
does not invent a retry delay. Use plan/apply idempotency or inspect resource
state before explicitly trying again. For automation, rely on `code`, `status`,
and `nextActions`, not human-readable message text.
