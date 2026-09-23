# Quickstart

The CLI prints exactly one JSON envelope on stdout and never prompts.

## Requirements

- Node.js 20 or newer.

## Starting from nothing

`init` is the one command that needs no credential. It enrolls a machine owner,
creates a Free workspace with one API inbox, and stores the credential locally:

```sh
npx @skyporch/daykeeper-cli init --name "Acme Support"
```

Rerun it to resume; it never creates a second workspace, credential, or inbox.
Its output includes the workspace and inbox IDs and the next steps. See
`COMMANDS.md` for the full `init` contract.

## One real invocation

Every other command uses the credential `init` stored, so nothing needs
exporting. List the tenants it can see:

```sh
npx @skyporch/daykeeper-cli tenants list
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

## Using a credential you already have

| Variable               | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `DAYKEEPER_API_KEY`    | Scoped credential. Overrides the stored one. `DAYKEEPER_ACCESS_TOKEN` is a deprecated alias.      |
| `DAYKEEPER_API_URL`    | Management API for a supplied credential. Default `https://api.mydaykeeper.com`.                  |
| `DAYKEEPER_HOME`       | Where `init` stored its state. Default `$XDG_CONFIG_HOME/daykeeper`, then `~/.config/daykeeper`.  |
| `DAYKEEPER_ORIGIN`     | The origin `init` used, when it was not the hosted one. The stored credential is only sent there. |
| `DAYKEEPER_TIMEOUT_MS` | Optional. Combined input and request deadline, 1000–60000 ms. Defaults to 30000.                  |

```sh
export DAYKEEPER_API_KEY="…"
daykeeper tenants list
```

To keep the token out of the environment, pipe it on stdin instead and leave
`DAYKEEPER_API_KEY` unset. Supplying both is an error:

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
mutations, and SDK `0.2.0` enforces it before a request is sent. Pass
`--idempotency-key` explicitly on `flows create`, `flows versions create`, and
`flows versions publish`; see `COMMANDS.md`.
