import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  runCli,
  CLI_VERSION,
  ENVELOPE_VERSION,
  SDK_VERSION,
  type CliContext,
} from "../src/index.ts";
import { commandCatalog } from "../src/commands.ts";

const TOKEN = "daykeeper_test_only_access_token_123456789";
const BASE_URL = "https://api.example.test/daykeeper-api";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const PLAN = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const FLOW = "55555555-5555-4555-8555-555555555555";
const KEY = "daykeeper-cli-plan-application-0001";
const tenant = {
  name: "Acme Support",
  slug: "acme-support",
  locale: "en-US",
  administrator: { name: "Support Lead", email: "support-lead@example.com" },
};
const channel = { address: "support@example.com", region: "us-east-1" };
const definition = {
  schemaVersion: "2026-08-01",
  trigger: { event: "message.received", channel: "email" },
  conditions: [],
  actions: [{ id: "handoff", type: "handoff", target: "human" }],
};
const flow = { name: "Acme routing", slug: "acme-routing", definition };
const flowVersion = { expectedLatestVersion: 2, definition };

interface CapturedRequest {
  url: string;
  method: string;
  body?: unknown;
  headers: Headers;
  signal?: AbortSignal | null;
  redirect?: RequestRedirect;
  credentials?: RequestCredentials;
}

interface InvocationOptions {
  env?: CliContext["env"];
  input?: string | Buffer;
  stdin?: Readable & { isTTY?: boolean };
  signal?: AbortSignal;
  respond?: (request: CapturedRequest) => Promise<Response> | Response;
}

async function invoke(args: string[], options: InvocationOptions = {}) {
  const requests: CapturedRequest[] = [];
  const lines: string[] = [];
  const exitCode = await runCli(args, {
    env: options.env ?? {
      DAYKEEPER_ACCESS_TOKEN: TOKEN,
      DAYKEEPER_API_URL: BASE_URL,
    },
    stdin:
      options.stdin ??
      Readable.from(options.input === undefined ? [] : [options.input]),
    write: (line) => {
      lines.push(line);
    },
    signal: options.signal,
    fetch: async (url, init) => {
      const request: CapturedRequest = {
        url: String(url),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
        signal: init?.signal,
        redirect: init?.redirect,
        credentials: init?.credentials,
      };
      requests.push(request);
      return options.respond
        ? options.respond(request)
        : Response.json({ data: { fixture: "command-contract" } });
    },
  });
  assert.equal(lines.length, 1);
  assert(lines[0]!.endsWith("\n"));
  assert.equal(lines[0]!.split("\n").length, 2);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.schemaVersion, ENVELOPE_VERSION);
  assert(
    !lines[0]!.includes(TOKEN),
    "The supplied credential must never appear in output",
  );
  return { exitCode, envelope, requests, output: lines[0]! };
}

test("help and version are deterministic JSON and never read credentials or stdin", async () => {
  let reads = 0;
  const stdin = new Readable({
    read() {
      reads += 1;
      this.push(null);
    },
  });
  const first = await invoke(["--help"], { env: {}, stdin });
  const second = await invoke([], { env: {} });
  assert.equal(first.output, second.output);
  assert.equal(first.exitCode, 0);
  assert.equal(first.requests.length, 0);
  assert.equal(reads, 0);
  assert.equal(first.envelope.data.commands.length, 16);
  const version = await invoke(["--version"], { env: {} });
  assert.deepEqual(version.envelope.data, {
    name: "@skyporch/daykeeper-cli",
    version: CLI_VERSION,
    sdkVersion: SDK_VERSION,
  });
  const specific = await invoke(["tenants", "apply", "--help"], { env: {} });
  assert.deepEqual(
    specific.envelope.data.commands.map(
      (value: { name: string }) => value.name,
    ),
    ["tenants apply"],
  );
  assert.equal(specific.requests.length, 0);
});

