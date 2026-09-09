# Changelog

## Unreleased

### Breaking

- Pin the published `@skyporch/daykeeper` SDK `0.2.0` in place of `0.1.0`. That
  SDK makes `idempotencyKey` mandatory on `flows.create`, `flows.createVersion`,
  and `flows.publishVersion`, so `--idempotency-key` is now a required flag on
  `flows create`, `flows versions create`, and `flows versions publish`. The CLI
  still never generates a key for the caller. Every other command is unchanged.

## 0.1.0 — unreleased foundation

The CLI stays at `0.1.0` and `private: true`. Nothing has been published for
this package. This section records the management contract it is built against.

### Breaking

These are breaking changes in the Daykeeper **management** contract `0.2.0`
(`openapi/daykeeper.yaml`), which this CLI targets. They are listed here because
`0.1.0` is the first version to depend on that contract, so any consumer moving
onto it inherits the break:

- Flow mutations now require an `Idempotency-Key` request header. The header is
  no longer optional; a flow mutation sent without it is rejected by the
  gateway. This affects `flows create`, `flows versions create`, and
  `flows versions publish`.
- A replayed flow mutation now returns `200` alongside the existing `201`.
  Callers that treated any status other than `201` as a failure must accept
  `200` as a successful replay of an already-applied mutation.

The management contract `0.2.0` is still pending in SkyPorch/daykeeper-openapi
(PR #15) and has no immutable tag yet. No CLI release may be cut against an
untagged contract; see `RELEASING.md`.

### Added

- Add 16 explicit management commands using the published Daykeeper SDK `0.1.0`.
- Return versioned JSON envelopes and structured, redacted errors without prompts.
- Validate resource IDs, versions, idempotency keys, and bounded UTF-8 JSON input.
- Accept scoped access tokens from environment or stdin without credential storage.
- Bound input and requests by one deadline; propagate cancellation and report
  uncertain mutation outcomes without automatic retries.
- Add command/auth/tenant-denial tests, executable loopback smoke, and isolated
  packed-package checks. Keep publication blocked pending bootstrap approval.
- Extend `pack:check` to pack twice and compare the SHA-256 of every extracted
  file, so an unreproducible package fails the build; to reject any test or
  fixture path in the tarball; and to reject a shipped sourcemap whose `sources`
  escape `dist` or use an absolute path.
- Stop shipping `dist/**/*.map`. The generated maps reference `../src`, which is
  not published, so they resolved to nothing on a consumer's machine.
