import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the release guard rejects bootstrap publication even with the approval flag set", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-release.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { DAYKEEPER_RELEASE_APPROVED: "1", GITHUB_REF_NAME: "v0.1.0" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /initial CLI is not publishable/);
});
