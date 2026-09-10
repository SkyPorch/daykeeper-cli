import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
  chmod,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { DaykeeperMachineSigner } from "@skyporch/daykeeper";
import { runCli, type CliContext } from "../src/index.ts";

const ORIGIN = "https://daykeeper.example.test";
const ENROLL_AUDIENCE = `${ORIGIN}/v1/machine-enrollments`;
const ROTATION_AUDIENCE = `${ORIGIN}/v1/machine-credential-rotations`;
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPERATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CREDENTIAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ROTATED_CREDENTIAL = "12121212-1212-4121-8121-121212121212";
const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A reveal-once credential shaped exactly as the SDK validates it. */
function machineToken(credentialId: string): string {
  return `dk_machine_${credentialId.replaceAll("-", "").toLowerCase()}_${base64url(
    randomBytes(32),
  )}`;
}

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}

interface FixtureOptions {
  /** Audience the enrollment challenge announces; defaults to the test origin. */
  audience?: string;
  /** Consumed in order; a remaining value repeats. */
  operationStates?: string[];
  trafficEnabled?: boolean[];
  tenants?: { id: string; spec: { name: string; slug: string } }[];
  /** Slugs the server already owns; a plan for one answers RESOURCE_CONFLICT. */
  takenSlugs?: string[];
  enrollment?: "issued" | "replayed";
  rotation?: "issued" | "replayed";
  /** Keyed by `METHOD /path`; each entry answers one request, in order. */
  once?: Record<string, (() => Promise<Response> | Response)[]>;
  credentialId?: string;
  expiresAt?: string;
  /** Needed only when a run rotates before it ever enrolls. */
  ownerKey?: { x: string; y: string };
}

interface Fixture {
  fetch: typeof globalThis.fetch;
  requests: Recorded[];
  tokens: string[];
  sent: (method: string, path: string) => Recorded[];
}

function apiError(status: number, code: string, headers: HeadersInit = {}) {
  return Response.json(
    { error: { code, message: "Rejected", retryable: status >= 500 } },
    { status, headers },
  );
}

