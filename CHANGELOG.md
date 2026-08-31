# Changelog

## Unreleased

## 0.1.0 — unreleased foundation

- Add 16 explicit management commands using the published Daykeeper SDK `0.1.0`.
- Return versioned JSON envelopes and structured, redacted errors without prompts.
- Validate resource IDs, versions, idempotency keys, and bounded UTF-8 JSON input.
- Accept scoped access tokens from environment or stdin without credential storage.
- Bound input and requests by one deadline; propagate cancellation and report
  uncertain mutation outcomes without automatic retries.
- Add command/auth/tenant-denial tests, executable loopback smoke, and isolated
  packed-package checks. Keep publication blocked pending bootstrap approval.
