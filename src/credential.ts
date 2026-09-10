import { randomUUID } from "node:crypto";
import {
  DaykeeperApiError,
  DaykeeperMachineSigner,
  DaykeeperOnboardingApiError,
  DaykeeperOnboardingClient,
  type MachineRotationInput,
} from "@skyporch/daykeeper";
import { CliError } from "./errors.ts";
import type { CredentialState, InitState } from "./state.ts";

const DEFAULT_RETRY_AFTER_MS = 3000;
const MAX_RETRY_AFTER_MS = 60000;
const MAX_RATE_LIMIT_RETRIES = 5;
/** A delay the server never stated is a guess, so it is retried far less. */
const MAX_FIXED_RATE_LIMIT_RETRIES = 2;
const MAX_ROTATION_ATTEMPTS = 3;
export const CREDENTIAL_REFRESH_MS = 24 * 60 * 60 * 1000;
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Test seam for bounded polling and rate-limit waits. */
export interface Clock {
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      function abort() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener("abort", abort, { once: true });
    }),
};

export interface Retries {
  guard: () => void;
  request: <Value>(send: () => Promise<Value>) => Promise<Value>;
  challenged: <Value>(send: () => Promise<Value>) => Promise<Value>;
  sign: (produce: () => Promise<string>) => Promise<string>;
}

/**
 * The bounded rate-limit behavior every stateful command shares. `request`
 * waits out a 429 without ever passing the run's budget; `challenged` wraps a
 * challenge-bound mutation, whose single-use proof cannot be replayed, so the
 * whole challenge-and-sign pair is repeated instead.
 */
export function retries(options: {
  clock: Clock;
  signal: AbortSignal;
  /** Absolute time this run stops waiting, in `clock.now()` milliseconds. */
  budget: number;
  /** The refusal a challenge-bound wait raises when it would outlast the budget. */
  rateLimited: () => CliError;
}): Retries {
  const { budget, clock, signal } = options;
  const guard = () => {
    if (signal.aborted) throw signal.reason;
  };
  const request = async <Value>(send: () => Promise<Value>): Promise<Value> => {
    let guessed = 0;
    for (let attempt = 0; ; attempt += 1) {
      guard();
      try {
        return await send();
      } catch (error) {
        const limit = rateLimitDelay(error);
        if (limit === undefined) throw error;
        if (!limit.projected) guessed += 1;
        if (
          attempt >= MAX_RATE_LIMIT_RETRIES ||
          guessed > MAX_FIXED_RATE_LIMIT_RETRIES ||
          clock.now() + limit.delayMs > budget
        ) {
          throw error;
        }
        await clock.sleep(limit.delayMs, signal);
      }
    }
  };
  /**
   * A challenge-bound mutation cannot be replayed after a 429: the proof is
   * single-use and expires in a minute, so resending it would fail as an
   * invalid challenge. Wait out the delay, then challenge and sign again. A
   * delay that would outlast the run's budget refuses instead of sleeping.
   */
  const challenged = async <Value>(
    send: () => Promise<Value>,
  ): Promise<Value> => {
    for (let attempt = 0; ; attempt += 1) {
      guard();
      try {
        return await send();
      } catch (error) {
        const limit = rateLimitDelay(error);
        if (limit === undefined) throw error;
        if (
          attempt >= MAX_RATE_LIMIT_RETRIES ||
          clock.now() + limit.delayMs > budget
        ) {
          throw options.rateLimited();
        }
        await clock.sleep(limit.delayMs, signal);
      }
    }
  };
  const sign = async (produce: () => Promise<string>): Promise<string> => {
    try {
      return await produce();
    } catch {
      throw new CliError(
        "INVALID_CONFIGURATION",
        "The machine ownership proof could not be produced. The onboarding origin must be a canonical HTTPS URL.",
        ["onboarding-url"],
      );
    }
  };
  return { guard, request, challenged, sign };
}

export interface RotationContext {
  /** Mutated in place; `save` persists it between attempts. */
  state: InitState;
  ownerId: string;
  signer: DaykeeperMachineSigner;
  onboarding: DaykeeperOnboardingClient;
  rotationAudience: string;
  save: () => Promise<void>;
  retries: Retries;
  /** Redact this value from every printed envelope. */
  addSecret: (secret: string) => void;
}