function fixture(options: FixtureOptions = {}): Fixture {
  const requests: Recorded[] = [];
  const tokens: string[] = [];
  const enrollments = new Map<string, { id: string; token: string }>();
  const rotations = new Map<string, { id: string; token: string }>();
  const challenges = new Map<string, { kind: "enrollment" | "rotation" }>();
  const operationStates = [...(options.operationStates ?? ["succeeded"])];
  const trafficEnabled = [...(options.trafficEnabled ?? [false, true])];
  const taken = new Set(options.takenSlugs ?? []);
  const tenants = [...(options.tenants ?? [])];
  const once = new Map(
    Object.entries(options.once ?? {}).map(([key, value]) => [key, [...value]]),
  );
  // The CLI owns its key, so the fixture learns the public half from the
  // enrollment challenge unless a seeded state made one first.
  let ownerKey = options.ownerKey;
  const thumbprint = async () => {
    assert(ownerKey, "The fixture never saw the machine owner public key");
    return base64url(
      await sha256(
        JSON.stringify({
          crv: "P-256",
          kty: "EC",
          x: ownerKey.x,
          y: ownerKey.y,
        }),
      ),
    );
  };
  const next = <Value>(queue: Value[]): Value => {
    const value = queue.length > 1 ? queue.shift()! : queue[0]!;
    return value;
  };

  const handler: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const headers = new Headers(init?.headers);
    requests.push({ method, path: url.pathname, body, headers });
    const key = `${method} ${url.pathname}`;
    const override = once.get(key);
    if (override && override.length) return override.shift()!();

    if (key === "POST /v1/machine-enrollments/challenges") {
      ownerKey = body!.publicKey as { x: string; y: string };
      const id = randomUUID();
      challenges.set(id, { kind: "enrollment" });
      return Response.json(
        {
          challengeId: id,
          audience: options.audience ?? ENROLL_AUDIENCE,
          nonce: base64url(randomBytes(32)),
          keyThumbprint: await thumbprint(),
          requestHash: hex(
            await sha256(
              JSON.stringify({
                purpose: "daykeeper-machine-enrollment-v1",
                name: String(body!.name).trim(),
                idempotencyKey: body!.idempotencyKey,
              }),
            ),
          ),
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        },
        { status: 201 },
      );
    }

    if (key === "POST /v1/machine-enrollments") {
      const id = options.credentialId ?? CREDENTIAL;
      const replayed =
        options.enrollment === "replayed" || enrollments.has("claimed");
      if (replayed) {
        return Response.json(
          {
            ownerId: OWNER,
            organizationId: ORGANIZATION,
            organizationSlug: "acme-support-machine",
            credentialIssued: false,
            credential: {
              id,
              expiresAt: options.expiresAt ?? weeks(1),
              revokedAt: null,
              policyVersion: "machine-onboarding-v1",
            },
            replayed: true,
            token: null,
          },
          { status: 200 },
        );
      }
      const token = machineToken(id);
      tokens.push(token);
      enrollments.set("claimed", { id, token });
      return Response.json(
        {
          ownerId: OWNER,
          organizationId: ORGANIZATION,
          organizationSlug: "acme-support-machine",
          credentialIssued: true,
          credential: {
            id,
            expiresAt: options.expiresAt ?? weeks(1),
            revokedAt: null,
            policyVersion: "machine-onboarding-v1",
          },
          replayed: false,
          token,
        },
        { status: 201 },
      );
    }

    if (key === "POST /v1/machine-credential-rotations/challenges") {
      const id = randomUUID();
      challenges.set(id, { kind: "rotation" });
      return Response.json(
        {
          challengeId: id,
          audience: ROTATION_AUDIENCE,
          nonce: base64url(randomBytes(32)),
          keyThumbprint: await thumbprint(),
          requestHash: hex(
            await sha256(
              JSON.stringify({
                purpose: "daykeeper-machine-credential-rotation-v1",
                ownerId: String(body!.ownerId).toLowerCase(),
                expectedCredentialId: String(
                  body!.expectedCredentialId,
                ).toLowerCase(),
                intentId: String(body!.intentId).toLowerCase(),
              }),
            ),
          ),
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        },
        { status: 201 },
      );
    }

    if (key === "POST /v1/machine-credential-rotations/current") {
      return Response.json(
        {
          ownerId: OWNER,
          organizationId: ORGANIZATION,
          credentialId: options.credentialId ?? CREDENTIAL,
          expiresAt: options.expiresAt ?? weeks(1),
          revokedAt: null,
        },
        { status: 200 },
      );
    }

    if (key === "POST /v1/machine-credential-rotations") {
      if (options.rotation === "replayed" && !rotations.has("done")) {
        rotations.set("done", { id: ROTATED_CREDENTIAL, token: "" });
        return Response.json(
          {
            ownerId: OWNER,
            organizationId: ORGANIZATION,
            credentialId: ROTATED_CREDENTIAL,
            predecessorId: options.credentialId ?? CREDENTIAL,
            intentId: randomUUID(),
            expiresAt: weeks(1),
            revokedAt: null,
            replayed: true,
            token: null,
          },
          { status: 200 },
        );
      }
      const token = machineToken(ROTATED_CREDENTIAL);
      tokens.push(token);
      return Response.json(
        {
          ownerId: OWNER,
          organizationId: ORGANIZATION,
          credentialId: ROTATED_CREDENTIAL,
          predecessorId: options.credentialId ?? CREDENTIAL,
          intentId: randomUUID(),
          expiresAt: weeks(1),
          revokedAt: null,
          replayed: false,
          token,
        },
        { status: 201 },
      );
    }

    if (key === "GET /v1/tenants") return Response.json({ data: tenants });

    if (key === "POST /v1/tenant-plans") {
      if (taken.has(String(body!.slug)))
        return apiError(409, "RESOURCE_CONFLICT");
      return Response.json(
        { data: { id: PLAN, version: 1, spec: body } },
        { status: 201 },
      );
    }

    if (key === "POST /v1/tenants:apply") {
      const tenant = {
        id: TENANT,
        spec: { name: "Acme Support", slug: "acme-support" },
      };
      tenants.push(tenant);
      return Response.json(
        {
          data: {
            tenant,
            operation: { id: OPERATION, state: "queued" },
            replayed: false,
          },
        },
        { status: 202 },
      );
    }

    if (key === `GET /v1/tenants/${TENANT}/provisioning-operation`) {
      return Response.json({
        data: { id: OPERATION, state: next(operationStates) },
      });
    }

    if (key === `GET /v1/tenants/${TENANT}/inbox`) {
      return Response.json({
        data: {
          id: randomUUID(),
          tenantId: TENANT,
          spec: { type: "api" },
          state: "prepared",
          trafficEnabled: next(trafficEnabled),
          version: 1,
        },
      });
    }

    if (key === `POST /v1/tenants/${TENANT}/inbox-activations`) {
      return Response.json(
        {
          data: {
            activationId: randomUUID(),
            tenantId: TENANT,
            channelId: randomUUID(),
            intent: headers.get("idempotency-key"),
            state: "active",
            createdAt: 1,
            revokedAt: null,
            replayed: false,
          },
        },
        { status: 201 },
      );
    }

    return apiError(404, "RESOURCE_NOT_FOUND");
  };

  return {
    fetch: handler,
    requests,
    tokens,
    sent: (method, path) =>
      requests.filter(
        (request) => request.method === method && request.path === path,
      ),
  };
}

function weeks(count: number): string {
  return new Date(Date.now() + count * 7 * 24 * 3600 * 1000).toISOString();
}

