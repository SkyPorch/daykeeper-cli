import { join } from "node:path";
import {
  DaykeeperApiError,
  DaykeeperClient,
  DaykeeperMachineSigner,
  DaykeeperOnboardingClient,
  generateIdempotencyKey,
  type InboxChannel,
  type MachineEnrollmentInput,
} from "@skyporch/daykeeper";
import {
  CLI_INVOCATION,
  HOSTED_CONSOLE_URL,
  HOSTED_ORIGIN,
  MCP_PACKAGE,
  REACT_NATIVE_PACKAGE,
  SDK_PACKAGE,
  SDK_VERSION,
} from "./constants.ts";
import {
  isApiCode,
  needsRotation,
  retries,
  rotateCredential,
  type Clock,
} from "./credential.ts";
import {
  claimHandoff,
  followUpFlags,
  issueClaim,
  type IssuedClaim,
} from "./claim.ts";
import { CliError } from "./errors.ts";
import { emailAddress } from "./schemas.ts";
import { assertPinnedOrigin, resolveOrigins, type Origins } from "./origins.ts";
import {
  MCP_FILE,
  OPEN_CLAIM_KEY,
  STATE_FILE,
  STATE_VERSION,
  STATE_WARNING,
  readState,
  resolveHome,
  writeSecureFile,
  writeState,
  type InboxState,
  type InitState,
} from "./state.ts";

/** Every proof is signed immediately after its challenge; the server allows 60s. */
const POLL_INTERVAL_MS = 3000;
const DEFAULT_WAIT_MS = 300000;
const MIN_WAIT_MS = 10000;
const MAX_WAIT_MS = 900000;
const DEFAULT_CONNECT_WAIT_MS = 180000;
const MAX_SLUG_ATTEMPTS = 10;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const INIT_STEPS = [
  "owner_key",
  "enroll",
  "recover",
  "inbox_adopt",
  "inbox_apply",
  "inbox_wait",
  "inbox_activate",
] as const;
export type InitStep = (typeof INIT_STEPS)[number];
type FailureStep = InitStep | "preflight" | "state" | "config" | "owner_claim";

/** Carries the step a failure reached so the envelope can report it. */
export class InitStepError extends Error {
  constructor(
    readonly step: FailureStep,
    readonly resumable: boolean,
    readonly failure: unknown,
  ) {
    super("The init command stopped at a recorded step.");
    this.name = "DaykeeperInitStepError";
  }
}

/** Kept as the published name for the shared clock seam. */
export type InitClock = Clock;

export interface InitContext {
  options: Readonly<Record<string, string | boolean | undefined>>;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  timeoutMs: number;
  clock: InitClock;
  /** Redact this value from every printed envelope. */
  addSecret: (secret: string) => void;
  /** Return a placeholder that is replaced with the literal value after redaction. */
  reveal: (secret: string) => string;
  /** Add a non-fatal note to the printed envelope. */
  warn?: (warning: { code: string; message: string }) => void;
  /** Whether a person is at the terminal (stdout is a TTY). */
  interactive?: boolean;
  /** Open a URL in the person's browser (`--connect`, at a terminal only). */
  openUrl?: (url: string) => Promise<void> | void;
  /**
   * Say something while the run is still going, without touching the JSON
   * envelope on stdout (`--connect` prints its link this way, on stderr).
   */
  notify?: (text: string) => void;
}

export { realClock } from "./credential.ts";

interface InitArguments extends Origins {
  name: string;
  slug: string | undefined;
  locale: string;
  home: string;
  /** The `--home` the caller passed, repeated in the printed next steps. */
  homeOption: string | undefined;
  waitMs: number;
  revealKey: boolean;
  /** `--owner-email`: issue the owner claim for this address once the inbox is live. */
  ownerEmail: string | undefined;
  /** `--no-claim`: issue no claim at all (CI, or a workspace a person owns). */
  noClaim: boolean;
  /** `--connect`: wait for a person to accept the claim before finishing. */
  connect: boolean;
  connectWaitMs: number;
}

