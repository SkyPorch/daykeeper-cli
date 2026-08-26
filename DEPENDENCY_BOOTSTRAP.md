# SDK dependency bootstrap

`@skyporch/daykeeper` does not yet exist on npm, so a clean registry install of
this repository is intentionally blocked. The source is locally verified
against sibling `SkyPorch/daykeeper-node` commit `46ee05c`.

After the reviewed Node SDK is licensed and bootstrapped as version `0.1.0`:

1. Run `pnpm install` here and commit the resulting lockfile.
2. Run `pnpm check` from a clean clone.
3. Remove the temporary dependency-availability branch in CI and require the
   complete package job.
4. Re-run the package-content and secret-history reviews before publicizing or
   releasing this repository.

Do not replace the dependency with a copied SDK, a workspace range, an
unreviewed Git URL, or a long-lived registry token.
