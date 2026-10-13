import { DaykeeperClient, generateIdempotencyKey } from "@skyporch/daykeeper";
import type { Clock, Retries } from "./credential.ts";
import { CLI_INVOCATION, HOSTED_ORIGIN } from "./constants.ts";
import { CliError } from "./errors.ts";
import { resolveOrigins, type Origins } from "./origins.ts";
import { emailAddress } from "./schemas.ts";
import {
  OPEN_CLAIM_KEY,
  resolveHome,
  type ClaimState,
  type InitState,
} from "./state.ts";
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
  /** Null issues the workspace's open claim. */
  email: string | null;
  home: string;
  /** The `--home` the caller passed, repeated in printed follow-up commands. */
  homeOption: string | undefined;
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
  const issued = await issueClaim(client, state, save, attempts, {
    email: args.email,
    reissue: args.reissue,
  });
  return {
    ...issued,
    handoff: claimHandoff(issued, args.email, followUpFlags(args), {
      inboxName: state.enrollment?.name,
    }),
    credentialRotated: rotated,
  };
}

/** What `claim` (and `init --owner-email`) report after issuing a claim. */
export interface IssuedClaim {
  claim: {
    id: string;
    /** Null for an open claim nobody has accepted yet. */
    email: string | null;
    state: string;
    expiresAt: string;
    [key: string]: unknown;
  };
  claimUrl: string | null;
  replayed: boolean;
  /** Whether Daykeeper emailed the link to the address on this request. */
  emailed: boolean;
  nextActions: string[];
  revokedClaimId?: string;
  /** True for an open claim: a link that names nobody. */
  open: boolean;
  /** Who owns the workspace through this claim, once it is accepted. */
  owner?: { email: string; acceptedAt: string | null };
}

/**
 * Issue, replay, or reissue the owner claim for one address (or, with a null
 * address, the workspace's open claim), under the stored credential. Shared by
 * `claim` and by `init`.
 */
export async function issueClaim(
  client: DaykeeperClient,
  state: InitState,
  save: () => Promise<void>,
  attempts: Retries,
  input: { email: string | null; reissue: boolean },
): Promise<IssuedClaim> {
  state.claims ??= {};
  const claims = state.claims;
  const key = input.email ?? OPEN_CLAIM_KEY;
  let record: ClaimState | undefined = claims[key];

  // Reissuing revokes the pending claim first, so the address never holds two,
  // and always retires the stored key: replaying it would return the claim the
  // caller just asked to replace, which is the opposite of a reissue.
  let revoked: string | null = null;
  if (input.reissue) {
    if (record?.id && record.state === "pending") {
      await attempts.request(() => client.workspaceClaims.revoke(record!.id!));
      revoked = record.id;
    }
    record = undefined;
  }

  const idempotencyKey = record?.idempotencyKey ?? generateIdempotencyKey();
  // The intent is persisted before the mutation is sent, so an interrupted run
  // replays this key rather than issuing a second claim for the same address.
  claims[key] = {
    id: record?.id ?? null,
    email: input.email,
    idempotencyKey,
    expiresAt: record?.expiresAt ?? null,
    state: record?.state ?? null,
    claimUrl: record?.claimUrl ?? null,
    updatedAt: new Date().toISOString(),
  };
  await save();

  const result = await attempts.request(() =>
    client.workspaceClaims.create(
      input.email === null ? {} : { email: input.email },
      { idempotencyKey },
    ),
  );
  // `claimUrl` carries the invitation token in its fragment and is printed
  // unredacted on purpose: it is the handoff, and the whole point of the
  // command is to give a person that one link. The token inside it is
  // therefore NOT added to the redaction list, unlike the machine credential.
  // `result.token` itself is dropped: the URL already delivers it, and a bare
  // token in the envelope would invite storing it.
  //
  // A replay carries no link. When it replays the very claim whose link this
  // file kept, that link is still the live one, so it is handed out again.
  const pending = result.claim.state === "pending";
  const claimUrl =
    result.claimUrl ??
    (pending && record?.id === result.claim.id
      ? (record?.claimUrl ?? null)
      : null);
  claims[key] = {
    id: result.claim.id,
    email: input.email,
    idempotencyKey,
    expiresAt: result.claim.expiresAt,
    state: result.claim.state,
    claimUrl: pending ? claimUrl : null,
    updatedAt: new Date().toISOString(),
  };
  await save();

  // `emailed` is additive in the platform's response (servers that do not
  // send claim emails omit it), so anything but `true` reads as not emailed.
  const emailed = (result as unknown as { emailed?: unknown }).emailed === true;
  return {
    claim: result.claim,
    claimUrl,
    replayed: result.replayed,
    emailed,
    nextActions: claimUrl === null && pending ? ["reissue_claim"] : [],
    ...(revoked ? { revokedClaimId: revoked } : {}),
    open: input.email === null,
    ...(result.claim.state === "accepted" && result.claim.email
      ? {
          owner: {
            email: result.claim.email,
            acceptedAt: result.claim.acceptedAt,
          },
        }
      : {}),
  };
}