const cases = [
  {
    command: "capabilities",
    flags: [],
    method: "GET",
    path: "/v1/capabilities",
  },
  { command: "tenants list", flags: [], method: "GET", path: "/v1/tenants" },
  {
    command: "tenants get",
    flags: ["--tenant-id", TENANT],
    method: "GET",
    path: `/v1/tenants/${TENANT}`,
  },
  {
    command: "tenants plan",
    flags: ["--input", "-"],
    method: "POST",
    path: "/v1/tenant-plans",
    input: tenant,
  },
  {
    command: "tenants apply",
    flags: ["--plan-id", PLAN, "--plan-version", "2", "--idempotency-key", KEY],
    method: "POST",
    path: "/v1/tenants:apply",
    body: { planId: PLAN, planVersion: 2 },
    key: KEY,
  },
  {
    command: "email-channels get",
    flags: ["--tenant-id", TENANT],
    method: "GET",
    path: `/v1/tenants/${TENANT}/email-channel`,
  },
  {
    command: "email-channels plan",
    flags: ["--tenant-id", TENANT, "--input", "-"],
    method: "POST",
    path: `/v1/tenants/${TENANT}/email-channel-plans`,
    input: channel,
  },
  {
    command: "email-channels apply",
    flags: ["--plan-id", PLAN, "--plan-version", "3", "--idempotency-key", KEY],
    method: "POST",
    path: "/v1/email-channels:apply",
    body: { planId: PLAN, planVersion: 3 },
    key: KEY,
  },
  {
    command: "operations get",
    flags: ["--operation-id", OPERATION],
    method: "GET",
    path: `/v1/operations/${OPERATION}`,
  },
  {
    command: "operations retry",
    flags: ["--operation-id", OPERATION],
    method: "POST",
    path: `/v1/operations/${OPERATION}/retry`,
  },
  {
    command: "flows list",
    flags: ["--tenant-id", TENANT],
    method: "GET",
    path: `/v1/flows?tenantId=${TENANT}`,
  },
  {
    command: "flows get",
    flags: ["--flow-id", FLOW],
    method: "GET",
    path: `/v1/flows/${FLOW}`,
  },
  {
    command: "flows create",
    flags: ["--tenant-id", TENANT, "--input", "-", "--idempotency-key", KEY],
    method: "POST",
    path: `/v1/tenants/${TENANT}/flows`,
    input: flow,
    key: KEY,
  },
  {
    command: "flows versions get",
    flags: ["--flow-id", FLOW, "--version", "2"],
    method: "GET",
    path: `/v1/flows/${FLOW}/versions/2`,
  },
  {
    command: "flows versions create",
    flags: ["--flow-id", FLOW, "--input", "-", "--idempotency-key", KEY],
    method: "POST",
    path: `/v1/flows/${FLOW}/versions`,
    input: flowVersion,
    key: KEY,
  },
  {
    command: "flows versions publish",
    flags: [
      "--flow-id",
      FLOW,
      "--version",
      "2",
      "--expected-resource-version",
      "7",
      "--idempotency-key",
      KEY,
    ],
    method: "POST",
    path: `/v1/flows/${FLOW}/versions/2/publish`,
    body: { expectedResourceVersion: 7 },
    key: KEY,
  },
];

for (const fixture of cases) {
  test(`command contract: ${fixture.command}`, async () => {
    const result = await invoke(
      [...fixture.command.split(" "), ...fixture.flags, "--json"],
      {
        input:
          fixture.input === undefined
            ? undefined
            : JSON.stringify(fixture.input),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.command, fixture.command);
    assert.deepEqual(result.envelope.data, { fixture: "command-contract" });
    assert.equal(
      result.requests.length,
      1,
      "Each invocation dispatches exactly the selected SDK method",
    );
    const request = result.requests[0]!;
    assert.equal(request.url, `${BASE_URL}${fixture.path}`);
    assert.equal(request.method, fixture.method);
    assert.deepEqual(request.body, fixture.input ?? fixture.body);
    assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(request.headers.get("idempotency-key"), fixture.key ?? null);
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.get("x-organization-id"), null);
    assert.equal(request.headers.get("x-tenant-id"), null);
  });
}

test("the command catalog and tested SDK dispatch matrix remain identical", () => {
  assert.deepEqual(
    commandCatalog()
      .map((command) => command.name)
      .sort(),
    cases.map((fixture) => fixture.command).sort(),
  );
});

test("listing flows without a tenant filter preserves server-side authorization", async () => {
  const result = await invoke(["flows", "list"]);
  assert.equal(result.requests[0]!.url, `${BASE_URL}/v1/flows`);
});

