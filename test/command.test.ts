import assert from "node:assert/strict";
import test from "node:test";
import { runDaykeeperCli, type DaykeeperCliIo } from "../src/index.ts";

function output(): {
  io: DaykeeperCliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
    stdout,
    stderr,
  };
}

test("emits machine-readable success output", async () => {
  const capture = output();
  const exitCode = await runDaykeeperCli({
    argv: ["capabilities"],
    env: {
      DAYKEEPER_API_URL: "https://api.daykeeper.example",
      DAYKEEPER_ACCESS_TOKEN: "secret-token",
    },
    fetch: async () =>
      Response.json({
        data: {
          apiVersion: "v1",
          emailChannels: { enabled: true },
          flows: { schemaVersion: "2026-08-01", execution: "management_only" },
        },
      }),
    io: capture.io,
  });

  assert.equal(exitCode, 0);
  assert.equal(capture.stderr.length, 0);
  assert.deepEqual(JSON.parse(capture.stdout[0] ?? ""), {
    data: {
      apiVersion: "v1",
      emailChannels: { enabled: true },
      flows: { schemaVersion: "2026-08-01", execution: "management_only" },
    },
  });
});

test("requires tokens through the environment rather than argv", async () => {
  const capture = output();
  const exitCode = await runDaykeeperCli({
    argv: ["tenants", "list"],
    env: { DAYKEEPER_API_URL: "https://api.daykeeper.example" },
    io: capture.io,
  });

  assert.equal(exitCode, 2);
  assert.equal(capture.stdout.length, 0);
  assert.match(capture.stderr[0] ?? "", /tokens are not accepted in argv/);
});

test("reports unknown flags as structured usage failures", async () => {
  const capture = output();
  const exitCode = await runDaykeeperCli({
    argv: ["tenants", "list", "--token", "unsafe"],
    io: capture.io,
  });

  assert.equal(exitCode, 2);
  assert.match(capture.stderr[0] ?? "", /INVALID_COMMAND/);
  assert(!capture.stderr.join("").includes("unsafe"));
});

test("keeps idempotency keys in headers and JSON input in the body", async () => {
  const capture = output();
  let request: Request | undefined;
  const exitCode = await runDaykeeperCli({
    argv: [
      "tenants",
      "apply",
      "--input",
      "-",
      "--idempotency-key",
      "agent-run-000001",
    ],
    env: {
      DAYKEEPER_API_URL: "https://api.daykeeper.example",
      DAYKEEPER_ACCESS_TOKEN: "secret-token",
    },
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: { replayed: false } });
    },
    io: capture.io,
    readJsonInput: async () => ({ planId: "plan-1", planVersion: 1 }),
  });

  assert.equal(exitCode, 0);
  assert.equal(request?.headers.get("idempotency-key"), "agent-run-000001");
  assert.deepEqual(await request?.json(), { planId: "plan-1", planVersion: 1 });
  assert(!capture.stdout.join("").includes("secret-token"));
});

test("serializes API errors without credentials or stack traces", async () => {
  const capture = output();
  const exitCode = await runDaykeeperCli({
    argv: ["tenants", "list"],
    env: {
      DAYKEEPER_API_URL: "https://api.daykeeper.example",
      DAYKEEPER_ACCESS_TOKEN: "do-not-leak",
    },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "SCOPE_REQUIRED",
            message: "A required scope is missing",
            retryable: false,
            nextActions: ["request_scope"],
            correlationId: "request-1",
          },
        },
        { status: 403 },
      ),
    io: capture.io,
  });

  assert.equal(exitCode, 1);
  const serialized = capture.stderr[0] ?? "";
  assert.match(serialized, /SCOPE_REQUIRED/);
  assert(!serialized.includes("do-not-leak"));
  assert(!serialized.includes("stack"));
});

test("polls operations until they reach a terminal state", async () => {
  const capture = output();
  let attempts = 0;
  const exitCode = await runDaykeeperCli({
    argv: [
      "operations",
      "wait",
      "--id",
      "operation-1",
      "--poll-seconds",
      "0.25",
      "--timeout-seconds",
      "2",
    ],
    env: {
      DAYKEEPER_API_URL: "https://api.daykeeper.example",
      DAYKEEPER_ACCESS_TOKEN: "token",
    },
    fetch: async () => {
      attempts += 1;
      return Response.json({
        data: {
          id: "operation-1",
          state: attempts === 1 ? "running" : "succeeded",
          steps: [],
        },
      });
    },
    io: capture.io,
  });

  assert.equal(exitCode, 0);
  assert.equal(attempts, 2);
  assert.match(capture.stdout[0] ?? "", /succeeded/);
});
