import { join } from "node:path";
import {
  DaykeeperMachineSigner,
  DaykeeperOnboardingClient,
} from "@skyporch/daykeeper";
import {
  needsRotation,
  retries,
  rotateCredential,
  type Clock,
  type Retries,
} from "./credential.ts";
import { CliError } from "./errors.ts";
import { assertPinnedOrigin, type Origins } from "./origins.ts";
import {
  STATE_FILE,
  STATE_VERSION,
  readState,
  writeState,
  type InitState,
} from "./state.ts";

export interface StoredCredentialContext {
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  timeoutMs: number;
  clock: Clock;
  /** Redact this value from every printed envelope. */
  addSecret: (secret: string) => void;
}

export interface StoredCredentialOptions {
  home: string;
  /** Resolved only once a state file exists, so a missing one is reported first. */
  origins: () => Origins;
  /** How long rate-limit waits during a rotation may run, in milliseconds. */
  waitMs: number;
  /** The refusal a rotation raises when a rate-limit wait would outlast `waitMs`. */
  rateLimited: () => CliError;
  /** The refusal for a missing state file. */
  missing: () => CliError;
  /** The message for a state file with no enrolled workspace. */
  unenrolled: string;
}

export interface StoredCredential {
  /** The loaded state, mutated in place by rotations; `save` persists it. */
  state: InitState;
  save: () => Promise<void>;
  retries: Retries;
  token: string;
  rotated: boolean;
  origins: Origins;
}

/**
 * Load the credential `init` stored and make it usable. The origin pin is
 * checked before any client exists, so the token is never offered to a host
 * that did not issue it. A credential inside its last day is replaced through
 * the same rotation `init` uses before it is returned.
 */
export async function openStoredCredential(
  context: StoredCredentialContext,
  options: StoredCredentialOptions,
): Promise<StoredCredential> {
  const statePath = join(options.home, STATE_FILE);
  const stored = await readState(statePath);
  if (!stored) throw options.missing();
  const origins = options.origins();
  assertPinnedOrigin(stored, origins);
  if (!stored.owner?.privateJwk || !stored.workspace) {
    throw initRequired(options.unenrolled);
  }

  const state: InitState = { ...stored, version: STATE_VERSION };
  const workspace = state.workspace!;
  const save = async () => {
    state.updatedAt = new Date(context.clock.now()).toISOString();
    await writeState(options.home, statePath, state);
  };

  let signer: DaykeeperMachineSigner;
  try {
    signer = await DaykeeperMachineSigner.fromPrivateKey(
      state.owner!.privateJwk,
    );
  } catch {
    throw new CliError(
      "STATE_UNREADABLE",
      "The stored machine owner key is not a usable P-256 private key.",
      ["home"],
    );
  }
  const privateScalar = state.owner!.privateJwk.d;
  if (typeof privateScalar === "string") context.addSecret(privateScalar);
  const existing = state.credential?.token;
  if (existing) context.addSecret(existing);

  const attempts = retries({
    clock: context.clock,
    signal: context.signal,
    budget: context.clock.now() + options.waitMs,
    rateLimited: options.rateLimited,
  });

  let rotated = false;
  if (needsRotation(state.credential, context.clock.now())) {
    const { onboardingUrl } = origins;
    await rotateCredential({
      state,
      ownerId: workspace.ownerId,
      signer,
      onboarding: new DaykeeperOnboardingClient({
        baseUrl: onboardingUrl,
        fetch: context.fetch,
        timeoutMs: context.timeoutMs,
      }),
      rotationAudience: `${onboardingUrl}/v1/machine-credential-rotations`,
      save,
      retries: attempts,
      addSecret: context.addSecret,
    });
    rotated = true;
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
  return { state, save, retries: attempts, token, rotated, origins };
}

export function initRequired(message: string): CliError {
  return new CliError("INIT_REQUIRED", message, ["home"], false, ["run_init"]);
}
