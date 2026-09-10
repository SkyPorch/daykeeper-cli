import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { DaykeeperMachineSigner } from "@skyporch/daykeeper";
import { runCli, type CliContext } from "../src/index.ts";

const ORIGIN = "https://daykeeper.example.test";
const CONSOLE = "https://console.example.test";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ROTATED_CREDENTIAL = "12121212-1212-4121-8121-121212121212";
const CLAIM = "77777777-7777-4777-8777-777777777777";
const REISSUED_CLAIM = "88888888-8888-4888-8888-888888888888";
const EMAIL = "gabriel@acme.example";
const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function machineToken(credentialId: string): string {
  return `dk_machine_${credentialId.replaceAll("-", "").toLowerCase()}_${base64url(
    randomBytes(32),
  )}`;
}

/** The invitation token the console consumes; it lives only in the claim URL. */
function inviteToken(): string {
  return `dk_invite_${base64url(randomBytes(32))}`;
}

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}

interface FixtureOptions {
  /** Replay answers 200 with no token and no URL, as the API documents. */
  replay?: boolean;
  claimState?: string;
  /** Claims `GET /v1/workspace-claims` reports. */
  items?: Record<string, unknown>[];
  ownerKey?: { x: string; y: string };
  /** Keyed by `METHOD /path`; each entry answers one request, in order. */
  once?: Record<string, (() => Promise<Response> | Response)[]>;
}

interface Fixture {
  fetch: typeof globalThis.fetch;
  requests: Recorded[];
  tokens: string[];
  claimTokens: string[];
  sent: (method: string, path: string) => Recorded[];
}

function apiError(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Rejected", retryable: status >= 500 } },
    { status },
  );
}

