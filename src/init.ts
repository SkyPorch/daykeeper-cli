import { join } from "node:path";
import {
  DaykeeperClient,
  DaykeeperMachineSigner,
  DaykeeperOnboardingClient,
  generateIdempotencyKey,
  type InboxChannel,
  type MachineEnrollmentInput,
} from "@skyporch/daykeeper";
import {
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
import { CliError } from "./errors.ts";
import { assertPinnedOrigin, resolveOrigins, type Origins } from "./origins.ts";
import {
  MCP_FILE,
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
type FailureStep = InitStep | "preflight" | "state" | "config";

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
}

export { realClock } from "./credential.ts";

interface InitArguments extends Origins {
  name: string;
  slug: string | undefined;
  locale: string;
  home: string;
  waitMs: number;
  revealKey: boolean;
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

  return {
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

  return {
    name,
    slug,
    locale,
    home: resolveHome(text(options.home), env),
    waitMs,
    revealKey: options["reveal-key"] === true,
    ...resolveOrigins(options, env),
  };
}
