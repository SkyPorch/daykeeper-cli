import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function guard(env: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/verify-release.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env,
    encoding: "utf8",
    timeout: 5000,
  });
}

test("the release guard accepts an owner-approved, tag-matched release", () => {
  const result = guard({
    DAYKEEPER_RELEASE_APPROVED: "1",
    GITHUB_REF_NAME: "v0.1.0",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the release guard refuses without the owner approval flag", () => {
  const result = guard({ GITHUB_REF_NAME: "v0.1.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner-approved release is required/);
});

test("the release guard refuses a tag that does not match the version", () => {
  const result = guard({
    DAYKEEPER_RELEASE_APPROVED: "1",
    GITHUB_REF_NAME: "v9.9.9",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git tag must match the package version/);
});