function fixture(options: FixtureOptions = {}): Fixture {
  const requests: Recorded[] = [];
  const tokens: string[] = [];
  const claimTokens: string[] = [];
  const revoked = new Set<string>();
  const once = new Map(
    Object.entries(options.once ?? {}).map(([key, value]) => [key, [...value]]),
  );
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

    if (key === "POST /v1/machine-credential-rotations/challenges") {
      return Response.json(
        {
          challengeId: randomUUID(),
          audience: `${ORIGIN}/v1/machine-credential-rotations`,
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

    if (key === "POST /v1/machine-credential-rotations") {
      const token = machineToken(ROTATED_CREDENTIAL);
      tokens.push(token);
      return Response.json(
        {
          ownerId: OWNER,
          organizationId: ORGANIZATION,
          credentialId: ROTATED_CREDENTIAL,
          predecessorId: CREDENTIAL,
          intentId: randomUUID(),
          expiresAt: weeks(1),
          revokedAt: null,
          replayed: false,
          token,
        },
        { status: 201 },
      );
    }

    if (key === "POST /v1/workspace-claims") {
      const claim = {
        id: revoked.size ? REISSUED_CLAIM : CLAIM,
        organizationId: ORGANIZATION,
        email: body!.email,
        role: "owner",
        state: options.claimState ?? "pending",
        expiresAt: hours(72),
        createdAt: new Date().toISOString(),
      };
      if (options.replay) {
        return Response.json(
          { data: { claim, token: null, claimUrl: null, replayed: true } },
          { status: 200 },
        );
      }
      const token = inviteToken();
      claimTokens.push(token);
      return Response.json(
        {
          data: {
            claim,
            token,
            claimUrl: `${CONSOLE}/claim#token=${token}`,
            replayed: false,
          },
        },
        { status: 201 },
      );
    }

    if (key === "GET /v1/workspace-claims") {
      return Response.json({
        data: {
          items: options.items ?? [
            {
              id: CLAIM,
              organizationId: ORGANIZATION,
              email: EMAIL,
              role: "owner",
              state: "accepted",
              expiresAt: hours(72),
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    }

    const revokeMatch = /^\/v1\/workspace-claims\/([^/]+)\/revoke$/.exec(
      url.pathname,
    );
    if (method === "POST" && revokeMatch) {
      revoked.add(revokeMatch[1]!);
      return Response.json({
        data: {
          id: revokeMatch[1],
          organizationId: ORGANIZATION,
          email: EMAIL,
          role: "owner",
          state: "revoked",
          expiresAt: hours(72),
          createdAt: new Date().toISOString(),
        },
      });
    }

    return apiError(404, "RESOURCE_NOT_FOUND");
  };

  return {
    fetch: handler,
    requests,
    tokens,
    claimTokens,
    sent: (method, path) =>
      requests.filter(
        (request) => request.method === method && request.path === path,
      ),
  };
}

function weeks(count: number): string {
  return new Date(Date.now() + count * 7 * 24 * 3600 * 1000).toISOString();
}

function hours(count: number): string {
  return new Date(Date.now() + count * 3600 * 1000).toISOString();
}

function fakeClock() {
  let current = Date.now();
  return {
    clock: {
      now: () => current,
      sleep: async (milliseconds: number, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
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

async function claim(options: RunOptions) {
  const lines: string[] = [];
  const args = options.args ?? ["--email", EMAIL];
  const exitCode = await runCli(
    ["claim", ...args, "--home", options.home, "--origin", ORIGIN],
    {
      env: options.env ?? {},
      stdin: Readable.from([]),
      write: (line) => lines.push(line),
      fetch: options.fixture.fetch,
      clock: options.clock ?? fakeClock().clock,
    },
  );
  assert.equal(lines.length, 1);
  return { exitCode, envelope: JSON.parse(lines[0]!), output: lines[0]! };
}

async function home() {
  return mkdtemp(join(tmpdir(), "daykeeper-cli-claim-"));
}

async function readStateFile(directory: string) {
  return JSON.parse(
    await readFile(join(directory, "credentials.json"), "utf8"),
  ) as Record<string, any>;
}

/** An enrolled workspace with a healthy credential, as `init` would leave it. */
async function seedState(
  directory: string,
  extra: Record<string, unknown> = {},
): Promise<DaykeeperMachineSigner> {
  const signer = await DaykeeperMachineSigner.generate();
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
          expiresAt: weeks(1),
          token: machineToken(CREDENTIAL),
          rotationIntentId: null,
        },
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return signer;
}

test("a first claim issues the link once and records the intent", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.command, "claim");
  const data = result.envelope.data;
  assert.equal(data.replayed, false);
  assert.deepEqual(data.nextActions, []);
  assert.equal(data.claim.id, CLAIM);
  assert.equal(data.claim.email, EMAIL);
  assert.equal(data.claim.role, "owner");
  assert.equal(data.claim.state, "pending");

  // The URL is the handoff: it is printed whole, token and all, on purpose.
  const token = server.claimTokens[0]!;
  assert.equal(data.claimUrl, `${CONSOLE}/claim#token=${token}`);
  assert(result.output.includes(token));

  const request = server.sent("POST", "/v1/workspace-claims")[0]!;
  assert.deepEqual(request.body, { email: EMAIL });
  assert.match(
    request.headers.get("idempotency-key") ?? "",
    /^[A-Za-z0-9._:-]{16,128}$/,
  );
  const state = await readStateFile(directory);
  assert.deepEqual(Object.keys(state.claims), [EMAIL]);
  assert.equal(state.claims[EMAIL].id, CLAIM);
  assert.equal(state.claims[EMAIL].email, EMAIL);
  assert.equal(state.claims[EMAIL].state, "pending");
  assert.equal(
    state.claims[EMAIL].idempotencyKey,
    request.headers.get("idempotency-key"),
  );
  assert(state.claims[EMAIL].expiresAt);
});

test("the claim token and URL are never written to the state file", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  const raw = await readFile(join(directory, "credentials.json"), "utf8");
  const token = server.claimTokens[0]!;
  assert(!raw.includes(token), "The invitation token must never be persisted");
  assert(!raw.includes("dk_invite_"));
  assert(!raw.includes(CONSOLE), "The claim URL must never be persisted");
  assert(!raw.includes("claimUrl"));
  // The machine credential is still redacted from output, unlike the claim URL.
  const state = JSON.parse(raw);
  assert(!result.output.includes(state.credential.token));
  assert(!result.output.includes(state.owner.privateJwk.d));
});

test("a replayed claim returns the pending claim with no URL", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const first = fixture({ ownerKey: signer.publicKey });
  await claim({ home: directory, fixture: first });
  const stored = await readStateFile(directory);

  const server = fixture({ ownerKey: signer.publicKey, replay: true });
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.data.replayed, true);
  assert.equal(result.envelope.data.claimUrl, null);
  assert.deepEqual(result.envelope.data.nextActions, ["reissue_claim"]);
  assert.equal(result.envelope.data.claim.state, "pending");
  assert.equal(
    server
      .sent("POST", "/v1/workspace-claims")[0]!
      .headers.get("idempotency-key"),
    stored.claims[EMAIL].idempotencyKey,
    "A rerun replays the stored intent instead of minting a second claim",
  );
  assert.equal(
    server.sent("POST", `/v1/workspace-claims/${CLAIM}/revoke`).length,
    0,
  );
});

test("--reissue revokes the pending claim and creates under a fresh key", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  await claim({
    home: directory,
    fixture: fixture({ ownerKey: signer.publicKey }),
  });
  const stored = await readStateFile(directory);

  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({
    home: directory,
    fixture: server,
    args: ["--email", EMAIL, "--reissue"],
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server.sent("POST", `/v1/workspace-claims/${CLAIM}/revoke`).length,
    1,
    "The pending claim is revoked before a second one is issued",
  );
  assert.equal(result.envelope.data.revokedClaimId, CLAIM);
  assert.equal(result.envelope.data.claim.id, REISSUED_CLAIM);
  assert(result.envelope.data.claimUrl);
  const key = server
    .sent("POST", "/v1/workspace-claims")[0]!
    .headers.get("idempotency-key");
  assert.notEqual(
    key,
    stored.claims[EMAIL].idempotencyKey,
    "A revoked claim's key is retired, never replayed",
  );
  const state = await readStateFile(directory);
  assert.equal(state.claims[EMAIL].id, REISSUED_CLAIM);
  assert.equal(state.claims[EMAIL].idempotencyKey, key);
});

test("claim status lists claims and reconciles the stored records", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  await claim({
    home: directory,
    fixture: fixture({ ownerKey: signer.publicKey }),
  });

  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({
    home: directory,
    fixture: server,
    args: ["status"],
  });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.command, "claim status");
  assert.equal(result.envelope.data.claims.length, 1);
  assert.equal(result.envelope.data.claims[0].state, "accepted");
  assert.deepEqual(result.envelope.data.reconciled, {
    updated: 1,
    forgotten: 0,
  });
  const state = await readStateFile(directory);
  assert.equal(state.claims[EMAIL].state, "accepted");
  assert.equal(
    server.requests.filter((request) => request.method !== "GET").length,
    0,
    "Reading claims never mutates the workspace",
  );

  // A claim the server no longer lists is expired or revoked; its stored key
  // is spent, so the record is dropped rather than replayed.
  const empty = fixture({ ownerKey: signer.publicKey, items: [] });
  const second = await claim({
    home: directory,
    fixture: empty,
    args: ["status"],
  });
  assert.deepEqual(second.envelope.data.reconciled, {
    updated: 0,
    forgotten: 1,
  });
  assert.deepEqual(await readStateFile(directory).then((s) => s.claims), {});
});

test("a missing state file names init and sends no request", async () => {
  const directory = await home();
  const server = fixture();
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "INIT_REQUIRED");
  assert.deepEqual(result.envelope.error.nextActions, ["run_init"]);
  assert.equal(server.requests.length, 0);

  // A state file that exists but was never enrolled says the same thing.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify({
      version: 1,
      origin: ORIGIN,
      onboardingUrl: ORIGIN,
      apiUrl: ORIGIN,
      gatewayUrl: ORIGIN,
      warning: "seeded",
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const unenrolled = await claim({ home: directory, fixture: server });
  assert.equal(unenrolled.envelope.error.code, "INIT_REQUIRED");
  assert.equal(server.requests.length, 0);
});

test("an unreadable state file is refused before any request", async () => {
  const directory = await home();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "credentials.json"), "{broken", {
    mode: 0o600,
  });
  const server = fixture();
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.error.code, "STATE_UNREADABLE");
  assert.equal(server.requests.length, 0);
});