export async function runInit(
  context: InitContext,
): Promise<Record<string, unknown>> {
  let step: FailureStep = "preflight";
  let resumable = false;
  try {
    return await execute(context, {
      setStep: (next) => {
        step = next;
      },
      markResumable: () => {
        resumable = true;
      },
    });
  } catch (error) {
    throw new InitStepError(step, resumable, error);
  }
}

interface Progress {
  setStep: (step: FailureStep) => void;
  markResumable: () => void;
}

async function execute(
  context: InitContext,
  progress: Progress,
): Promise<Record<string, unknown>> {
  const { clock, signal } = context;
  const args = parseInitArguments(context.options, context.env);
  const started = clock.now();
  const budget = started + args.waitMs;
  const statePath = join(args.home, STATE_FILE);
  const mcpPath = join(args.home, MCP_FILE);

  progress.setStep("state");
  const stored = await readState(statePath);
  // A stored credential belongs to the origin that issued it. Refusing the
  // mismatch here, before a client exists, is what keeps the token from ever
  // being offered to a different host.
  if (stored) assertPinnedOrigin(stored, args);
  const state: InitState = {
    ...stored,
    version: STATE_VERSION,
    origin: args.origin,
    onboardingUrl: args.onboardingUrl,
    apiUrl: args.apiUrl,
    gatewayUrl: args.gatewayUrl,
    warning: STATE_WARNING,
    updatedAt: new Date(started).toISOString(),
  };
  const save = async () => {
    state.updatedAt = new Date(clock.now()).toISOString();
    await writeState(args.home, statePath, state);
    progress.markResumable();
  };

  const steps: InitStep[] = [];
  let resumed = false;
  const ran = (value: InitStep) => steps.push(value);
  const skipped = () => {
    resumed = true;
  };

  const attempts = retries({ clock, signal, budget, rateLimited });
  const { challenged, request, sign } = attempts;

  const onboarding = new DaykeeperOnboardingClient({
    baseUrl: args.onboardingUrl,
    fetch: context.fetch,
    timeoutMs: context.timeoutMs,
  });
  const enrollAudience = `${args.onboardingUrl}/v1/machine-enrollments`;
  const rotationAudience = `${args.onboardingUrl}/v1/machine-credential-rotations`;

  // 2. Owner key. Generated once, never regenerated, never transmitted.
  let signer: DaykeeperMachineSigner;
  if (state.owner?.privateJwk) {
    progress.setStep("owner_key");
    try {
      signer = await DaykeeperMachineSigner.fromPrivateKey(
        state.owner.privateJwk,
      );
    } catch {
      throw new CliError(
        "STATE_UNREADABLE",
        "The stored machine owner key is not a usable P-256 private key.",
        ["home"],
      );
    }
    skipped();
  } else {
    progress.setStep("owner_key");
    signer = await DaykeeperMachineSigner.generate();
    state.owner = { privateJwk: await signer.exportPrivateKey() };
    await save();
    ran("owner_key");
  }
  const privateScalar = state.owner?.privateJwk.d;
  if (typeof privateScalar === "string") context.addSecret(privateScalar);

  // 3. Enroll. The intent is persisted before the first mutation is sent.
  // A home holds one workspace. A rerun with another --name resumes that
  // workspace; say so instead of silently ignoring the new name.
  const storedName = state.enrollment?.name;
  if (storedName !== undefined && storedName !== args.name)
    context.warn?.({
      code: "NAME_IGNORED_ON_RESUME",
      message: `This home already holds the workspace "${storedName}", so --name "${args.name}" was ignored. Use a different --home to create another workspace.`,
    });
  if (state.workspace) {
    skipped();
  } else {
    progress.setStep("enroll");
    const intent: MachineEnrollmentInput = {
      name: state.enrollment?.name ?? args.name,
      idempotencyKey:
        state.enrollment?.idempotencyKey ?? generateIdempotencyKey(),
      publicKey: signer.publicKey,
    };
    state.enrollment = {
      name: intent.name,
      idempotencyKey: intent.idempotencyKey,
    };
    await save();
    const result = await challenged(async () => {
      const challenge = await request(() =>
        onboarding.enrollments.challenge(intent),
      );
      const proof = await sign(() =>
        signer.signEnrollment(challenge, intent, { audience: enrollAudience }),
      );
      return onboarding.enrollments.create({
        challengeId: challenge.challengeId,
        proof,
      });
    });
    // Redaction starts the instant the credential arrives, not once it is
    // stored: an error rendered in between must not be able to print it.
    if (result.token) context.addSecret(result.token);
    state.workspace = {
      ownerId: result.ownerId,
      organizationId: result.organizationId,
      organizationSlug: result.organizationSlug,
    };
    state.credential = {
      id: result.credential.id,
      expiresAt: result.credential.expiresAt,
      token: result.token,
      rotationIntentId: null,
    };
    await save();
    ran("enroll");
  }

  // 4. Recover. A replayed enrollment never re-reveals its token, and a
  // credential inside its last day is replaced before it is used.
  const workspace = state.workspace;
  if (!workspace) {
    throw new CliError(
      "CREDENTIAL_UNRECOVERABLE",
      "The enrollment did not identify a machine owner.",
      ["credential"],
    );
  }
  if (needsRotation(state.credential, clock.now())) {
    progress.setStep("recover");
    await rotateCredential({
      state,
      ownerId: workspace.ownerId,
      signer,
      onboarding,
      rotationAudience,
      save,
      retries: attempts,
      addSecret: context.addSecret,
    });
    ran("recover");
  }

  const token = state.credential?.token;
  if (!token || !state.credential?.id) {
    throw new CliError(
      "CREDENTIAL_UNRECOVERABLE",
      "No usable machine credential could be recovered for this owner key.",
      ["credential"],
    );
  }
  context.addSecret(token);
  const client = new DaykeeperClient({
    baseUrl: args.apiUrl,
    apiKey: token,
    timeoutMs: context.timeoutMs,
    fetch: context.fetch,
  });

  // 5. Find or create the inbox. The Free plan allows exactly one tenant.
  const inbox = (): InboxState => {
    state.inbox ??= {
      tenantId: null,
      name: null,
      slug: null,
      slugAttempt: null,
      planId: null,
      planVersion: null,
      applyIdempotencyKey: null,
      operationId: null,
      activationIntent: null,
      provisionedAt: null,
    };
    return state.inbox;
  };
  if (inbox().tenantId) {
    skipped();
  } else {
    progress.setStep("inbox_apply");
    const tenants = await request(() => client.tenants.list());
    const adopted = tenants[0];
    if (adopted) {
      inbox().tenantId = adopted.id;
      inbox().name = adopted.spec.name;
      inbox().slug = adopted.spec.slug;
      await save();
      ran("inbox_adopt");
    } else {
      const base = deriveSlug(args.slug ?? args.name);
      let slug = inbox().slug ?? base;
      let applyKey = inbox().applyIdempotencyKey ?? generateIdempotencyKey();
      // The suffix counter is persisted with the slug, so a conflict followed
      // by a crash resumes at the next unused suffix instead of resending the
      // slug the server already refused.
      let attempt = inbox().slugAttempt ?? 0;
      for (;;) {
        inbox().name = args.name;
        inbox().slug = slug;
        inbox().slugAttempt = attempt;
        inbox().applyIdempotencyKey = applyKey;
        await save();
        let planId = inbox().planId ?? null;
        let planVersion = inbox().planVersion ?? null;
        if (planId === null || planVersion === null) {
          // Only a plan may answer that a slug is taken, and only a plan may be
          // replaced by a suffixed one. An apply failure propagates instead, so
          // its stored idempotency key is replayed rather than abandoned.
          try {
            const plan = await request(() =>
              client.tenants.plan({
                name: args.name,
                slug,
                locale: args.locale,
                inbox: { type: "api" },
              }),
            );
            planId = plan.id;
            planVersion = plan.version;
          } catch (error) {
            const next = attempt + 1;
            if (
              !isApiCode(error, "RESOURCE_CONFLICT") ||
              next >= MAX_SLUG_ATTEMPTS
            ) {
              throw error;
            }
            attempt = next;
            slug = suffixSlug(base, attempt + 1);
            applyKey = generateIdempotencyKey();
            continue;
          }
          inbox().planId = planId;
          inbox().planVersion = planVersion;
          await save();
        }
        const applied = await request(() =>
          client.tenants.apply(
            { planId, planVersion },
            { idempotencyKey: applyKey },
          ),
        );
        inbox().tenantId = applied.tenant.id;
        inbox().operationId = applied.operation.id;
        await save();
        ran("inbox_apply");
        break;
      }
    }
  }
  const tenantId = inbox().tenantId!;

  // 6. Wait. Bounded polling; a failed operation is never retried here.
  if (inbox().provisionedAt) {
    skipped();
  } else {
    progress.setStep("inbox_wait");
    for (;;) {
      const operation = await request(() =>
        client.tenants.getProvisioningOperation(tenantId),
      );
      inbox().operationId = operation.id;
      if (operation.state === "succeeded") {
        inbox().provisionedAt = new Date(clock.now()).toISOString();
        await save();
        ran("inbox_wait");
        break;
      }
      if (operation.state === "failed" || operation.state === "cancelled") {
        await save();
        throw new CliError(
          "PROVISIONING_FAILED",
          "Workspace provisioning did not succeed. Inspect the operation and retry it explicitly.",
          ["inbox_wait"],
          false,
          ["operations_retry"],
          { operationId: operation.id },
        );
      }
      if (clock.now() + POLL_INTERVAL_MS > budget) {
        await save();
        throw new CliError(
          "PROVISIONING_TIMEOUT",
          "Workspace provisioning did not finish inside the wait budget. Run init again to keep waiting.",
          ["inbox_wait", "wait-ms"],
          true,
          ["run_init_again"],
          { operationId: operation.id },
        );
      }
      await clock.sleep(POLL_INTERVAL_MS, signal);
    }
  }

  // 7. Activate. A succeeded operation alone does not enable traffic.
  progress.setStep("inbox_activate");
  let channel: InboxChannel = await request(() => client.inboxes.get(tenantId));
  // An inbox that already carries traffic needs no activation. That is a server
  // fact, not a persisted result, so it does not by itself mean `resumed`.
  if (!channel.trafficEnabled) {
    const activation = inbox().activationIntent ?? generateIdempotencyKey();
    inbox().activationIntent = activation;
    await save();
    try {
      await request(() =>
        client.inboxActivations.create(tenantId, {
          idempotencyKey: activation,
        }),
      );
    } catch (error) {
      if (isApiCode(error, "FEATURE_UNAVAILABLE"))
        throw activationUnavailable();
      throw error;
    }
    channel = await request(() => client.inboxes.get(tenantId));
    if (!channel.trafficEnabled) throw activationUnavailable();
    ran("inbox_activate");
  }

  // 8. Write the MCP configuration and print the result.
  progress.setStep("config");
  const literalKey = token;
  const printedKey = args.revealKey
    ? context.reveal(literalKey)
    : "<stored; rerun with --reveal-key>";
  const mcpKey = args.revealKey ? printedKey : "<stored; see configPath>";
  await writeSecureFile(
    args.home,
    mcpPath,
    `${JSON.stringify({ mcpServers: mcpServers(args.apiUrl, literalKey) }, null, 2)}\n`,
  );

  // The console only exists for the hosted origin; a self-hosted origin serves
  // its own, which this command cannot know.
  const consoleUrl = args.origin === HOSTED_ORIGIN ? HOSTED_CONSOLE_URL : null;
  const followUp = followUpFlags(args);
  const withFollowUp = (command: string) =>
    followUp ? `${command} ${followUp}` : command;

  // 9. Hand the workspace to its person. Every run ends with a way for the
  // agent's person to own the inbox: a claim for --owner-email, or otherwise
  // an open claim link that names nobody. The inbox is already live, so a
  // claim that cannot be issued is a note on a successful run, never a failed
  // init: `claim` can always issue it later.
  let ownerClaim: Record<string, unknown> | undefined;
  let handoff: ReturnType<typeof claimHandoff> | undefined;
  const claimEmail = args.ownerEmail ?? null;
  const claimCommand = withFollowUp(
    claimEmail === null
      ? `${CLI_INVOCATION} claim`
      : `${CLI_INVOCATION} claim --email ${claimEmail}`,
  );
  if (!args.noClaim) {
    progress.setStep("owner_claim");
    try {
      let issued = await currentClaim(claimEmail);
      let connected: boolean | undefined;
      if (args.connect && issued.claimUrl && !issued.owner) {
        const accepted = await waitForOwner(issued);
        connected = accepted !== null;
        if (accepted) issued = accepted;
        else
          context.warn?.({
            code: "OWNER_NOT_CONNECTED",
            message: `Nobody accepted the claim within ${Math.round(args.connectWaitMs / 1000)} seconds. The link still works until it expires; send it to the person this inbox is for.`,
          });
      }
      handoff = claimHandoff(issued, claimEmail, followUp, {
        inboxName: state.enrollment?.name ?? args.name,
      });
      ownerClaim = {
        ...issued,
        ...(connected === undefined ? {} : { connected }),
        handoff,
      };
    } catch (error) {
      const code =
        error instanceof DaykeeperApiError || error instanceof CliError
          ? error.code
          : "CLAIM_NOT_ISSUED";
      context.warn?.({
        code: "OWNER_CLAIM_NOT_ISSUED",
        message:
          claimEmail === null
            ? `The inbox is ready, but its claim link was not issued (${code}). Run: ${claimCommand}`
            : `The inbox is ready, but the owner claim for ${claimEmail} was not issued (${code}). Run: ${claimCommand}`,
      });
      ownerClaim = {
        email: claimEmail,
        open: claimEmail === null,
        issued: false,
        code,
      };
    }
  }

  return {
    workspaceId: workspace.organizationId,
    inboxId: tenantId,
    consoleUrl,
    // The message to relay to the agent's person, at the top so an agent
    // finds it without knowing anything about claims.
    ...(handoff ? { handoff } : {}),
    ...(ownerClaim ? { ownerClaim } : {}),
    nextSteps: [
      ...(ownerClaim?.claimUrl && !ownerClaim.owner
        ? [
            {
              action: "send_claim_link",
              description:
                claimEmail === null
                  ? "Give your person this link. Whoever opens it and signs in owns the inbox; until then customer messages reach only you."
                  : `Send this link to ${claimEmail}. They sign in with that address and own the inbox; until then customer messages reach only you.`,
              url: ownerClaim.claimUrl as string,
            },
          ]
        : []),
      ...(ownerClaim?.claimUrl || ownerClaim?.owner
        ? []
        : [
            {
              action: "claim_workspace",
              description:
                claimEmail === null
                  ? "Give your person owner access to this workspace. The command prints a link to send them; pass --email when you know their address."
                  : `Give ${claimEmail} owner access to this workspace. The command prints a link to send them.`,
              command: claimCommand,
            },
          ]),
      ...(consoleUrl
        ? [
            {
              action: "open_console",
              description: ownerClaim?.owner
                ? "The owner signs in here to open the inbox."
                : claimEmail === null
                  ? "After claiming, your person signs in here to open the inbox."
                  : "The person you claimed it for signs in here with that email address to open the inbox.",
              url: consoleUrl,
            },
          ]
        : []),
      {
        action: "run_commands",
        description:
          "Other commands use the stored credential, so nothing needs exporting.",
        command: withFollowUp(`${CLI_INVOCATION} tenants list`),
      },
    ],
    workspace: {
      organizationId: workspace.organizationId,
      slug: workspace.organizationSlug,
      name: state.enrollment?.name ?? args.name,
      plan: "free",
    },
    inbox: {
      tenantId,
      slug: inbox().slug,
      name: inbox().name,
      state: channel.state,
      trafficEnabled: channel.trafficEnabled,
    },
    credential: {
      id: state.credential.id,
      expiresAt: state.credential.expiresAt,
      storedAt: statePath,
    },
    endpoints: { apiUrl: args.apiUrl, gatewayUrl: args.gatewayUrl },
    sdk: {
      packages: {
        backend: `${SDK_PACKAGE}@${SDK_VERSION}`,
        reactNative: REACT_NATIVE_PACKAGE,
      },
      env: { DAYKEEPER_API_URL: args.apiUrl, DAYKEEPER_API_KEY: printedKey },
    },
    mcp: {
      configPath: mcpPath,
      mcpServers: mcpServers(args.apiUrl, mcpKey),
    },
    resumed,
    steps,
  };

  /**
   * The claim this run hands off: the one the state file already tracks, when
   * it is still usable or already accepted, or a new one.
   *
   * A rerun is how an agent recovers lost output, so it must end with a link
   * that works. A pending claim whose link this file kept is printed again; an
   * accepted one is reported with its owner; an open claim whose link was
   * never kept (a run interrupted at just the wrong moment) is replaced; and a
   * claim the server no longer lists (expired or revoked) gives way to a new
   * one. An addressed claim without a kept link is left as it is: its person
   * can sign in with that address and find it waiting.
   */
  async function currentClaim(email: string | null): Promise<IssuedClaim> {
    const key = email ?? OPEN_CLAIM_KEY;
    const record = state.claims?.[key];
    let reissue = false;
    if (record?.id) {
      const { items } = await request(() =>
        client.workspaceClaims.list({ includeOpen: true }),
      );
      const live = items.find((claim) => claim.id === record.id);
      if (!live || live.state === "revoked") {
        delete state.claims![key];
        await save();
      } else if (live.state === "accepted") {
        record.state = live.state;
        record.claimUrl = null;
        record.updatedAt = new Date().toISOString();
        await save();
        return {
          claim: live,
          claimUrl: null,
          replayed: true,
          emailed: false,
          nextActions: [],
          open: email === null,
          ...(live.email
            ? { owner: { email: live.email, acceptedAt: live.acceptedAt } }
            : {}),
        };
      } else if (record.claimUrl) {
        // Still pending and its link is kept: hand the same link out again.
        // Nothing needs sending, so a completed rerun stays read-only.
        return {
          claim: live,
          claimUrl: record.claimUrl,
          replayed: true,
          emailed: false,
          nextActions: [],
          open: email === null,
        };
      } else if (email === null) {
        reissue = true;
      }
    }
    return issueClaim(client, state, save, attempts, { email, reissue });
  }

  /**
   * `--connect`: show the link, open it when a person is at this terminal,
   * and wait for somebody to accept it. Polls the claim list every three
   * seconds; no new server protocol is involved. Null on timeout, or when the
   * claim stops being pending for any reason other than acceptance.
   */
  async function waitForOwner(
    issued: IssuedClaim,
  ): Promise<IssuedClaim | null> {
    const url = issued.claimUrl!;
    context.notify?.(
      `Open this link and sign in to own the inbox (waiting up to ${Math.round(args.connectWaitMs / 1000)} seconds):\n  ${url}\n`,
    );
    if (context.interactive && context.openUrl) {
      try {
        await context.openUrl(url);
      } catch {
        /* The link is printed; a browser that will not open is not a failure. */
      }
    }
    const deadline = clock.now() + args.connectWaitMs;
    while (clock.now() < deadline) {
      await clock.sleep(
        Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - clock.now())),
        signal,
      );
      const { items } = await request(() =>
        client.workspaceClaims.list({ includeOpen: true }),
      );
      const live = items.find((claim) => claim.id === issued.claim.id);
      if (live?.state === "accepted") {
        const key = issued.open ? OPEN_CLAIM_KEY : live.email!;
        const record = state.claims?.[key];
        if (record) {
          record.state = "accepted";
          record.claimUrl = null;
          record.updatedAt = new Date().toISOString();
          await save();
        }
        return {
          ...issued,
          claim: live,
          claimUrl: null,
          nextActions: [],
          ...(live.email
            ? { owner: { email: live.email, acceptedAt: live.acceptedAt } }
            : {}),
        };
      }
      if (!live || live.state !== "pending") return null;
    }
    return null;
  }

  function activationUnavailable() {
    return new CliError(
      "ACTIVATION_UNAVAILABLE",
      "Inbox activation is not available yet. The workspace is saved; run init again once activation is wired.",
      ["inbox_activate"],
      true,
      ["run_init_again"],
    );
  }
}

