# Compatibility

Which Daykeeper API contract each `@skyporch/daykeeper-cli` version targets.

Per `daykeeper-openapi` VERSIONING.md, contract releases are immutable tags of
the form `vMAJOR.MINOR.PATCH`, and every SDK or tool release must record the
exact contract tag and the commit it resolved to. A branch head or an unmerged
pull request head is never an acceptable record.

| CLI version | Management contract | Customer contract | SDK dependency              | Contract tag / commit                                                                                                                  |
| ----------- | ------------------- | ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0       | v1.1.0              | not used          | `@skyporch/daykeeper` 0.2.0 | `v1.1.0` @ `c9a0175d0053f1a2d57c9329f6d3a36ec6acdb71` (SkyPorch/daykeeper-openapi, 2026-09-08); the tag the SDK 0.2.0 release recorded |

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
- The tag/commit cell must be filled with a real `vMAJOR.MINOR.PATCH` tag and
  its commit SHA before any CLI release is cut. Releasing against an untagged
  contract is not permitted.