test("a credential inside its last day rotates before the claim is sent", async () => {
  const directory = await home();
  const signer = await seedState(directory, {
    credential: {
      id: CREDENTIAL,
      expiresAt: hours(1),
      token: machineToken(CREDENTIAL),
      rotationIntentId: null,
    },
  });
  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.envelope.data.credentialRotated, true);
  assert.equal(
    server.sent("POST", "/v1/machine-credential-rotations").length,
    1,
  );
  const rotated = server.tokens[0]!;
  assert.equal(
    server
      .sent("POST", "/v1/workspace-claims")[0]!
      .headers.get("authorization"),
    `Bearer ${rotated}`,
    "The claim is sent under the replacement credential, never the expiring one",
  );
  const state = await readStateFile(directory);
  assert.equal(state.credential.id, ROTATED_CREDENTIAL);
  assert.equal(state.credential.rotationIntentId, null);
  assert(!result.output.includes(rotated));
});

test("a stored credential is pinned to the origin that issued it", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const server = fixture({ ownerKey: signer.publicKey });
  const lines: string[] = [];
  const exitCode = await runCli(
    [
      "claim",
      "--email",
      EMAIL,
      "--home",
      directory,
      "--origin",
      "https://elsewhere.example.test",
    ],
    {
      env: {},
      stdin: Readable.from([]),
      write: (line) => lines.push(line),
      fetch: server.fetch,
      clock: fakeClock().clock,
    },
  );
  assert.equal(exitCode, 1);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.error.code, "STATE_ORIGIN_MISMATCH");
  assert.equal(server.requests.length, 0);
});