function mcpServers(apiUrl: string, key: string) {
  return {
    daykeeper: {
      command: "npx",
      args: ["--yes", MCP_PACKAGE],
      env: {
        DAYKEEPER_API_URL: apiUrl,
        DAYKEEPER_API_KEY: key,
        DAYKEEPER_MCP_ENABLE_PLANNING: "true",
        DAYKEEPER_MCP_ENABLE_MUTATIONS: "true",
        DAYKEEPER_MCP_ENABLE_INBOX_TOOLS: "true",
        DAYKEEPER_MCP_ENABLE_ACTIVATION_TOOLS: "true",
        DAYKEEPER_MCP_ENABLE_OPERATOR_TOOLS: "true",
        DAYKEEPER_MCP_ENABLE_CLAIM_TOOLS: "true",
      },
    },
  };
}

function rateLimited(): CliError {
  return new CliError(
    "RATE_LIMITED",
    "Daykeeper rate-limited the request and the wait would outlast this run's budget. Run init again to resume.",
    ["wait-ms"],
    true,
    ["run_init_again"],
  );
}

export function deriveSlug(source: string): string {
  const slug = source
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return SLUG_PATTERN.test(slug) ? slug : "inbox";
}

export function suffixSlug(base: string, index: number): string {
  const suffix = `-${index}`;
  const trimmed = base.slice(0, 63 - suffix.length).replace(/-+$/g, "");
  const slug = `${trimmed || "inbox"}${suffix}`;
  return SLUG_PATTERN.test(slug) ? slug : `inbox${suffix}`;
}

