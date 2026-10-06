# Compatibility

Which Daykeeper API contract each `@skyporch/daykeeper-cli` version targets.

Per `daykeeper-openapi` VERSIONING.md, contract releases are immutable tags of
the form `vMAJOR.MINOR.PATCH`, and every SDK or tool release must record the
exact contract tag and the commit it resolved to. A branch head or an unmerged
pull request head is never an acceptable record.

| CLI version | Management contract | Customer contract | SDK dependency              | Contract tag / commit                                                                                                                  |
| ----------- | ------------------- | ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.0       | v1.3.0              | not used          | `@skyporch/daykeeper` 0.3.0 | `v1.3.0` @ `067465edfc6c94e63867a6dd0d9db02e12683877` (SkyPorch/daykeeper-openapi, 2026-09-10)                                         |
| 0.3.0       | v1.3.0              | not used          | `@skyporch/daykeeper` 0.3.0 | `v1.3.0` @ `067465edfc6c94e63867a6dd0d9db02e12683877` (SkyPorch/daykeeper-openapi, 2026-09-10)                                         |
| 0.2.0       | v1.3.0              | not used          | `@skyporch/daykeeper` 0.3.0 | `v1.3.0` @ `067465edfc6c94e63867a6dd0d9db02e12683877` (SkyPorch/daykeeper-openapi, 2026-09-10)                                         |
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
- `@skyporch/daykeeper` 0.3.0 adds the `workspaceClaims` namespace (`create`,
  `list`, `revoke`) that `claim` consumes. The contract bump is `v1.3.0`,
  additive and minor: no existing route or type changes.
- CLI 0.3.0 uses the same SDK and contract as 0.2.0. Its changes are CLI
  behavior: the stored credential is used by default, `DAYKEEPER_API_KEY` is
  canonical, and `DAYKEEPER_ACCESS_TOKEN` is a deprecated alias that fails with
  `AUTH_SOURCE_CONFLICT` when set to a different value. See `CHANGELOG.md`.
- CLI 0.4.0 uses the same SDK and contract as 0.3.0. The `mcp.json` that
  `init` writes pins `@skyporch/daykeeper-mcp@0.3.0` (built on the same SDK
  0.3.0 and contract `v1.3.0`) with its claim tools enabled, so 0.4.0 must be
  released only after MCP 0.3.0 is on npm.
- `claim` and `init --owner-email` read an `emailed` boolean from the claim
  create response. It is not in contract `v1.3.0`; the platform adds it as an
  additive field (SkyPorch/daykeeper#306). When it is absent the CLI reports
  `emailed: false` and tells the agent to send the link itself.
- The tag/commit cell must be filled with a real `vMAJOR.MINOR.PATCH` tag and
  its commit SHA before any CLI release is cut. Releasing against an untagged
  contract is not permitted.