/** A clock whose sleeps are instant but still consume the wait budget. */
function fakeClock() {
  let current = Date.now();
  const waits: number[] = [];
  return {
    waits,
    clock: {
      now: () => current,
      sleep: async (milliseconds: number, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
        waits.push(milliseconds);
        current += milliseconds;
      },
    },
  };
}

interface RunOptions {
  home: string;
  fixture: Fixture;
  args?: string[];
  env?: Record<string, string | undefined>;
  clock?: CliContext["clock"];
}

async function init(options: RunOptions) {
  const lines: string[] = [];
  const args = options.args ?? [];
  const exitCode = await runCli(
    [
      "init",
      "--name",
      "Acme Support",
      "--home",
      options.home,
      ...(args.includes("--origin") ? [] : ["--origin", ORIGIN]),
      ...args,
    ],
    {
      env: options.env ?? {},
      stdin: Readable.from([]),
      write: (line) => lines.push(line),
      fetch: options.fixture.fetch,
      clock: options.clock ?? fakeClock().clock,
    },
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.split("\n").length, 2);
  return { exitCode, envelope: JSON.parse(lines[0]!), output: lines[0]! };
}

async function home() {
  return mkdtemp(join(tmpdir(), "daykeeper-cli-init-"));
}

async function readStateFile(directory: string) {
  return JSON.parse(
    await readFile(join(directory, "credentials.json"), "utf8"),
  ) as Record<string, any>;
}

/** The owner key is generated by the CLI, so the fixture learns it lazily. */
test("a fresh run enrolls, provisions, activates, and writes configuration", async () => {
  const directory = await home();
  const server = fixture();
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.command, "init");
  const data = result.envelope.data;
  assert.equal(data.resumed, false);
  assert.deepEqual(data.steps, [
    "owner_key",
    "enroll",
    "inbox_apply",
    "inbox_wait",
    "inbox_activate",
  ]);
  assert.deepEqual(data.workspace, {
    organizationId: ORGANIZATION,
    slug: "acme-support-machine",
    name: "Acme Support",
    plan: "free",
  });
  assert.deepEqual(data.inbox, {
    tenantId: TENANT,
    slug: "acme-support",
    name: "Acme Support",
    state: "prepared",
    trafficEnabled: true,
  });
  assert.equal(data.credential.id, CREDENTIAL);
  assert.equal(data.credential.storedAt, join(directory, "credentials.json"));
  assert.deepEqual(data.endpoints, { apiUrl: ORIGIN, gatewayUrl: ORIGIN });
  assert.equal(data.sdk.packages.backend, "@skyporch/daykeeper@0.3.0");
  assert.equal(data.mcp.configPath, join(directory, "mcp.json"));
  assert.equal(
    data.mcp.mcpServers.daykeeper.env.DAYKEEPER_API_KEY,
    "<stored; see configPath>",
  );
  assert.equal(
    data.sdk.env.DAYKEEPER_API_KEY,
    "<stored; rerun with --reveal-key>",
  );

  // The proof is bound to the enrollment body, and the credential authorizes
  // every management call.
  assert.equal(server.sent("POST", "/v1/machine-enrollments").length, 1);
  const token = server.tokens[0]!;
  for (const request of server.requests.filter((entry) =>
    entry.path.startsWith("/v1/tenants"),
  )) {
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
  }
  assert.deepEqual(server.sent("POST", "/v1/tenant-plans")[0]!.body, {
    name: "Acme Support",
    slug: "acme-support",
    locale: "en",
    inbox: { type: "api" },
  });

  const state = await readStateFile(directory);
  assert.equal(state.version, 1);
  assert.equal(state.credential.token, token);
  assert.equal(state.owner.privateJwk.crv, "P-256");
  assert.match(state.warning, /cannot be recovered/);
  const stateMode = await stat(join(directory, "credentials.json"));
  assert.equal(stateMode.mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  const mcp = JSON.parse(await readFile(join(directory, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.daykeeper.env.DAYKEEPER_API_KEY, token);
  assert.deepEqual(mcp.mcpServers.daykeeper.args, [
    "--yes",
    "@skyporch/daykeeper-mcp@0.2.0",
  ]);
  assert.equal((await stat(join(directory, "mcp.json"))).mode & 0o777, 0o600);
});

test("the token and the owner key never reach output without --reveal-key", async () => {
  const directory = await home();
  const server = fixture();
  const first = await init({ home: directory, fixture: server });
  const state = await readStateFile(directory);
  const token = state.credential.token as string;
  assert(!first.output.includes(token));
  assert(!first.output.includes(state.owner.privateJwk.d));
  assert(first.output.includes("[REDACTED]") === false);

  const revealed = await init({
    home: directory,
    fixture: fixture({ trafficEnabled: [true] }),
    args: ["--reveal-key"],
  });
  assert.equal(revealed.envelope.data.sdk.env.DAYKEEPER_API_KEY, token);
  assert.equal(
    revealed.envelope.data.mcp.mcpServers.daykeeper.env.DAYKEEPER_API_KEY,
    token,
  );
  assert(!revealed.output.includes(state.owner.privateJwk.d));
});

test("a rerun resumes, reports resumed, and sends no mutation", async () => {
  const directory = await home();
  await init({ home: directory, fixture: fixture() });
  const server = fixture({ trafficEnabled: [true] });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.data.resumed, true);
  assert.deepEqual(result.envelope.data.steps, []);
  assert.equal(result.envelope.data.inbox.trafficEnabled, true);
  assert.deepEqual(
    server.requests
      .filter((request) => request.method !== "GET")
      .map((r) => r.path),
    [],
    "A completed workspace is never mutated again",
  );
  assert.equal(result.envelope.data.inbox.tenantId, TENANT);
});

test("a crash after enrollment resumes without a second enrollment", async () => {
  const directory = await home();
  const broken = fixture({
    once: {
      "GET /v1/tenants": [
        () => {
          throw new Error("connection reset");
        },
      ],
    },
  });
  const failed = await init({ home: directory, fixture: broken });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.envelope.error.code, "NETWORK_ERROR");
  assert(failed.envelope.error.fields.includes("inbox_apply"));
  assert(failed.envelope.error.nextActions.includes("run_init_again"));
  assert.equal(broken.sent("POST", "/v1/machine-enrollments").length, 1);

  const server = fixture();
  const resumed = await init({ home: directory, fixture: server });
  assert.equal(resumed.exitCode, 0, resumed.output);
  assert.equal(resumed.envelope.data.resumed, true);
  assert.deepEqual(resumed.envelope.data.steps, [
    "inbox_apply",
    "inbox_wait",
    "inbox_activate",
  ]);
  assert.equal(server.sent("POST", "/v1/machine-enrollments").length, 0);
  assert.equal(
    server.sent("POST", "/v1/machine-enrollments/challenges").length,
    0,
  );
});

