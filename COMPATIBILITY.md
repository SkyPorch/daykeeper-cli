# Compatibility

Which Daykeeper API contract each `@skyporch/daykeeper-cli` version targets.

Per `daykeeper-openapi` VERSIONING.md, contract releases are immutable tags of
the form `vMAJOR.MINOR.PATCH`, and every SDK or tool release must record the
exact contract tag and the commit it resolved to. A branch head or an unmerged
pull request head is never an acceptable record.

| CLI version        | Management contract | Customer contract | SDK dependency              | Contract tag / commit                                                                     |
| ------------------ | ------------------- | ----------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| 0.1.0 (unreleased) | 0.2.0               | not used          | `@skyporch/daykeeper` 0.1.0 | none yet — 0.2.0 is pending in SkyPorch/daykeeper-openapi PR #15 and has no immutable tag |

Notes:

- The CLI is a **management** contract consumer only. It does not use the
  customer contract (`openapi/customer.yaml`), which remains at `0.1.0`.
- Management contract `0.2.0` is breaking: `Idempotency-Key` is a required
  header on flow mutations, and a replayed mutation returns `200` alongside
  `201`. See `CHANGELOG.md`.
- The tag/commit cell must be filled with a real `vMAJOR.MINOR.PATCH` tag and
  its commit SHA before any CLI release is cut. Releasing against an untagged
  contract is not permitted.
