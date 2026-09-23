import { DaykeeperClient, generateIdempotencyKey } from "@skyporch/daykeeper";
import type { Clock, Retries } from "./credential.ts";
import { CliError } from "./errors.ts";
import { resolveOrigins, type Origins } from "./origins.ts";
import { emailAddress } from "./schemas.ts";
import { resolveHome, type ClaimState, type InitState } from "./state.ts";
import { initRequired, openStoredCredential } from "./stored.ts";

/**
 * `claim` polls nothing, so its whole wait budget is the rate-limit sleeps a
 * credential rotation may need. It is fixed rather than a flag: a claim that
 * cannot be issued inside a minute is better rerun than slept through.
 */
const CLAIM_WAIT_MS = 60000;

export interface ClaimContext {
  options: Readonly<Record<string, string | boolean | undefined>>;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  timeoutMs: number;
  clock: Clock;
  /** Redact this value from every printed envelope. */
  addSecret: (secret: string) => void;
}

interface ClaimArguments extends Origins {
  email: string;
  home: string;
  reissue: boolean;
}

/**
 * Issue, replay, or reissue an owner claim for the workspace `init` created,
 * or list the claims the server holds. Both forms run under the credential
 * `init` stored, never under a supplied access token.
 */
export async function runClaim(
  context: ClaimContext,
  subcommand: "create" | "status",
): Promise<Record<string, unknown>> {
  const args = parseClaimArguments(context.options, context.env, subcommand);
  // A stored credential belongs to the origin that issued it, exactly as in
  // `init`: the pin is checked before a client exists, so the token is never
  // offered to a different host.
  const {
    state,
    save,
    retries: attempts,
    token,
    rotated,
  } = await openStoredCredential(context, {
    home: args.home,
    origins: () => args,
    waitMs: CLAIM_WAIT_MS,
    rateLimited: () =>
      new CliError(
        "RATE_LIMITED",
        "Daykeeper rate-limited the request and the wait would outlast this run's budget. Run claim again to resume.",
        [],
        true,
        ["run_claim_again"],
      ),
    missing: () =>
      initRequired(
        "No Daykeeper state file was found. Run init first, then claim the workspace it creates.",
      ),
    unenrolled:
      "The Daykeeper state file has no enrolled workspace. Run init again before claiming it.",
  });
  const client = new DaykeeperClient({
    baseUrl: args.apiUrl,
    apiKey: token,
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
  });

  return subcommand === "status"
    ? status(client, state, save, attempts, rotated)
    : create(client, state, save, attempts, args, rotated);
}

async function create(
  client: DaykeeperClient,
  state: InitState,
  save: () => Promise<void>,
  attempts: Retries,
  args: ClaimArguments,
  rotated: boolean,
): Promise<Record<string, unknown>> {
  state.claims ??= {};
  const claims = state.claims;
  let record: ClaimState | undefined = claims[args.email];

  // Reissuing revokes the pending claim first, so the address never holds two,
  // and always retires the stored key: replaying it would return the claim the
  // caller just asked to replace, which is the opposite of a reissue.
  let revoked: string | null = null;
  if (args.reissue) {
    if (record?.id && record.state === "pending") {
      await attempts.request(() => client.workspaceClaims.revoke(record!.id!));
      revoked = record.id;
    }
    record = undefined;
  }

  const idempotencyKey = record?.idempotencyKey ?? generateIdempotencyKey();
  // The intent is persisted before the mutation is sent, so an interrupted run
  // replays this key rather than issuing a second claim for the same address.
  claims[args.email] = {
    id: record?.id ?? null,
    email: args.email,
    idempotencyKey,
    expiresAt: record?.expiresAt ?? null,
    state: record?.state ?? null,
    updatedAt: new Date().toISOString(),
  };
  await save();

  const result = await attempts.request(() =>
    client.workspaceClaims.create({ email: args.email }, { idempotencyKey }),
  );
  claims[args.email] = {
    id: result.claim.id,
    email: args.email,
    idempotencyKey,
    expiresAt: result.claim.expiresAt,
    state: result.claim.state,
    updatedAt: new Date().toISOString(),
  };
  await save();

  // `claimUrl` carries the invitation token in its fragment and is printed
  // unredacted on purpose: it is the handoff, and the whole point of the
  // command is to give a person that one link. The token inside it is
  // therefore NOT added to the redaction list, unlike the machine credential.
  // `result.token` itself is dropped: the URL already delivers it, and a bare
  // token in the envelope would invite storing it.
  return {
    claim: result.claim,
    claimUrl: result.claimUrl,
    replayed: result.replayed,
    nextActions: result.claimUrl === null ? ["reissue_claim"] : [],
    ...(revoked ? { revokedClaimId: revoked } : {}),
    credentialRotated: rotated,
  };
}

async function status(
  client: DaykeeperClient,
  state: InitState,
  save: () => Promise<void>,
  attempts: Retries,
  rotated: boolean,
): Promise<Record<string, unknown>> {
  const { items } = await attempts.request(() => client.workspaceClaims.list());
  const byId = new Map(items.map((claim) => [claim.id, claim]));
  const claims = state.claims ?? {};
  let updated = 0;
  let forgotten = 0;
  for (const [key, record] of Object.entries(claims)) {
    // A record whose claim never came back from the server has no id yet; it
    // keeps its idempotency key so a rerun replays the interrupted intent.
    if (record.id === null) continue;
    const live = byId.get(record.id);
    if (!live) {
      // The list hides expired claims, and a revoked one is gone. Either way
      // the stored key is spent, so the record is dropped rather than kept as
      // a key that would replay a claim nobody can accept.
      delete claims[key];
      forgotten += 1;
      continue;
    }
    if (live.state !== record.state || live.expiresAt !== record.expiresAt) {
      record.state = live.state;
      record.expiresAt = live.expiresAt;
      record.updatedAt = new Date().toISOString();
      updated += 1;
    }
  }
  if (updated || forgotten) {
    state.claims = claims;
    await save();
  }
  return {
    claims: items,
    reconciled: { updated, forgotten },
    credentialRotated: rotated,
  };
}

function parseClaimArguments(
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
  subcommand: "create" | "status",
): ClaimArguments {
  const text = (value: string | boolean | undefined) =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    email: subcommand === "status" ? "" : emailAddress(text(options.email)),
    home: resolveHome(text(options.home), env),
    reissue: options.reissue === true,
    ...resolveOrigins(options, env),
  };
}
