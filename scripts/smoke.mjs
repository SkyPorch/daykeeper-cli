import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const TEST_TOKEN = "daykeeper_cli_smoke_test_token_123456789";
const TENANT = "11111111-1111-4111-8111-111111111111";
const FOREIGN_TENANT = "22222222-2222-4222-8222-222222222222";

async function call(bin, args, environment = {}) {
  let result;
  try {
    result = await execute(process.execPath, [bin, ...args], {
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        ...environment,
      },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    result.exitCode = 0;
  } catch (error) {
    assert.equal(
      typeof error.code,
      "number",
      "The executable must exit, not time out or fail to spawn",
    );
    result = {
      exitCode: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
  assert.equal(
    result.stderr,
    "",
    "Commands must not emit progress or raw errors on stderr",
  );
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert(!result.stdout.includes(TEST_TOKEN));
  return { ...result, envelope: JSON.parse(result.stdout) };
}

export async function verifyExecutable(bin) {
  const help = await call(bin, ["--help"]);
  assert.equal(help.exitCode, 0);
  assert.equal(help.envelope.data.commands.length, 17);
  const version = await call(bin, ["--version"]);
  assert.equal(version.envelope.data.sdkVersion, "0.2.0");
  const missingAuth = await call(bin, ["capabilities"], {
    DAYKEEPER_API_URL: "https://example.test",
  });
  assert.equal(missingAuth.exitCode, 1);
  assert.equal(missingAuth.envelope.error.code, "AUTH_REQUIRED");

  // `init` ships with no default hostname, so the packaged executable refuses
  // to run before an origin is configured, and it refuses a supplied token.
  const home = await mkdtemp(join(tmpdir(), "daykeeper-cli-smoke-home-"));
  try {
    const missingOrigin = await call(bin, [
      "init",
      "--name",
      "Smoke Test",
      "--home",
      home,
    ]);
    assert.equal(missingOrigin.exitCode, 1);
    assert.equal(missingOrigin.envelope.error.code, "ORIGIN_REQUIRED");
    assert.deepEqual(missingOrigin.envelope.error.nextActions, [
      "run_init_again",
    ]);
    const suppliedToken = await call(
      bin,
      [
        "init",
        "--name",
        "Smoke Test",
        "--origin",
        "https://example.test",
        "--home",
        home,
      ],
      { DAYKEEPER_ACCESS_TOKEN: TEST_TOKEN },
    );
    assert.equal(suppliedToken.exitCode, 1);
    assert.equal(suppliedToken.envelope.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(await readdir(home), [], "No state is written on refusal");
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      response.writeHead(401).end(
        JSON.stringify({
          error: {
            code: "UNAUTHENTICATED",
            message: "Rejected",
            retryable: false,
          },
        }),
      );
    } else if (request.url === `/proxy/v1/tenants/${TENANT}`) {
      response.end(JSON.stringify({ data: { id: TENANT } }));
    } else {
      response.writeHead(404).end(
        JSON.stringify({
          error: { code: "NOT_FOUND", message: "Hidden", retryable: false },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const environment = {
      DAYKEEPER_API_URL: `http://127.0.0.1:${address.port}/proxy`,
      DAYKEEPER_ACCESS_TOKEN: TEST_TOKEN,
    };
    const permitted = await call(
      bin,
      ["tenants", "get", "--tenant-id", TENANT],
      environment,
    );
    assert.equal(permitted.exitCode, 0);
    assert.deepEqual(permitted.envelope.data, { id: TENANT });
    const denied = await call(
      bin,
      ["tenants", "get", "--tenant-id", FOREIGN_TENANT],
      environment,
    );
    assert.equal(denied.exitCode, 1);
    assert.equal(denied.envelope.error.code, "NOT_FOUND");
    assert.equal(denied.envelope.data, undefined);
    assert(!denied.stdout.includes(TENANT));
    assert.equal(
      requests.length,
      2,
      "Authorization failure must not trigger a retry or fallback request",
    );
    assert(
      requests.every(
        (request) =>
          request.method === "GET" &&
          request.authorization === `Bearer ${TEST_TOKEN}`,
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("PASS executable JSON/auth/loopback tenant-denial smoke");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await verifyExecutable(resolve("dist/cli.js"));
}
