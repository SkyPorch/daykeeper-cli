import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(manifest.name, "@skyporch/daykeeper-cli");
assert.equal(manifest.license, "Apache-2.0");
assert.equal(
  manifest.repository.url,
  "git+https://github.com/SkyPorch/daykeeper-cli.git",
);
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(
  manifest.private,
  false,
  "The initial CLI is not publishable: complete the documented bootstrap review in a separate approved PR",
);
assert.equal(
  process.env.DAYKEEPER_RELEASE_APPROVED,
  "1",
  "An owner-approved release is required",
);
if (process.env.GITHUB_REF_NAME)
  assert.equal(
    process.env.GITHUB_REF_NAME,
    `v${manifest.version}`,
    "Git tag must match the package version",
  );
const changelog = await readFile("CHANGELOG.md", "utf8");
assert(
  changelog.includes(`## ${manifest.version}`),
  "Changelog must include the release version",
);
for (const group of [
  manifest.dependencies,
  manifest.optionalDependencies,
  manifest.peerDependencies,
]) {
  for (const version of Object.values(group ?? {}))
    assert.match(
      String(version),
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      "Published dependencies cannot reference workspaces, local files, or Git repositories",
    );
}