test("an enrollment replay with a lost token rotates the credential", async () => {
  const directory = await home();
  const server = fixture({ enrollment: "replayed" });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.envelope.data.steps, [
    "owner_key",
    "enroll",
    "recover",
    "inbox_apply",
    "inbox_wait",
    "inbox_activate",
  ]);
  assert.equal(
    server.sent("POST", "/v1/machine-credential-rotations").length,
    1,
  );
  const state = await readStateFile(directory);
  assert.equal(state.credential.id, ROTATED_CREDENTIAL);
  assert.equal(state.credential.rotationIntentId, null);
  assert.equal(result.envelope.data.credential.id, ROTATED_CREDENTIAL);
});

test("a credential inside its last day rotates before it is used", async () => {
  const directory = await home();
  const signer = await DaykeeperMachineSigner.generate();
  await seedState(directory, {
    owner: { privateJwk: await signer.exportPrivateKey() },
    enrollment: {
      name: "Acme Support",
      idempotencyKey: "seeded-key-0123456789",
    },
    workspace: {
      ownerId: OWNER,
      organizationId: ORGANIZATION,
      organizationSlug: "acme-support-machine",
    },
    credential: {
      id: CREDENTIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      token: machineToken(CREDENTIAL),
      rotationIntentId: null,
    },
  });
  const server = fixture({ ownerKey: signer.publicKey });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert(result.envelope.data.steps.includes("recover"));
  assert.equal(server.sent("POST", "/v1/machine-enrollments").length, 0);
  const rotation = server.sent(
    "POST",
    "/v1/machine-credential-rotations/challenges",
  )[0]!;
  assert.equal(rotation.body!.expectedCredentialId, CREDENTIAL);
});

test("an unknown credential id is resolved before rotating", async () => {
  const directory = await home();
  const signer = await DaykeeperMachineSigner.generate();
  await seedState(directory, {
    owner: { privateJwk: await signer.exportPrivateKey() },
    workspace: {
      ownerId: OWNER,
      organizationId: ORGANIZATION,
      organizationSlug: "acme-support-machine",
    },
    credential: {
      id: null,
      expiresAt: null,
      token: null,
      rotationIntentId: null,
    },
  });
  const server = fixture({ ownerKey: signer.publicKey });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server.sent("POST", "/v1/machine-credential-rotations/current").length,
    1,
  );
  const probe = server.sent(
    "POST",
    "/v1/machine-credential-rotations/challenges",
  )[0]!;
  assert.equal(
    probe.body!.expectedCredentialId,
    "00000000-0000-0000-0000-000000000000",
  );
});

test("a replayed rotation that cannot reveal a token retries under a fresh intent", async () => {
  const directory = await home();
  const server = fixture({ enrollment: "replayed", rotation: "replayed" });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  const attempts = server.sent("POST", "/v1/machine-credential-rotations");
  assert.equal(attempts.length, 2);
  const intents = server
    .sent("POST", "/v1/machine-credential-rotations/challenges")
    .map((request) => request.body!.intentId);
  assert.notEqual(intents[0], intents[1], "A dead intent is never reused");
});