/**
 * The plain-language handoff: who the link is for, how long it lasts, what
 * happens until somebody claims the inbox, and the exact command that
 * replaces the link. `claim` and `init` both put it in the envelope, so an
 * agent can relay `message` word for word.
 */
export function claimHandoff(
  issued: IssuedClaim,
  email: string | null,
  followUp: string,
  options: { inboxName?: string } = {},
): {
  sendTo: string | null;
  expiresAt: string;
  reissueCommand: string;
  message: string;
} {
  const reissueCommand = [
    email === null
      ? `${CLI_INVOCATION} claim --reissue`
      : `${CLI_INVOCATION} claim --email ${email} --reissue`,
    followUp,
  ]
    .filter(Boolean)
    .join(" ");
  const expiry = describeExpiry(issued.claim.expiresAt);
  const inbox = options.inboxName
    ? `Your Daykeeper inbox "${options.inboxName}"`
    : "Your Daykeeper inbox";
  // The real reason to claim: until a person owns the inbox, nobody but the
  // agent sees customer messages, and nobody is emailed about them.
  const consequence = `${inbox} is live. Until someone claims it, customer messages reach only your AI agent and nobody is emailed about them.`;
  let message: string;
  if (issued.owner) {
    message = `${issued.owner.email} claimed this inbox and owns it now. They sign in to Daykeeper with that address to read its conversations; the agent credential keeps working.`;
  } else if (issued.claimUrl && email === null) {
    message = [
      consequence,
      `To own it, open this link and sign in: ${issued.claimUrl}`,
      `The link works once, for whoever opens it first, and expires ${expiry}.`,
      `If it is lost or expires, run: ${reissueCommand}`,
    ].join(" ");
  } else if (issued.claimUrl) {
    message = [
      consequence,
      issued.emailed
        ? `Daykeeper emailed this link to ${email}. You can also send it yourself.`
        : `Send this link to ${email}.`,
      `It works once, only for someone signed in as ${email}, and expires ${expiry}.`,
      `They sign in to Daykeeper with that address and become an owner of this workspace; the agent credential keeps working.`,
      `If the link is lost or expires, run: ${reissueCommand}`,
    ].join(" ");
  } else {
    message = [
      email === null
        ? `An open claim link for this inbox is already waiting and expires ${expiry}.`
        : `A claim for ${email} is already waiting and expires ${expiry}.`,
      `Its link is only shown when it is issued.`,
      `To print a new link, run: ${reissueCommand}`,
    ].join(" ");
  }
  return {
    sendTo: issued.owner ? issued.owner.email : email,
    expiresAt: issued.claim.expiresAt,
    reissueCommand,
    message,
  };
}

/** "in 72 hours (on 9 October 2026 at 08:26 UTC)". */
export function describeExpiry(expiresAt: string, now = Date.now()): string {
  const at = new Date(expiresAt);
  if (!Number.isFinite(at.getTime())) return "soon";
  const hours = Math.max(0, Math.round((at.getTime() - now) / 3_600_000));
  const day = at.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = at.toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `in ${hours} hour${hours === 1 ? "" : "s"} (on ${day} at ${time} UTC)`;
}

/** The flags a follow-up command needs to reach the same origin and home. */
export function followUpFlags(args: {
  origin: string;
  homeOption?: string;
}): string {
  return [
    ...(args.origin === HOSTED_ORIGIN ? [] : [`--origin ${args.origin}`]),
    ...(args.homeOption ? [`--home ${JSON.stringify(args.homeOption)}`] : []),
  ].join(" ");
}

async function status(
  client: DaykeeperClient,
  state: InitState,
  save: () => Promise<void>,
  attempts: Retries,
  rotated: boolean,
): Promise<Record<string, unknown>> {
  const { items } = await attempts.request(() =>
    client.workspaceClaims.list({ includeOpen: true }),
  );
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
      // A link is kept only while its claim can still be accepted.
      if (live.state !== "pending") record.claimUrl = null;
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
    // No --email issues (or with --reissue, replaces) the open claim.
    // An --email given empty is a mistake, not a request for an open link.
    email:
      subcommand === "status" || options.email === undefined
        ? null
        : emailAddress(text(options.email)),
    home: resolveHome(text(options.home), env),
    homeOption: text(options.home),
    reissue: options.reissue === true,
    ...resolveOrigins(options, env),
  };
}
