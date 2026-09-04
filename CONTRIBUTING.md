# Contributing

Keep this CLI a consumer of released Daykeeper SDKs. Do not import private
service code, install from a Git branch or local file, or bypass the SDK with
unreviewed HTTP endpoints. Public API changes start in the versioned contract.

Add every command to the machine-readable catalog, COMMANDS.md, and the dispatch
matrix tests. Test missing/unknown options, strict JSON validation, credential
handling, redaction, server denials, and mutation retry behavior. A mutation must
remain an explicit command and must preserve the caller's concurrency and
idempotency identifiers.

Run `pnpm check` before requesting review. Tests use synthetic credentials and
loopback fixtures only. Do not use real tenant data or credentials as fixtures.
The checks are client contract evidence, not a substitute for server isolation
or deployed integration tests.
