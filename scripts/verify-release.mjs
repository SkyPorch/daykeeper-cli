import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const expectedTag = process.env.GITHUB_REF_NAME;

assert.notEqual(
  manifest.license,
  "UNLICENSED",
  "Choose a package license before publishing",
);
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
if (expectedTag) assert.equal(expectedTag, `v${manifest.version}`);
assert.equal(manifest.name, "@skyporch/daykeeper-cli");
assert.equal(
  manifest.repository.url,
  "git+https://github.com/SkyPorch/daykeeper-cli.git",
);
assert.match(
  manifest.dependencies["@skyporch/daykeeper"],
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "The CLI must pin an exact published SDK version",
);
assert(
  (await readFile("CHANGELOG.md", "utf8")).includes(manifest.version),
  "Changelog must include the package version",
);