test("claim refuses arguments that would run it under another credential", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const server = fixture({ ownerKey: signer.publicKey });
  const stdin = await claim({
    home: directory,
    fixture: server,
    args: ["--email", EMAIL, "--token-stdin"],
  });
  assert.equal(stdin.exitCode, 1);
  assert.equal(stdin.envelope.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(stdin.envelope.error.fields, ["token-stdin"]);

  const statusStdin = await claim({
    home: directory,
    fixture: server,
    args: ["status", "--token-stdin"],
  });
  assert.equal(statusStdin.envelope.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(statusStdin.envelope.error.fields, ["token-stdin"]);

  const supplied = await claim({
    home: directory,
    fixture: server,
    env: { DAYKEEPER_ACCESS_TOKEN: "daykeeper_supplied_access_token_1234" },
  });
  assert.equal(supplied.envelope.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(supplied.envelope.error.fields, ["DAYKEEPER_ACCESS_TOKEN"]);
  assert.equal(server.requests.length, 0);
});

test("an address is normalized and bounded before anything is sent", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  for (const value of ["not-an-address", "", `${"a".repeat(250)}@b.example`]) {
    const server = fixture({ ownerKey: signer.publicKey });
    const result = await claim({
      home: directory,
      fixture: server,
      args: ["--email", value],
    });
    assert.equal(result.exitCode, 1, value);
    assert.equal(
      result.envelope.error.code,
      value === "" ? "MISSING_ARGUMENT" : "INVALID_ARGUMENT",
      value,
    );
    assert.equal(server.requests.length, 0);
  }
  const server = fixture({ ownerKey: signer.publicKey });
  const mixed = await claim({
    home: directory,
    fixture: server,
    args: ["--email", ` Gabriel@ACME.Example `],
  });
  assert.equal(mixed.exitCode, 0, mixed.output);
  assert.deepEqual(server.sent("POST", "/v1/workspace-claims")[0]!.body, {
    email: "gabriel@acme.example",
  });
  const state = await readStateFile(directory);
  assert.deepEqual(Object.keys(state.claims), ["gabriel@acme.example"]);
});

test("an interrupted claim keeps its intent and replays the same key", async () => {
  const directory = await home();
  const signer = await seedState(directory);
  const broken = fixture({
    ownerKey: signer.publicKey,
    once: {
      "POST /v1/workspace-claims": [
        () => {
          throw new Error("connection reset");
        },
      ],
    },
  });
  const failed = await claim({ home: directory, fixture: broken });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.envelope.error.mutationOutcome, "unknown");
  assert(failed.envelope.error.nextActions.includes("run_claim_status"));
  const stored = await readStateFile(directory);
  assert.equal(stored.claims[EMAIL].id, null);
  const key = stored.claims[EMAIL].idempotencyKey as string;

  const server = fixture({ ownerKey: signer.publicKey });
  const result = await claim({ home: directory, fixture: server });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(
    server
      .sent("POST", "/v1/workspace-claims")[0]!
      .headers.get("idempotency-key"),
    key,
    "The interrupted intent is replayed, never replaced",
  );
});

test("claim's help contract lists every option it accepts", async () => {
  const lines: string[] = [];
  const exitCode = await runCli(["claim", "--help"], {
    env: {},
    stdin: Readable.from([]),
    write: (line) => lines.push(line),
  });
  assert.equal(exitCode, 0);
  const entry = JSON.parse(lines[0]!).data.commands[0];
  assert.equal(entry.name, "claim");
  assert.deepEqual(entry.required, ["email"]);
  assert.deepEqual(entry.scopes, ["daykeeper.accounts:write"]);
  for (const flag of ["reissue", "home", "json", "origin", "base-url"])
    assert(entry.optional.includes(flag), flag);
});