test("a slug conflict suffixes instead of colliding", async () => {
  const directory = await home();
  const server = fixture({ takenSlugs: ["acme-support", "acme-support-2"] });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    server
      .sent("POST", "/v1/tenant-plans")
      .map((request) => request.body!.slug),
    ["acme-support", "acme-support-2", "acme-support-3"],
  );
  const applies = server.sent("POST", "/v1/tenants:apply");
  assert.equal(applies.length, 1);
  const state = await readStateFile(directory);
  assert.equal(state.inbox.slug, "acme-support-3");
  assert.equal(
    applies[0]!.headers.get("idempotency-key"),
    state.inbox.applyIdempotencyKey,
  );
});

test("an existing tenant is adopted rather than duplicated", async () => {
  const directory = await home();
  const server = fixture({
    tenants: [{ id: TENANT, spec: { name: "Existing", slug: "existing" } }],
    trafficEnabled: [true],
  });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    result.envelope.data.resumed,
    false,
    "An inbox that already carries traffic is not a resumed step",
  );
  assert.deepEqual(result.envelope.data.steps, [
    "owner_key",
    "enroll",
    "inbox_adopt",
    "inbox_wait",
  ]);
  assert.equal(server.sent("POST", "/v1/tenant-plans").length, 0);
  assert.equal(result.envelope.data.inbox.slug, "existing");
});

test("a tenant quota denial is surfaced and never retried", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "POST /v1/tenant-plans": [() => apiError(409, "TENANT_QUOTA_EXCEEDED")],
    },
  });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "TENANT_QUOTA_EXCEEDED");
  assert.equal(server.sent("POST", "/v1/tenant-plans").length, 1);
  assert(result.envelope.error.fields.includes("inbox_apply"));
});

for (const state of ["failed", "cancelled"]) {
  test(`a ${state} provisioning operation ends the run with the operation id`, async () => {
    const directory = await home();
    const server = fixture({ operationStates: ["queued", state] });
    const result = await init({ home: directory, fixture: server });
    assert.equal(result.exitCode, 1);
    assert.equal(result.envelope.error.code, "PROVISIONING_FAILED");
    assert.equal(result.envelope.error.operationId, OPERATION);
    assert.deepEqual(result.envelope.error.nextActions, [
      "operations_retry",
      "run_init_again",
    ]);
    assert.equal(
      server.sent("POST", `/v1/tenants/${TENANT}/inbox-activations`).length,
      0,
    );
    const stored = await readStateFile(directory);
    assert.equal(stored.inbox.provisionedAt, null);
  });
}

test("provisioning that never finishes stops at the wait budget", async () => {
  const directory = await home();
  const server = fixture({ operationStates: ["running"] });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
    args: ["--wait-ms", "10000"],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "PROVISIONING_TIMEOUT");
  assert.equal(result.envelope.error.retryable, true);
  assert(result.envelope.error.nextActions.includes("run_init_again"));
  assert(result.envelope.error.fields.includes("inbox_wait"));
  assert.equal(
    timing.waits.reduce((total, wait) => total + wait, 0) <= 10000,
    true,
    "Polling never exceeds the wait budget",
  );
  const resumable = await readStateFile(directory);
  assert.equal(resumable.inbox.tenantId, TENANT);
});

test("activation that is not wired yet saves the workspace and stops", async () => {
  const directory = await home();
  const server = fixture({
    trafficEnabled: [false],
    once: {
      [`POST /v1/tenants/${TENANT}/inbox-activations`]: [
        () => apiError(503, "FEATURE_UNAVAILABLE"),
      ],
    },
  });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "ACTIVATION_UNAVAILABLE");
  assert(result.envelope.error.nextActions.includes("run_init_again"));
  assert(result.envelope.error.fields.includes("inbox_activate"));
  const stored = await readStateFile(directory);
  assert.equal(stored.inbox.tenantId, TENANT);
  assert.match(stored.inbox.activationIntent, /^[A-Za-z0-9._:-]{16,128}$/);

  // A rerun picks up at activation using the same stored intent.
  const second = fixture({ trafficEnabled: [false, true] });
  const resumed = await init({ home: directory, fixture: second });
  assert.equal(resumed.exitCode, 0, resumed.output);
  assert.deepEqual(resumed.envelope.data.steps, ["inbox_activate"]);
  assert.equal(
    second
      .sent("POST", `/v1/tenants/${TENANT}/inbox-activations`)[0]!
      .headers.get("idempotency-key"),
    stored.inbox.activationIntent,
  );
});

test("a 429 is retried once its Retry-After has elapsed, inside the budget", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "POST /v1/machine-enrollments/challenges": [
        () => apiError(429, "RATE_LIMITED", { "retry-after": "2" }),
      ],
    },
  });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server.sent("POST", "/v1/machine-enrollments/challenges").length,
    2,
  );
  assert.deepEqual(timing.waits, [2000]);
});

