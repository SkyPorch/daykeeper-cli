import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { verifyExecutable } from "./smoke.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(manifest.name, "@skyporch/daykeeper-cli");
assert.equal(manifest.license, "Apache-2.0");
assert.equal(manifest.dependencies["@skyporch/daykeeper"], "0.2.0");
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

// Paths that must never reach a published tarball. Tests and fixtures are
// review material; shipping them widens the published attack surface and can
// leak sample credentials or customer-shaped data.
const FORBIDDEN_PACK_PATHS = [
  /(?:^|\/)tests?\//,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)fixtures\//,
  /(?:^|\/)smoke\//,
  /(?:^|\/)[^/]+\.test\.[^/]+$/,
];

/** Pack once into its own directory and return the tarball name and file list. */
function packInto(directory) {
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
  return pack;
}

/** Extract a tarball and hash the CONTENTS of every entry. */
async function extractAndHash(directory, filename) {
  execFileSync("tar", ["-xzf", join(directory, filename), "-C", directory]);
  const root = join(directory, "package");
  const hashes = new Map();
  const walk = async (relative) => {
    const absolute = relative ? join(root, relative) : root;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      // Hash file bytes, never the tarball: gzip embeds a build timestamp, so
      // two identical packs always differ as compressed archives.
      else
        hashes.set(
          child,
          createHash("sha256")
            .update(await readFile(join(root, child)))
            .digest("hex"),
        );
    }
  };
  await walk("");
  return { root, hashes };
}

/** Report the first differences between two packs in a readable form. */
function reproducibilityDiff(first, second) {
  const problems = [];
  for (const [file, hash] of first) {
    if (!second.has(file)) problems.push(`only in pack 1: ${file}`);
    else if (second.get(file) !== hash)
      problems.push(
        `content differs: ${file}\n    pack 1 sha256 ${hash}\n    pack 2 sha256 ${second.get(file)}`,
      );
  }
  for (const file of second.keys())
    if (!first.has(file)) problems.push(`only in pack 2: ${file}`);
  return problems;
}

const first = await mkdtemp(join(tmpdir(), "daykeeper-cli-pack-a-"));
const second = await mkdtemp(join(tmpdir(), "daykeeper-cli-pack-b-"));
try {
  const pack = packInto(first);
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

  // No test or fixture material may ship.
  for (const file of files)
    for (const pattern of FORBIDDEN_PACK_PATHS)
      assert(
        !pattern.test(file),
        `Test or fixture path must not be published: ${file}`,
      );

  const packA = await extractAndHash(first, pack.filename);

  // Every shipped sourcemap must stay inside the published tree. A map whose
  // `sources` escape the package points at files the consumer does not have,
  // and an absolute path leaks a build machine's directory layout.
  let sourcemaps = 0;
  for (const file of files) {
    if (!file.endsWith(".map")) continue;
    sourcemaps += 1;
    const map = JSON.parse(await readFile(join(packA.root, file), "utf8"));
    const base = file.slice(0, file.lastIndexOf("/") + 1);
    for (const source of map.sources ?? []) {
      assert(
        !isAbsolute(source) && !/^[A-Za-z]:[\\/]/.test(source),
        `Sourcemap ${file} references an absolute path: ${source}`,
      );
      assert(
        !source.startsWith("file://") && !source.includes("://"),
        `Sourcemap ${file} references a non-relative source: ${source}`,
      );
      const resolved = normalize(base + source)
        .split(sep)
        .join("/");
      assert(
        resolved.startsWith("dist/") && !resolved.startsWith("../"),
        `Sourcemap ${file} references a source outside the published dist: ${source}`,
      );
    }
  }

  // Two packs of the same tree must produce byte-identical file contents.
  const repeat = packInto(second);
  assert.equal(
    repeat.filename,
    pack.filename,
    "Repeated packs must produce the same tarball name",
  );
  const packB = await extractAndHash(second, repeat.filename);
  const problems = reproducibilityDiff(packA.hashes, packB.hashes);
  assert.equal(
    problems.length,
    0,
    `The package is not reproducible across two packs:\n  ${problems.join("\n  ")}`,
  );

  // A frozen source install fills the package store without registry metadata.
  // Reuse its reviewed lockfile for this offline check, not as package content.
  await copyFile("pnpm-lock.yaml", join(packA.root, "pnpm-lock.yaml"));
  execFileSync(
    "pnpm",
    ["install", "--prod", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    { cwd: packA.root, stdio: "pipe", timeout: 60000 },
  );
  const installed = JSON.parse(
    await readFile(
      join(packA.root, "node_modules/@skyporch/daykeeper/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.name, "@skyporch/daykeeper");
  assert.equal(installed.version, "0.2.0");
  await verifyExecutable(resolve(packA.root, manifest.bin.daykeeper));
  console.log(
    `PASS packed CLI: ${pack.filename}; ${files.length} allowlisted files; ` +
      `${packA.hashes.size} entries reproducible across two packs; ` +
      `${sourcemaps} dist-scoped sourcemaps; published SDK ${installed.version}`,
  );
} finally {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
}