/**
 * Replace a lost or expiring credential. The rotation intent is stored, so a
 * crashed run replays it instead of minting a second credential; a replay that
 * cannot re-reveal its token is retried under one fresh intent.
 */
export async function rotateCredential(
  context: RotationContext,
): Promise<void> {
  const { addSecret, onboarding, ownerId, save, signer, state } = context;
  const { challenged, request, sign } = context.retries;
  let expected = state.credential?.id ?? null;
  if (!expected) expected = (await currentCredential(NIL_UUID)).credentialId;
  for (let attempt = 1; ; attempt += 1) {
    const intentId = state.credential?.rotationIntentId ?? randomUUID();
    state.credential = {
      ...(state.credential ?? emptyCredential()),
      id: expected,
      rotationIntentId: intentId,
    };
    await save();
    const input: MachineRotationInput = {
      ownerId,
      expectedCredentialId: expected,
      intentId,
    };
    let result;
    try {
      result = await challenged(async () => {
        const challenge = await request(() =>
          onboarding.credentialRotations.challenge(input),
        );
        const proof = await sign(() =>
          signer.signRotation(challenge, input, {
            audience: context.rotationAudience,
          }),
        );
        return onboarding.credentialRotations.create({
          challengeId: challenge.challengeId,
          proof,
        });
      });
    } catch (error) {
      if (
        attempt < MAX_ROTATION_ATTEMPTS &&
        isApiCode(error, "RESOURCE_VERSION_CONFLICT")
      ) {
        expected = (await currentCredential(expected)).credentialId;
        continue;
      }
      throw error;
    }
    // As with enrollment, the credential is redacted the moment it arrives.
    if (result.token) addSecret(result.token);
    if (result.token === null) {
      if (attempt >= MAX_ROTATION_ATTEMPTS) {
        throw new CliError(
          "CREDENTIAL_UNRECOVERABLE",
          "The stored rotation was already applied and its credential cannot be revealed again.",
          ["credential"],
        );
      }
      expected = result.credentialId;
      state.credential = {
        ...(state.credential ?? emptyCredential()),
        rotationIntentId: null,
      };
      await save();
      continue;
    }
    state.credential = {
      id: result.credentialId,
      expiresAt: result.expiresAt,
      token: result.token,
      rotationIntentId: null,
    };
    await save();
    return;
  }

  /** Read the owner's real current credential id with a fresh, throwaway proof. */
  async function currentCredential(probe: string) {
    const input: MachineRotationInput = {
      ownerId,
      expectedCredentialId: probe,
      intentId: randomUUID(),
    };
    return challenged(async () => {
      const challenge = await request(() =>
        onboarding.credentialRotations.challenge(input),
      );
      const proof = await sign(() =>
        signer.signRotation(challenge, input, {
          audience: context.rotationAudience,
        }),
      );
      return onboarding.credentialRotations.current({
        challengeId: challenge.challengeId,
        proof,
      });
    });
  }
}

export function emptyCredential(): CredentialState {
  return { id: null, expiresAt: null, token: null, rotationIntentId: null };
}

export function needsRotation(
  credential: CredentialState | undefined,
  now: number,
): boolean {
  if (!credential?.token || !credential.id) return true;
  const expiry = Date.parse(credential.expiresAt ?? "");
  return !Number.isFinite(expiry) || expiry - now <= CREDENTIAL_REFRESH_MS;
}

interface RateLimit {
  delayMs: number;
  /** True when the server itself stated the delay through `Retry-After`. */
  projected: boolean;
}

function rateLimitDelay(error: unknown): RateLimit | undefined {
  if (error instanceof DaykeeperOnboardingApiError && error.status === 429) {
    const seconds = error.retryAfterSeconds;
    const requested =
      seconds === undefined ? DEFAULT_RETRY_AFTER_MS : seconds * 1000;
    return {
      delayMs: Math.min(Math.max(requested, 0), MAX_RETRY_AFTER_MS),
      projected: seconds !== undefined,
    };
  }
  // The management SDK does not project Retry-After, so a fixed delay is used.
  if (error instanceof DaykeeperApiError && error.status === 429)
    return { delayMs: DEFAULT_RETRY_AFTER_MS, projected: false };
  return undefined;
}

export function isApiCode(error: unknown, code: string): boolean {
  return error instanceof DaykeeperApiError && error.code === code;
}