test("an uncertain apply keeps its intent and replays the same key", async () => {
  const directory = await home();
  const broken = fixture({
    once: {
      "POST /v1/tenants:apply": [
        () => {
          throw new Error("connection reset");
        },
      ],
    },
  });
  const failed = await init({ home: directory, fixture: broken });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.envelope.error.mutationOutcome, "unknown");
  assert.deepEqual(failed.envelope.error.nextActions, ["run_init_again"]);
  const stored = await readStateFile(directory);
  const key = stored.inbox.applyIdempotencyKey as string;
  assert.match(key, /^[A-Za-z0-9._:-]{16,128}$/);
  assert.equal(
    broken.sent("POST", "/v1/tenants:apply")[0]!.headers.get("idempotency-key"),
    key,
  );

  const server = fixture();
  const resumed = await init({ home: directory, fixture: server });
  assert.equal(resumed.exitCode, 0, resumed.output);
  assert.equal(
    server.sent("POST", "/v1/tenants:apply")[0]!.headers.get("idempotency-key"),
    key,
    "A replay reuses the stored key instead of minting a second one",
  );
  assert.equal(server.sent("POST", "/v1/machine-enrollments").length, 0);
});

test("a state file other accounts can read is refused", async () => {
  const directory = await home();
  await init({ home: directory, fixture: fixture() });
  await chmod(join(directory, "credentials.json"), 0o640);
  const server = fixture();
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_INSECURE");
  assert.deepEqual(result.envelope.error.nextActions, ["run_init_again"]);
  assert.equal(server.requests.length, 0);
});

test("an unreadable state file never starts a second enrollment", async () => {
  const directory = await home();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "credentials.json"), "{broken", {
    mode: 0o600,
  });
  const server = fixture();
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_UNREADABLE");
  assert.equal(server.requests.length, 0);
});

test("init refuses arguments that would run it under another credential", async () => {
  const directory = await home();
  const server = fixture();
  const stdin = await init({
    home: directory,
    fixture: server,
    args: ["--token-stdin"],
  });
  assert.equal(stdin.envelope.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(stdin.envelope.error.fields, ["token-stdin"]);
  const supplied = await init({
    home: directory,
    fixture: server,
    env: { DAYKEEPER_ACCESS_TOKEN: "daykeeper_supplied_access_token_1234" },
  });
  assert.equal(supplied.envelope.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(supplied.envelope.error.fields, ["DAYKEEPER_ACCESS_TOKEN"]);
  assert.equal(server.requests.length, 0);
});

test("only the free plan is accepted and arguments are bounded", async () => {
  const directory = await home();
  const server = fixture();
  for (const [args, field] of [
    [["--plan", "pro"], "plan"],
    [["--wait-ms", "9999"], "wait-ms"],
    [["--wait-ms", "900001"], "wait-ms"],
    [["--slug", "Not A Slug"], "slug"],
    [["--locale", "e"], "locale"],
  ] as [string[], string][]) {
    const result = await init({ home: directory, fixture: server, args });
    assert.equal(
      result.envelope.error.code,
      "INVALID_ARGUMENT",
      args.join(" "),
    );
    assert(result.envelope.error.fields.includes(field));
  }
  const short = await runInvalidName(directory, server, "A");
  assert.equal(short.envelope.error.code, "INVALID_ARGUMENT");
  assert.equal(server.requests.length, 0);
});

async function runInvalidName(
  directory: string,
  server: Fixture,
  name: string,
) {
  const lines: string[] = [];
  await runCli(
    ["init", "--name", name, "--origin", ORIGIN, "--home", directory],
    {
      env: {},
      stdin: Readable.from([]),
      write: (line) => lines.push(line),
      fetch: server.fetch,
      clock: fakeClock().clock,
    },
  );
  return { envelope: JSON.parse(lines[0]!) };
}

test("no origin anywhere uses the hosted API and gateway origins", async () => {
  const directory = await home();
  const server = fixture({
    audience: "https://api.mydaykeeper.com/v1/machine-enrollments",
  });
  const lines: string[] = [];
  const exitCode = await runCli(
    ["init", "--name", "Acme Support", "--home", directory],
    {
      env: {},
      stdin: Readable.from([]),
      write: (line) => lines.push(line),
      fetch: server.fetch,
      clock: fakeClock().clock,
    },
  );
  const envelope = JSON.parse(lines[0]!);
  assert.equal(exitCode, 0, lines[0]);
  assert.deepEqual(envelope.data.endpoints, {
    apiUrl: "https://api.mydaykeeper.com",
    gatewayUrl: "https://gateway.mydaykeeper.com",
  });
  assert(server.requests.length > 0);
});

test("an exhausted signup budget points at the operator, not at a rerun", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "POST /v1/machine-enrollments/challenges": [
        () => apiError(409, "BOOTSTRAP_LIMIT_REACHED"),
      ],
    },
  });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "BOOTSTRAP_LIMIT_REACHED");
  assert.deepEqual(result.envelope.error.nextActions, [
    "contact_daykeeper_operator",
  ]);
  assert.match(result.envelope.error.message, /admission budget/);
  assert(result.envelope.error.fields.includes("enroll"));
  assert.equal(
    server.requests.filter((r) => r.method !== "GET").length,
    1,
    "only the refused challenge was sent",
  );
});