function parseInitArguments(
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): InitArguments {
  const text = (value: string | boolean | undefined) =>
    typeof value === "string" && value !== "" ? value : undefined;

  const name = (text(options.name) ?? "").trim();
  if (name.length < 2 || name.length > 120) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "The workspace name must contain 2–120 characters after trimming.",
      ["name"],
    );
  }
  const plan = text(options.plan) ?? "free";
  if (plan !== "free") {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Only the free plan is available today.",
      ["plan"],
    );
  }
  const slug = text(options.slug);
  if (slug !== undefined && !SLUG_PATTERN.test(slug)) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "A slug must contain 1–63 lowercase letters, digits, and internal hyphens.",
      ["slug"],
    );
  }
  const locale = text(options.locale) ?? "en";
  if (locale.length < 2 || locale.length > 35) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "A locale tag must contain 2–35 characters.",
      ["locale"],
    );
  }
  const waitValue = text(options["wait-ms"]) ?? String(DEFAULT_WAIT_MS);
  const waitMs = Number(waitValue);
  if (
    !/^[1-9][0-9]*$/.test(waitValue) ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < MIN_WAIT_MS ||
    waitMs > MAX_WAIT_MS
  ) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "The provisioning wait must be 10000–900000 milliseconds.",
      ["wait-ms"],
    );
  }

  const ownerEmailValue = text(options["owner-email"]);
  const ownerEmail =
    ownerEmailValue === undefined
      ? undefined
      : emailAddress(ownerEmailValue, "owner-email");
  const noClaim = options["no-claim"] === true;
  const connect = options.connect === true;
  if (noClaim && (connect || ownerEmail !== undefined)) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "--no-claim issues no claim, so it cannot be combined with --owner-email or --connect.",
      ["no-claim"],
    );
  }
  const connectValue =
    text(options["connect-wait-ms"]) ?? String(DEFAULT_CONNECT_WAIT_MS);
  const connectWaitMs = Number(connectValue);
  if (
    !/^[1-9][0-9]*$/.test(connectValue) ||
    !Number.isSafeInteger(connectWaitMs) ||
    connectWaitMs < MIN_WAIT_MS ||
    connectWaitMs > MAX_WAIT_MS
  ) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "The connect wait must be 10000–900000 milliseconds.",
      ["connect-wait-ms"],
    );
  }
  if (options["connect-wait-ms"] !== undefined && !connect) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "--connect-wait-ms only applies with --connect.",
      ["connect-wait-ms"],
    );
  }
  return {
    name,
    slug,
    locale,
    ownerEmail,
    noClaim,
    connect,
    connectWaitMs,
    home: resolveHome(text(options.home), env),
    homeOption: text(options.home),
    waitMs,
    revealKey: options["reveal-key"] === true,
    ...resolveOrigins(options, env),
  };
}