test("plan output is returned unchanged and never automatically applied", async () => {
  const response = {
    id: PLAN,
    version: 4,
    warnings: ["Review changes"],
    changes: [{ action: "create" }],
  };
  const result = await invoke(["tenants", "plan", "--input", "-"], {
    input: JSON.stringify(tenant),
    respond: () => Response.json({ data: response }, { status: 201 }),
  });
  assert.deepEqual(result.envelope.data, response);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.url, `${BASE_URL}/v1/tenant-plans`);
});

test("apply replays preserve the caller's exact plan and idempotency identifiers", async () => {
  const args = [
    "tenants",
    "apply",
    "--plan-id",
    PLAN,
    "--plan-version",
    "9",
    "--idempotency-key",
    KEY,
  ];
  const first = await invoke(args);
  const second = await invoke(args, {
    respond: () => Response.json({ data: { replayed: true } }),
  });
  assert.deepEqual(first.requests[0]!.body, second.requests[0]!.body);
  assert.equal(
    first.requests[0]!.headers.get("idempotency-key"),
    second.requests[0]!.headers.get("idempotency-key"),
  );
  assert.equal(second.envelope.data.replayed, true);
});

const invalidArguments = [
  ["signup"],
  ["capabilities", "--access-token", TOKEN],
  ["capabilities", "--token", TOKEN],
  ["capabilities", "--organization-id", OTHER_TENANT],
  ["capabilities", "--tenant-id", TENANT],
  ["capabilities", "--base-url", BASE_URL, "--base-url", BASE_URL],
  ["capabilities", "--json", "--json"],
  ["tenants", "get", "--tenant-id", "../other"],
  ["tenants", "get", "--tenant-id", ""],
  ["tenants", "apply", "--plan-id", PLAN, "--plan-version", "1"],
  [
    "tenants",
    "apply",
    "--plan-id",
    PLAN,
    "--plan-version",
    "0",
    "--idempotency-key",
    KEY,
  ],
  [
    "tenants",
    "apply",
    "--plan-id",
    PLAN,
    "--plan-version",
    "9007199254740992",
    "--idempotency-key",
    KEY,
  ],
  [
    "tenants",
    "apply",
    "--plan-id",
    PLAN,
    "--plan-version",
    "1",
    "--idempotency-key",
    "short",
  ],
  [
    "tenants",
    "apply",
    "--plan-id",
    PLAN,
    "--plan-version",
    "1",
    "--idempotency-key",
    `${KEY}\ninjected`,
  ],
  ["flows", "versions", "publish", "--flow-id", FLOW, "--version", "1"],
  ["flows", "create", "--tenant-id", TENANT, "--input", "-"],
  ["flows", "versions", "create", "--flow-id", FLOW, "--input", "-"],
  ["flows", "versions", "get", "--flow-id", FLOW, "--version", "1.5"],
  ["capabilities", "--timeout-ms", "999"],
  ["capabilities", "--timeout-ms", "60001"],
];

for (const [index, args] of invalidArguments.entries()) {
  test(`invalid arguments ${index + 1} reject before transport`, async () => {
    const result = await invoke(args);
    assert.equal(result.exitCode, 1);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.requests.length, 0);
  });
}

test("input files are bounded regular files and retain caller JSON values", async () => {
  const path = fileURLToPath(
    new URL("./fixtures/tenant.json", import.meta.url),
  );
  const result = await invoke(["tenants", "plan", "--input", path]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.requests[0]!.body,
    JSON.parse(await readFile(path, "utf8")),
  );
  const directory = await invoke([
    "tenants",
    "plan",
    "--input",
    fileURLToPath(new URL("./fixtures", import.meta.url)),
  ]);
  assert.equal(directory.envelope.error.code, "INVALID_INPUT_FILE");
  assert.equal(directory.requests.length, 0);
  const missing = await invoke([
    "tenants",
    "plan",
    "--input",
    "/private/daykeeper-test-missing-input.json",
  ]);
  assert.equal(missing.envelope.error.code, "INPUT_READ_FAILED");
  assert(!missing.output.includes("daykeeper-test-missing-input"));
});

test("JSON syntax errors never echo input values", async () => {
  const result = await invoke(["tenants", "plan", "--input", "-"], {
    input: `{"password":"${TOKEN}",broken`,
  });
  assert.equal(result.envelope.error.code, "INVALID_JSON");
  assert.equal(result.requests.length, 0);
  assert(!result.output.includes("password"));
});

