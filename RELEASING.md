# Releasing the Daykeeper CLI

No CLI package has been published. Version `0.1.0` here is an unreleased
foundation, and `private: true` deliberately prevents publication. Apache-2.0
is the approved license for this original code. This is not a license gate.

## Bootstrap approval

Before the first release, a maintainer must:

1. Review and merge the implementation and its complete test evidence.
2. Audit the repository history and package contents for credentials, customer
   information, and accidental private dependencies before making it public.
3. Confirm ownership of the `@skyporch` npm scope and required 2FA.
4. Approve a separate release PR setting `private: false`, updating the changelog,
   and replacing the foundation-only bootstrap test with the release gate.
5. Run `pnpm check`, inspect the exact tarball, and approve the immutable version.
6. An npm owner publishes the first reviewed package interactively with the
   explicit release approval flag required by `scripts/verify-release.mjs`.

Do not publish, create release tags, or bypass the private flag as part of a
normal implementation PR. CI builds and checks packages; it cannot publish them.

## Later releases

Follow semantic versioning. Record the exact public `@skyporch/daykeeper`
dependency and compatibility evidence for every version; do not claim a newer
SDK has been published because it exists on a branch.

After bootstrap, a separately approved workflow can use the same protected
`daykeeper-npm-production` environment and npm trusted-publishing/staging model
as the Daykeeper SDKs. Configure a non-author reviewer, verify `vMAJOR.MINOR.PATCH`
against the manifest, stage the artifact, and require npm-owner approval before
promotion. No long-lived npm publishing token belongs in GitHub.
