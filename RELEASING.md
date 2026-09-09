# Releasing the Daykeeper CLI

Version `0.1.0` is the first release candidate. `private` is `false` so the
approved bootstrap publish can proceed; until an npm owner publishes it, no
CLI package exists on npm. Apache-2.0
is the approved license for this original code. This is not a license gate.

## Provenance status

Nothing has been published for `@skyporch/daykeeper-cli`, so it has no
provenance attestation and no missing one either.

Two sibling packages were published by hand and are affected:
`@skyporch/daykeeper@0.1.0` and `@skyporch/daykeeper-react-native@0.1.0` were
published manually with **no provenance attestation**, even though their
`package.json` declares `publishConfig.provenance: true`. That declaration is
not evidence of an attestation; only a workflow publish through OIDC produces
one. Those two `0.1.0` versions **cannot be fixed retroactively** — npm versions
are immutable, and an attestation cannot be attached after the fact. The fix is
forward-only: the first workflow-driven release of each package, publishing with
`--provenance` through trusted publishing, is what produces a real attestation.
No GitHub release exists in any Daykeeper repository, and no `release.yml` has
ever run.

## Bootstrap approval

Before the first release, a maintainer must:

1. Review and merge the implementation and its complete test evidence.
2. Audit the repository history and package contents for credentials, customer
   information, and accidental private dependencies before making it public.
3. Confirm ownership of the `@skyporch` npm scope and required 2FA.
4. Approve a separate release PR setting `private: false`, updating the changelog,
   and replacing the foundation-only bootstrap test with the release gate.
5. Configure the package's npm trusted publisher for organization `SkyPorch`,
   repository `daykeeper-cli`, workflow `release.yml`, environment
   `daykeeper-npm-production`, and **stage publish only**.
6. Set protected environment variable `DAYKEEPER_RELEASE_APPROVED` to `1` and
   require a non-author reviewer.

Do not publish, create release tags, or bypass the private flag as part of a
normal implementation PR. CI builds and checks packages; it cannot publish them.

## Release sequence

Every release follows this exact order. Do not reorder or skip a step.

1. **Tag the contract first.** Cut the immutable `vMAJOR.MINOR.PATCH` tag in
   SkyPorch/daykeeper-openapi. Contract tags are immutable; a CLI release may
   never be cut against an untagged contract.
2. **Point at the tag, not a branch.** Where this repository vendors a contract,
   update `openapi/SOURCE.md` to reference that immutable tag **plus its commit
   SHA**. Never a branch head, and never an unmerged pull request head.
3. **Finalize the changelog.** Complete the section for the version being
   released and leave no `Unreleased` marker on it.
4. **One reviewed version-bump commit.** Bump `package.json` (and
   `src/constants.ts`) in a single reviewed commit, then merge it to `main`.
5. **Create the GitHub release from a tag on `main`.** The release must target
   `main`, and its tag must be an ancestor of `main`. `release.yml` verifies
   both before checking out any repository code.
6. **Let the workflow publish.** `release.yml` runs and publishes with
   `--provenance` through OIDC trusted publishing. No long-lived npm token is
   used or stored.
7. **Verify the attestation after publishing.** Confirm the release actually
   carries provenance:

   ```sh
   curl -fsS "https://registry.npmjs.org/-/npm/v1/attestations/@skyporch/daykeeper-cli@<version>"
   npm view "@skyporch/daykeeper-cli@<version>" dist.attestations
   ```

   If either comes back empty, the release did not produce provenance. Treat it
   as a failed release and investigate before announcing the version.

Record the exact public `@skyporch/daykeeper` dependency and the contract
tag/commit for every version in `COMPATIBILITY.md`; do not claim a newer SDK or
contract has been published because it exists on a branch.

## Rehearsing a release

`release.yml` accepts a manual `workflow_dispatch` with `dry_run` (default
`true`). The dry run performs the full build and check chain and ends at
`npm publish --dry-run --provenance`. It never publishes and never stages. The
ancestor-of-main tag gate is skipped for a dry run because a dry run has no
release tag.

## What the workflow enforces

After bootstrap, a matching GitHub Release enters the protected
`daykeeper-npm-production` environment. The workflow proves the release tag is
an ancestor of `main` before executing any repository code, checks out the exact
tag, verifies `vMAJOR.MINOR.PATCH` against the manifest, runs the full package
suite, and submits the artifact with `npm stage publish --provenance` through
OIDC. A maintainer must download and review that staged artifact, then approve
it with npm 2FA. The workflow cannot approve publication, and no long-lived npm
token belongs in GitHub.

`id-token: write` is granted only on the staging job, never at workflow level.

CI also scans the complete candidate history with a checksum-pinned Gitleaks
binary. A clean current checkout is not sufficient if an older commit contains
a credential.
