import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { verifyExecutable } from "./smoke.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(manifest.name, "@skyporch/daykeeper-cli");
assert.equal(manifest.license, "Apache-2.0");
assert.equal(manifest.dependencies["@skyporch/daykeeper"], "0.1.0");
for (const group of [
  manifest.dependencies,
  manifest.optionalDependencies,
  manifest.peerDependencies,
]) {
  for (const version of Object.values(group ?? {}))
    assert.match(
      String(version),
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      "Distributable dependencies must use exact published versions",
    );
}

const directory = await mkdtemp(join(tmpdir(), "daykeeper-cli-pack-"));
try {
  const result = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      { encoding: "utf8" },
    ),
  );
  assert.equal(result.length, 1);
  const pack = result[0];
  assert.equal(basename(pack.filename), pack.filename);
  const files = pack.files.map((file) => file.path);
  assert(
    !files.includes("pnpm-lock.yaml"),
    "The verification-only lockfile must not be shipped in the tarball",
  );
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    "COMMANDS.md",
    "CHANGELOG.md",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
  ])
    assert(files.includes(required), `Missing package artifact: ${required}`);
  for (const file of files)
    assert(
      /^(?:dist\/|package\.json$|LICENSE$|README\.md$|COMMANDS\.md$|CHANGELOG\.md$)/.test(
        file,
      ),
      `Unexpected package artifact: ${file}`,
    );
  execFileSync("tar", [
    "-xzf",
    join(directory, pack.filename),
    "-C",
    directory,
  ]);
  const extracted = join(directory, "package");
  // A frozen source install fills the package store without registry metadata.
  // Reuse its reviewed lockfile for this offline check, not as package content.
  await copyFile("pnpm-lock.yaml", join(extracted, "pnpm-lock.yaml"));
  execFileSync(
    "pnpm",
    ["install", "--prod", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: extracted, stdio: "pipe", timeout: 60000 },
  );
  const installed = JSON.parse(
    await readFile(
      join(extracted, "node_modules/@skyporch/daykeeper/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.name, "@skyporch/daykeeper");
  assert.equal(installed.version, "0.1.0");
  await verifyExecutable(resolve(extracted, manifest.bin.daykeeper));
  console.log(
    `PASS packed CLI: ${pack.filename}; ${files.length} allowlisted files; published SDK ${installed.version}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
