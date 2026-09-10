# Compatibility

Which Daykeeper API contract each `@skyporch/daykeeper-cli` version targets.

Per `daykeeper-openapi` VERSIONING.md, contract releases are immutable tags of
the form `vMAJOR.MINOR.PATCH`, and every SDK or tool release must record the
exact contract tag and the commit it resolved to. A branch head or an unmerged
pull request head is never an acceptable record.

| CLI version | Management contract | Customer contract | SDK dependency              | Contract tag / commit                                                                                                                                                   |
| ----------- | ------------------- | ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0       | v1.1.0              | not used          | `@skyporch/daykeeper` 0.2.0 | `v1.1.0` @ `c9a0175d0053f1a2d57c9329f6d3a36ec6acdb71` (SkyPorch/daykeeper-openapi, 2026-09-08); the tag the SDK 0.2.0 release recorded                                  |
| Unreleased  | v1.3.0              | not used          | `@skyporch/daykeeper` 0.3.0 | **pending** — SDK 0.3.0 is not published and contract `v1.3.0` is not tagged yet; fill in the tag and commit the SDK 0.3.0 release records before cutting a CLI release |

Notes:

- The CLI is a **management** contract consumer only. It does not use the
  customer contract (`openapi/customer.yaml`), which remains at `0.1.0`.
- Management contract `0.2.0` is breaking: `Idempotency-Key` is a required
  header on flow mutations, and a replayed mutation returns `200` alongside
  `201`. See `CHANGELOG.md`.
- `@skyporch/daykeeper` 0.2.0 vendors that same management contract `0.2.0`. It
  adds the unauthenticated onboarding client, the machine owner signer, the
  API-only inbox desired state, `inboxes.get`, `inboxActivations`, and
  `tenants.getProvisioningOperation` used by `init`, and it makes the
  `idempotencyKey` option mandatory on the three flow mutations.
- `@skyporch/daykeeper` 0.3.0 adds the `workspaceClaims` namespace (`create`,
  `list`, `revoke`) that `claim` consumes. The contract bump is `v1.3.0`,
  additive and minor: no existing route or type changes.
- The `Unreleased` row is marked **pending** on purpose. SDK 0.3.0 is not on npm
  and contract `v1.3.0` is not tagged, so `pnpm pack:check` cannot resolve the
  pinned dependency and the lockfile cannot record it. Both are release-blocking
  and must be settled before this row is promoted to a version number.
- The tag/commit cell must be filled with a real `vMAJOR.MINOR.PATCH` tag and
  its commit SHA before any CLI release is cut. Releasing against an untagged
  contract is not permitted.
