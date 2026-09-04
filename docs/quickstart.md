# Quickstart

The CLI prints exactly one JSON envelope on stdout and never prompts.

## Requirements

- Node.js 20 or newer.
- A scoped Daykeeper access token.

## Configuration

Two environment variables:

| Variable                 | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `DAYKEEPER_API_URL`      | Base URL of the Daykeeper management API. Required unless you pass `--base-url`. |
| `DAYKEEPER_ACCESS_TOKEN` | Scoped access token. Required unless you pass `--token-stdin`.                   |
| `DAYKEEPER_TIMEOUT_MS`   | Optional. Combined input and request deadline, 1000–60000 ms. Defaults to 30000. |

Set exactly one token source. Supplying both `DAYKEEPER_ACCESS_TOKEN` and
`--token-stdin` is an error.

## One real invocation

List the tenants the token can see:

```sh
export DAYKEEPER_API_URL="https://api.example.invalid"
export DAYKEEPER_ACCESS_TOKEN="…"

daykeeper tenants list
```

Successful output is a single envelope:

```json
{
  "schemaVersion": "daykeeper.cli.v1",
  "ok": true,
  "command": "tenants list",
  "data": {}
}
```

## Keeping the token out of the environment

Pipe it on stdin instead, and leave `DAYKEEPER_ACCESS_TOKEN` unset:

```sh
printf '%s' "$(cat token.txt)" | daykeeper tenants list --token-stdin
```

## Discovering commands

```sh
daykeeper --help
```

`--help` returns the command catalogue in the same JSON envelope, so it can be
parsed rather than read.

## Errors

Failures are envelopes too, with `ok: false` and a stable machine-readable
error code. Token-shaped values are redacted before anything is written. A
mutation whose outcome is unknown is reported as uncertain and is never retried
automatically.

## Flow mutations

Management contract `0.2.0` requires an `Idempotency-Key` header on flow
mutations. Pass the key explicitly on `flows create`, `flows versions create`,
and `flows versions publish`; see `COMMANDS.md`.
