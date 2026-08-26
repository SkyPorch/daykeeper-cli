# `@skyporch/daykeeper-cli`

The official machine-readable command line for Daykeeper. It wraps
`@skyporch/daykeeper` without adding a second API contract and is designed to be
safe to call from agents, CI jobs, and human-operated shells.

## Install

```sh
npm install --global @skyporch/daykeeper-cli
```

## Configure

```sh
export DAYKEEPER_API_URL=https://api.daykeeper.example
export DAYKEEPER_ACCESS_TOKEN=replace-with-a-scoped-token
```

Tokens are deliberately not accepted as command-line flags because argv can be
visible in shell history and process listings. Prefer a short-lived, narrowly
scoped credential. The later service OAuth release will make those credentials
self-serve for agents.

## Use

```sh
daykeeper capabilities
daykeeper tenants plan --input tenant.json
daykeeper tenants apply \
  --input apply.json \
  --idempotency-key agent-run-019b6d2f
daykeeper operations wait --id OPERATION_ID
```

Use `--input -` to read JSON from stdin. Input is limited to 256 KiB. Every
success writes one `{ "data": ... }` JSON object to stdout; every failure writes
one `{ "error": ... }` JSON object to stderr without a stack trace or token.

Exit codes are stable:

- `0`: command succeeded
- `1`: API, transport, or unexpected failure
- `2`: invalid command, configuration, flag, or input
- `3`: operation wait timed out; the operation may still be running

Run `daykeeper --help` for all tenant, email-channel, operation, and versioned
flow commands.

## Release status

Version `0.1.0` is built and tested against the exact
`@skyporch/daykeeper@0.1.0` SDK. Publication is intentionally blocked until
SkyPorch chooses package license terms, bootstraps both npm packages, and binds
the protected release workflow as its trusted publisher. See
[`RELEASING.md`](RELEASING.md).