test("an origin must be an HTTPS root without credentials, query, or path", async () => {
  const directory = await home();
  const server = fixture();
  for (const origin of [
    "http://daykeeper.example.test",
    "https://user:password@daykeeper.example.test",
    "https://daykeeper.example.test/onboarding",
    "https://daykeeper.example.test?token=leak",
    "https://daykeeper.example.test#fragment",
  ]) {
    const result = await init({
      home: directory,
      fixture: server,
      args: ["--origin", origin],
    });
    assert.equal(result.envelope.error.code, "INVALID_CONFIGURATION", origin);
    assert(!result.output.includes("password"));
  }
  assert.equal(server.requests.length, 0);
});

test("per-service overrides and environment defaults are honored", async () => {
  const directory = await home();
  const server = fixture();
  const result = await init({
    home: directory,
    fixture: server,
    env: { DAYKEEPER_GATEWAY_URL: "https://gateway.example.test" },
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(result.envelope.data.endpoints, {
    apiUrl: ORIGIN,
    gatewayUrl: "https://gateway.example.test",
  });
});

test("a stored credential is pinned to the origin that issued it", async () => {
  const directory = await home();
  await init({ home: directory, fixture: fixture() });
  const server = fixture();
  const result = await init({
    home: directory,
    fixture: server,
    args: ["--origin", "https://other.example.test"],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_ORIGIN_MISMATCH");
  assert.equal(result.envelope.error.retryable, false);
  assert.deepEqual(result.envelope.error.nextActions, []);
  assert.deepEqual(result.envelope.error.fields.toSorted(), [
    "base-url",
    "gateway-url",
    "onboarding-url",
    "origin",
    "state",
  ]);
  assert.equal(result.envelope.error.storedHost, "daykeeper.example.test");
  assert.equal(result.envelope.error.requestedHost, "other.example.test");
  assert.equal(
    server.requests.length,
    0,
    "A stored credential is never offered to another host",
  );
});

test("an apply conflict never suffixes the slug or mints a second plan", async () => {
  const directory = await home();
  const broken = fixture({
    once: {
      "POST /v1/tenants:apply": [() => apiError(409, "RESOURCE_CONFLICT")],
    },
  });
  const failed = await init({ home: directory, fixture: broken });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.envelope.error.code, "RESOURCE_CONFLICT");
  assert.equal(
    broken.sent("POST", "/v1/tenant-plans").length,
    1,
    "Only a plan conflict may suffix the slug",
  );
  assert.equal(broken.sent("POST", "/v1/tenants:apply").length, 1);
  const stored = await readStateFile(directory);
  assert.equal(stored.inbox.slug, "acme-support");
  const key = stored.inbox.applyIdempotencyKey as string;
  assert.equal(
    broken.sent("POST", "/v1/tenants:apply")[0]!.headers.get("idempotency-key"),
    key,
  );

  const server = fixture();
  const resumed = await init({ home: directory, fixture: server });
  assert.equal(resumed.exitCode, 0, resumed.output);
  assert.equal(
    server.sent("POST", "/v1/tenant-plans").length,
    0,
    "The recorded plan is replayed rather than re-created",
  );
  assert.equal(
    server.sent("POST", "/v1/tenants:apply")[0]!.headers.get("idempotency-key"),
    key,
  );
  assert.equal(resumed.envelope.data.inbox.slug, "acme-support");
});

test("a slug conflict followed by a crash never resends the refused slug", async () => {
  const directory = await home();
  const broken = fixture({
    once: {
      "POST /v1/tenant-plans": [
        () => apiError(409, "RESOURCE_CONFLICT"),
        () => {
          throw new Error("connection reset");
        },
      ],
    },
  });
  const failed = await init({ home: directory, fixture: broken });
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(
    broken.sent("POST", "/v1/tenant-plans").map((entry) => entry.body!.slug),
    ["acme-support", "acme-support-2"],
  );

  const server = fixture({ takenSlugs: ["acme-support", "acme-support-2"] });
  const resumed = await init({ home: directory, fixture: server });
  assert.equal(resumed.exitCode, 0, resumed.output);
  assert.deepEqual(
    server.sent("POST", "/v1/tenant-plans").map((entry) => entry.body!.slug),
    ["acme-support-2", "acme-support-3"],
    "The suffix counter resumes instead of restarting",
  );
});

test("a credential is redacted from the moment it is issued", async () => {
  const directory = await home();
  // The enrolled credential expires inside a day, so the run rotates and the
  // issued credential is superseded before it is ever stored as the live one.
  const server: Fixture = fixture({
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    once: {
      "GET /v1/tenants": [
        () =>
          Response.json(
            {
              error: {
                code: "INVALID_INPUT",
                message: "Rejected",
                retryable: false,
                fields: [server.tokens[0]],
              },
            },
            { status: 400 },
          ),
      ],
    },
  });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "INVALID_INPUT");
  const issued = server.tokens[0]!;
  assert.match(issued, /^dk_machine_/);
  assert(
    !result.output.includes(issued),
    "An echoed credential is redacted even before it is stored",
  );
});

test("a 429 on the enrollment mutation re-challenges instead of replaying the proof", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "POST /v1/machine-enrollments": [
        () => apiError(429, "RATE_LIMITED", { "retry-after": "5" }),
      ],
    },
  });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server.sent("POST", "/v1/machine-enrollments/challenges").length,
    2,
    "A refused proof is never replayed",
  );
  const creates = server.sent("POST", "/v1/machine-enrollments");
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0]!.body!.challengeId, creates[1]!.body!.challengeId);
  assert.deepEqual(timing.waits, [5000]);
});