test("strict input schemas reject organization overrides and unknown action capabilities", async () => {
  for (const payload of [
    { ...tenant, organizationId: OTHER_TENANT },
    { ...tenant, administrator: { ...tenant.administrator, role: "owner" } },
  ]) {
    const result = await invoke(["tenants", "plan", "--input", "-"], {
      input: JSON.stringify(payload),
    });
    assert.equal(result.envelope.error.code, "INVALID_INPUT");
    assert.equal(result.requests.length, 0);
  }
  for (const actions of [
    [{ id: "unsafe", type: "execute", url: "https://example.test" }],
    [definition.actions[0], definition.actions[0]],
    [],
  ]) {
    const result = await invoke(
      [
        "flows",
        "create",
        "--tenant-id",
        TENANT,
        "--input",
        "-",
        "--idempotency-key",
        KEY,
      ],
      {
        input: JSON.stringify({
          ...flow,
          definition: { ...definition, actions },
        }),
      },
    );
    assert.equal(result.envelope.error.code, "INVALID_INPUT");
    assert.equal(result.requests.length, 0);
  }
});

test("the input boundary rejects invalid UTF-8 and oversized JSON", async () => {
  const invalid = await invoke(["tenants", "plan", "--input", "-"], {
    input: Buffer.from([0xff]),
  });
  assert.equal(invalid.envelope.error.code, "INPUT_READ_FAILED");
  const large = await invoke(["tenants", "plan", "--input", "-"], {
    input: "x".repeat(512 * 1024 + 1),
  });
  assert.equal(large.envelope.error.code, "INPUT_TOO_LARGE");
  assert.equal(large.requests.length, 0);
});

test("authentication requires exactly one non-persisted source", async () => {
  const missing = await invoke(["capabilities"], {
    env: { DAYKEEPER_API_URL: BASE_URL },
  });
  assert.equal(missing.envelope.error.code, "AUTH_REQUIRED");
  const conflict = await invoke(["capabilities", "--token-stdin"], {
    input: TOKEN,
  });
  assert.equal(conflict.envelope.error.code, "AUTH_SOURCE_CONFLICT");
  const stdin = await invoke(["capabilities", "--token-stdin"], {
    env: { DAYKEEPER_API_URL: BASE_URL },
    input: `${TOKEN}\n`,
  });
  assert.equal(stdin.exitCode, 0);
  assert.equal(
    stdin.requests[0]!.headers.get("authorization"),
    `Bearer ${TOKEN}`,
  );
  const both = await invoke(
    ["tenants", "plan", "--token-stdin", "--input", "-"],
    { env: { DAYKEEPER_API_URL: BASE_URL }, input: TOKEN },
  );
  assert.equal(both.envelope.error.code, "STDIN_CONFLICT");
  for (const token of ["short", `${TOKEN}\nheader`, "x".repeat(16385)]) {
    const result = await invoke(["capabilities"], {
      env: { DAYKEEPER_API_URL: BASE_URL, DAYKEEPER_ACCESS_TOKEN: token },
    });
    assert.equal(result.envelope.error.code, "INVALID_ACCESS_TOKEN");
    assert.equal(result.requests.length, 0);
  }
});

test("stdin token plus a regular JSON file is supported without consuming stdin twice", async () => {
  const path = fileURLToPath(
    new URL("./fixtures/tenant.json", import.meta.url),
  );
  const result = await invoke(
    ["tenants", "plan", "--token-stdin", "--input", path],
    { env: { DAYKEEPER_API_URL: BASE_URL }, input: TOKEN },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.requests[0]!.body, tenant);
});

test("TTY stdin never prompts for JSON or credentials", async () => {
  const stdin = Object.assign(Readable.from([TOKEN]), { isTTY: true });
  const result = await invoke(["capabilities", "--token-stdin"], {
    env: { DAYKEEPER_API_URL: BASE_URL },
    stdin,
  });
  assert.equal(result.envelope.error.code, "STDIN_REQUIRED");
  assert.equal(result.requests.length, 0);
});

