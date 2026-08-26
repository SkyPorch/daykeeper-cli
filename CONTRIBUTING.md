# Contributing

Commands wrap `@skyporch/daykeeper`; they do not make independent HTTP calls.
Keep stdout as one machine-readable success object and stderr as one bounded
error object. Never accept tokens in argv, print stack traces by default, or log
request bodies.

Run `pnpm check` before requesting review. Add tests for exit codes, invalid
input, idempotency, timeouts, and every new command.