test("a 429 on the rotation mutation re-challenges before signing again", async () => {
  const directory = await home();
  const server = fixture({
    enrollment: "replayed",
    once: {
      "POST /v1/machine-credential-rotations": [
        () => apiError(429, "RATE_LIMITED", { "retry-after": "4" }),
      ],
    },
  });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server.sent("POST", "/v1/machine-credential-rotations/challenges").length,
    2,
  );
  assert.deepEqual(timing.waits, [4000]);
});

test("a rate limit that outlasts the wait budget refuses instead of sleeping", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "POST /v1/machine-enrollments": [
        () => apiError(429, "RATE_LIMITED", { "retry-after": "60" }),
      ],
    },
  });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
    args: ["--wait-ms", "10000"],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "RATE_LIMITED");
  assert.equal(
    result.envelope.error.kind,
    "cli",
    "The refusal is the CLI's own, not a relayed server rejection",
  );
  assert.equal(result.envelope.error.retryable, true);
  assert(result.envelope.error.fields.includes("wait-ms"));
  assert(result.envelope.error.nextActions.includes("run_init_again"));
  assert.deepEqual(timing.waits, []);
});

test("a management 429 uses its fixed delay at most twice", async () => {
  const directory = await home();
  const server = fixture({
    once: {
      "GET /v1/tenants": Array.from(
        { length: 6 },
        () => () => apiError(429, "RATE_LIMITED"),
      ),
    },
  });
  const timing = fakeClock();
  const result = await init({
    home: directory,
    fixture: server,
    clock: timing.clock,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "RATE_LIMITED");
  assert.equal(
    server.sent("GET", "/v1/tenants").length,
    3,
    "An unprojected delay is retried twice, never five times",
  );
  assert.deepEqual(timing.waits, [3000, 3000]);
});

test("a home directory other accounts can reach is refused, not tightened", async () => {
  const directory = await home();
  await chmod(directory, 0o755);
  const server = fixture();
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_INSECURE");
  assert.equal(server.requests.length, 0);
  assert.equal(
    (await stat(directory)).mode & 0o777,
    0o755,
    "A directory the caller already owned is never silently re-permissioned",
  );
});

test("a state file inside a world-writable directory is refused", async () => {
  const directory = await home();
  await init({ home: directory, fixture: fixture() });
  await chmod(directory, 0o707);
  const server = fixture({ trafficEnabled: [true] });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_INSECURE");
  assert.equal(server.requests.length, 0);
});

test("a symlinked state file is refused", async () => {
  const elsewhere = await home();
  await init({ home: elsewhere, fixture: fixture() });
  const directory = await home();
  await symlink(
    join(elsewhere, "credentials.json"),
    join(directory, "credentials.json"),
  );
  const server = fixture({ trafficEnabled: [true] });
  const result = await init({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_INSECURE");
  assert.equal(
    server.requests.length,
    0,
    "A credential is never read through a symbolic link",
  );
});

test("init's help contract lists every option it accepts", async () => {
  const lines: string[] = [];
  const exitCode = await runCli(["init", "--help"], {
    env: {},
    stdin: Readable.from([]),
    write: (line) => lines.push(line),
  });
  assert.equal(exitCode, 0);
  const envelope = JSON.parse(lines[0]!);
  const entry = envelope.data.commands[0];
  assert.equal(entry.name, "init");
  for (const flag of [
    "base-url",
    "json",
    "origin",
    "onboarding-url",
    "gateway-url",
    "wait-ms",
    "reveal-key",
  ]) {
    assert(entry.optional.includes(flag), flag);
  }
});

/** Write a state file directly to exercise resume paths that need a history. */
async function seedState(
  directory: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify(
      {
        version: 1,
        origin: ORIGIN,
        onboardingUrl: ORIGIN,
        apiUrl: ORIGIN,
        gatewayUrl: ORIGIN,
        warning: "seeded",
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