test("the API origin is explicit and unsafe URL components never reach transport", async () => {
  const absent = await invoke(["capabilities"], {
    env: { DAYKEEPER_ACCESS_TOKEN: TOKEN },
  });
  assert.equal(absent.envelope.error.code, "CONFIGURATION_REQUIRED");
  for (const baseUrl of [
    "http://api.example.test",
    "https://user:password@api.example.test",
    `https://api.example.test?token=${TOKEN}`,
    "https://api.example.test#fragment",
  ]) {
    const result = await invoke(["capabilities", "--base-url", baseUrl]);
    assert.equal(result.envelope.error.code, "INVALID_CONFIGURATION");
    assert.equal(result.requests.length, 0);
    assert(!result.output.includes("password"));
  }
  const local = await invoke([
    "capabilities",
    "--base-url",
    "http://127.0.0.1:4318/api",
  ]);
  assert.equal(
    local.requests[0]!.url,
    "http://127.0.0.1:4318/api/v1/capabilities",
  );
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} stays structured, redacted, and does not retry or broaden access`, async () => {
    const result = await invoke(
      ["tenants", "get", "--tenant-id", OTHER_TENANT],
      {
        respond: () =>
          Response.json(
            {
              error: {
                code: status === 404 ? "NOT_FOUND" : "ACCESS_DENIED",
                message: `private detail ${TOKEN}`,
                retryable: true,
                correlationId: TOKEN,
                fields: ["tenantId", TOKEN],
                nextActions: ["contact_organization_owner", TOKEN],
                details: { organization: "private-other-organization" },
              },
            },
            { status },
          ),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(
      result.requests[0]!.url,
      `${BASE_URL}/v1/tenants/${OTHER_TENANT}`,
    );
    assert.equal(result.envelope.error.status, status);
    assert.equal(result.envelope.error.retryable, false);
    assert.deepEqual(result.envelope.error.fields, ["tenantId"]);
    assert.deepEqual(result.envelope.error.nextActions, [
      "contact_organization_owner",
    ]);
    assert.equal(result.envelope.error.correlationId, undefined);
    assert(!result.output.includes("private"));
    assert(!result.output.includes("other-organization"));
  });
}

test("changing a tenant target never reuses a previous result or changes credentials", async () => {
  const first = await invoke(["tenants", "get", "--tenant-id", TENANT], {
    respond: () => Response.json({ data: { id: TENANT } }),
  });
  const denied = await invoke(["tenants", "get", "--tenant-id", OTHER_TENANT], {
    respond: () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "Hidden", retryable: false } },
        { status: 404 },
      ),
  });
  assert.equal(first.envelope.data.id, TENANT);
  assert.equal(denied.envelope.data, undefined);
  assert(!denied.output.includes(TENANT));
  assert.equal(
    first.requests[0]!.headers.get("authorization"),
    denied.requests[0]!.headers.get("authorization"),
  );
  assert.equal(denied.requests.length, 1);
});

test("rate limiting is returned without automatic retries or sleeps", async () => {
  const result = await invoke(["capabilities"], {
    respond: () =>
      Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Slow down",
            retryable: true,
            correlationId: "request-123",
            nextActions: ["retry_later"],
          },
        },
        { status: 429, headers: { "retry-after": "3" } },
      ),
  });
  assert.equal(result.envelope.error.code, "RATE_LIMITED");
  assert.equal(result.envelope.error.retryable, true);
  assert.equal(result.envelope.error.correlationId, "request-123");
  assert.equal(result.requests.length, 1);
});

test("transport failure cannot automatically repeat an uncertain mutation", async () => {
  const result = await invoke(
    [
      "tenants",
      "apply",
      "--plan-id",
      PLAN,
      "--plan-version",
      "1",
      "--idempotency-key",
      KEY,
    ],
    {
      respond: () => {
        throw new Error(`network failure containing ${TOKEN}`);
      },
    },
  );
  assert.equal(result.envelope.error.code, "NETWORK_ERROR");
  assert.equal(result.envelope.error.mutationOutcome, "unknown");
  assert.deepEqual(result.envelope.error.nextActions, [
    "inspect_operation_before_retry",
    "reuse_original_idempotency_key",
  ]);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.headers.get("idempotency-key"), KEY);
});

test("malformed and oversized responses never become successful CLI output", async () => {
  const invalid = await invoke(["capabilities"], {
    respond: () => Response.json({ accidental: "success" }),
  });
  assert.equal(invalid.envelope.error.code, "INVALID_RESPONSE");
  const oversized = await invoke(["capabilities"], {
    respond: () =>
      new Response("{}", {
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
  });
  assert.equal(oversized.envelope.error.code, "RESPONSE_TOO_LARGE");
});

test("server failure after a mutation preserves uncertainty and server next actions", async () => {
  const result = await invoke(
    [
      "tenants",
      "apply",
      "--plan-id",
      PLAN,
      "--plan-version",
      "1",
      "--idempotency-key",
      KEY,
    ],
    {
      respond: () =>
        Response.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Try again",
              retryable: true,
              nextActions: ["inspect_service_status"],
            },
          },
          { status: 503 },
        ),
    },
  );
  assert.equal(result.envelope.error.code, "SERVICE_UNAVAILABLE");
  assert.equal(result.envelope.error.status, 503);
  assert.equal(result.envelope.error.mutationOutcome, "unknown");
  assert.deepEqual(result.envelope.error.nextActions, [
    "inspect_service_status",
    "inspect_operation_before_retry",
    "reuse_original_idempotency_key",
  ]);
  assert.equal(result.requests.length, 1);
});

test("known authentication tokens are redacted even if reflected in successful data", async () => {
  const result = await invoke(["capabilities"], {
    respond: () => Response.json({ data: { reflected: TOKEN } }),
  });
  assert.equal(result.envelope.data.reflected, "[REDACTED]");
});

test("early SDK response rejection cancels unread transport work", async () => {
  let cancelled = false;
  const result = await invoke(["capabilities"], {
    respond: () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: { "content-length": String(1024 * 1024 + 1) },
        },
      ),
  });
  assert.equal(result.envelope.error.code, "RESPONSE_TOO_LARGE");
  assert.equal(result.requests[0]!.signal?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("pre-cancelled invocations cannot read stdin or dispatch requests", async () => {
  const controller = new AbortController();
  controller.abort(new Error(TOKEN));
  let reads = 0;
  const stdin = new Readable({
    read() {
      reads += 1;
      this.push(null);
    },
  });
  const result = await invoke(["capabilities", "--token-stdin"], {
    env: { DAYKEEPER_API_URL: BASE_URL },
    stdin,
    signal: controller.signal,
  });
  assert.equal(result.envelope.error.code, "REQUEST_ABORTED");
  assert.equal(reads, 0);
  assert.equal(result.requests.length, 0);
});

test(
  "the deadline bounds stalled stdin and prevents late transport",
  { timeout: 5000 },
  async () => {
    const stdin = new Readable({ read() {} });
    const started = performance.now();
    const result = await invoke(
      ["tenants", "plan", "--input", "-", "--timeout-ms", "1000"],
      { stdin },
    );
    assert.equal(result.envelope.error.code, "REQUEST_TIMEOUT");
    assert.equal(result.requests.length, 0);
    assert.equal(stdin.destroyed, true);
    assert(performance.now() - started < 3000);
  },
);

test(
  "the deadline bounds a transport that ignores AbortSignal",
  { timeout: 5000 },
  async () => {
    const result = await invoke(
      [
        "operations",
        "retry",
        "--operation-id",
        OPERATION,
        "--timeout-ms",
        "1000",
      ],
      { respond: () => new Promise<Response>(() => {}) },
    );
    assert.equal(result.envelope.error.code, "REQUEST_TIMEOUT");
    assert.equal(result.envelope.error.mutationOutcome, "unknown");
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0]!.signal?.aborted, true);
  },
);

test(
  "cancellation interrupts a stalled response body without leaking its error",
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    let cancelled = false;
    const result = await invoke(["capabilities", "--timeout-ms", "1000"], {
      signal: controller.signal,
      respond: () => {
        setTimeout(() => controller.abort(new Error(TOKEN)), 20);
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"data":'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    assert.equal(result.envelope.error.code, "REQUEST_ABORTED");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  },
);

test("manifest pins the inspected public SDK without private or local dependencies", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.version, CLI_VERSION);
  assert.equal(manifest.dependencies["@skyporch/daykeeper"], SDK_VERSION);
  assert.equal(SDK_VERSION, "0.2.0");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(
    manifest.private,
    true,
    "Bootstrap publishing remains blocked in this foundation",
  );
  for (const version of Object.values(manifest.dependencies))
    assert.match(String(version), /^\d+\.\d+\.\d+$/);
});
