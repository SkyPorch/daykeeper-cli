import { randomUUID } from "node:crypto";
import { DaykeeperClient } from "@skyporch/daykeeper";
import { join } from "node:path";
import {
  CLI_VERSION,
  ENVELOPE_VERSION,
  HOSTED_ORIGIN,
  MAX_TOKEN_BYTES,
  SDK_VERSION,
} from "./constants.ts";
import { runClaim, type ClaimContext } from "./claim.ts";
import {
  STATEFUL_COMMANDS,
  commandCatalog,
  dispatch,
  parseCommand,
  type ParsedCommand,
} from "./commands.ts";
import { CliError, errorEnvelope, reportedOutcomeUnknown } from "./errors.ts";
import { InitStepError, realClock, runInit, type InitClock } from "./init.ts";
import { renderInitText } from "./human.ts";
import { resolveOrigins } from "./origins.ts";
import { STATE_FILE, readState, resolveHome, type InitState } from "./state.ts";
import { openStoredCredential } from "./stored.ts";

/** Server admission codes that only the Daykeeper operator can lift. */
const OPERATOR_GATED_CODES = new Set([
  "BOOTSTRAP_LIMIT_REACHED",
  "BOOTSTRAP_UNAVAILABLE",
]);
import { readBounded, readJsonInput, type InputStream } from "./io.ts";
import { positiveInteger, validateInput } from "./schemas.ts";

export { CLI_VERSION, ENVELOPE_VERSION, SDK_VERSION } from "./constants.ts";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdin: InputStream;
  write: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Test seam for `init`'s bounded polling and rate-limit waits. */
  clock?: InitClock;
  /**
   * True when stdout is a terminal. `init` then prints readable text unless
   * `--json` is passed; every other caller gets the JSON envelope.
   */
  interactive?: boolean;
}

/** The canonical credential variable and its deprecated alias. */
const API_KEY_VARIABLE = "DAYKEEPER_API_KEY";
const LEGACY_TOKEN_VARIABLE = "DAYKEEPER_ACCESS_TOKEN";

interface SuppliedKey {
  value: string;
  variable: typeof API_KEY_VARIABLE | typeof LEGACY_TOKEN_VARIABLE;
}

/**
 * Read the credential supplied through the environment. `DAYKEEPER_API_KEY`
 * is canonical; `DAYKEEPER_ACCESS_TOKEN` is still accepted as a deprecated
 * alias. Two different values are refused rather than ranked.
 */
function suppliedKey(
  env: Readonly<Record<string, string | undefined>>,
): SuppliedKey | undefined {
  const canonical = env[API_KEY_VARIABLE] || undefined;
  const legacy = env[LEGACY_TOKEN_VARIABLE] || undefined;
  if (canonical && legacy && canonical !== legacy)
    throw new CliError(
      "AUTH_SOURCE_CONFLICT",
      "DAYKEEPER_API_KEY and DAYKEEPER_ACCESS_TOKEN hold different values. Set only DAYKEEPER_API_KEY.",
      [API_KEY_VARIABLE, LEGACY_TOKEN_VARIABLE],
    );
  if (canonical) return { value: canonical, variable: API_KEY_VARIABLE };
  if (legacy) return { value: legacy, variable: LEGACY_TOKEN_VARIABLE };
  return undefined;
}

export async function runCli(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  let parsed: ParsedCommand | undefined;
  let requestSent = false;
  let exitCode = 0;
  const secrets: string[] = [];
  const revealed = new Map<string, string>();
  for (const variable of [API_KEY_VARIABLE, LEGACY_TOKEN_VARIABLE]) {
    const value = context.env[variable];
    if (value && value.length >= 20) secrets.push(value);
  }
  const warnings: { code: string; message: string }[] = [];
  if (context.env[LEGACY_TOKEN_VARIABLE] && !context.env[API_KEY_VARIABLE])
    warnings.push({
      code: "DEPRECATED_ENVIRONMENT_VARIABLE",
      message:
        "DAYKEEPER_ACCESS_TOKEN is deprecated. Set DAYKEEPER_API_KEY instead.",
    });
  let cleanup = () => {};
  let controller: AbortController | undefined;
  let initFailure: InitStepError | undefined;
  let envelope: Record<string, unknown>;
  try {
    parsed = parseCommand(args);
    if (parsed.help || parsed.version) {
      envelope = {
        schemaVersion: ENVELOPE_VERSION,
        ok: true,
        command: parsed.version ? "version" : "help",
        data: {
          name: "@skyporch/daykeeper-cli",
          version: CLI_VERSION,
          sdkVersion: SDK_VERSION,
          ...(parsed.help
            ? {
                output:
                  "One JSON envelope on stdout. init run at a terminal without --json prints readable text instead. No interactive prompts.",
                authentication:
                  "Commands use the credential init stored in <home>/credentials.json against the origin that issued it (https://api.mydaykeeper.com by default). DAYKEEPER_API_KEY or --token-stdin overrides it; use at most one of them. DAYKEEPER_ACCESS_TOKEN is a deprecated alias for DAYKEEPER_API_KEY. The server enforces scopes and tenant access. init and claim always run under the stored credential and refuse a different supplied one.",
                globalOptions: [
                  "--base-url",
                  "--home",
                  "--timeout-ms",
                  "--token-stdin",
                  "--json",
                  "--help",
                ],
                commands: commandCatalog().filter(
                  (command) =>
                    !parsed?.command || command.name === parsed.command.name,
                ),
              }
            : {}),
        },
      };
    } else if (STATEFUL_COMMANDS.has(parsed.command?.name ?? "")) {
      // These commands carry their own credential, so they never run under a
      // supplied token, and their own wait budget bounds the run instead of
      // one deadline.
      const name = parsed.command!.name;
      const supplied = suppliedKey(context.env);
      // A supplied key is only tolerated when it is the stored credential
      // itself, as it is after exporting the DAYKEEPER_API_KEY init printed.
      if (
        supplied &&
        supplied.value !== (await storedToken(parsed.options, context.env))
      )
        throw new CliError(
          "INVALID_ARGUMENT",
          name === "init"
            ? `init creates and stores its own credential; unset ${supplied.variable} before running it.`
            : `claim uses the credential init stored; unset ${supplied.variable} before running it.`,
          [supplied.variable],
        );
      const timeoutMs = requestTimeoutMs(parsed.options, context.env);
      const transport = context.fetch ?? globalThis.fetch;
      const signal = context.signal ?? new AbortController().signal;
      const stateful: ClaimContext = {
        options: parsed.options,
        env: context.env,
        timeoutMs,
        signal,
        clock: context.clock ?? realClock,
        fetch: (url, options) => {
          if (signal.aborted) throw signal.reason;
          requestSent = true;
          return transport(url, {
            ...options,
            signal: linkSignals(options?.signal ?? undefined, signal),
            redirect: "error",
            credentials: "omit",
          });
        },
        addSecret: (secret) => {
          if (secret) secrets.push(secret);
        },
      };
      const data =
        name === "init"
          ? await runInit({
              ...stateful,
              reveal: (secret) => {
                const placeholder = `daykeeper-cli-revealed-${randomUUID()}`;
                revealed.set(placeholder, secret);
                return placeholder;
              },
            }).catch((error: unknown) => {
              if (error instanceof InitStepError) {
                initFailure = error;
                throw error.failure;
              }
              throw error;
            })
          : await runClaim(
              stateful,
              name === "claim status" ? "status" : "create",
            );
      envelope = {
        schemaVersion: ENVELOPE_VERSION,
        ok: true,
        command: name,
        data,
      };
    } else {
      const timeoutMs = requestTimeoutMs(parsed.options, context.env);
      const supplied = suppliedKey(context.env);
      if (parsed.options["token-stdin"] && supplied)
        throw new CliError(
          "AUTH_SOURCE_CONFLICT",
          `Use either ${supplied.variable} or --token-stdin, not both.`,
        );
      // With no supplied credential, the one init stored is used against the
      // origins it was issued for. A supplied one is routed by
      // `suppliedCredentialUrl` once it has been read.
      const explicitBaseUrl =
        textOption(parsed.options["base-url"]) ??
        (context.env.DAYKEEPER_API_URL || undefined);

      controller = new AbortController();
      const active = controller;
      const deadline = performance.now() + timeoutMs;
      const timeoutError = () =>
        new CliError(
          "REQUEST_TIMEOUT",
          "The command exceeded its input and request deadline.",
          [],
          true,
        );
      const timer = setTimeout(() => active.abort(timeoutError()), timeoutMs);
      const cancel = () =>
        active.abort(
          new CliError(
            "REQUEST_ABORTED",
            "The command was cancelled. Cancellation does not undo accepted work.",
          ),
        );
      context.signal?.addEventListener("abort", cancel, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", cancel);
      };
      if (context.signal?.aborted) cancel();
      const assertActive = () => {
        if (!active.signal.aborted && performance.now() >= deadline)
          active.abort(timeoutError());
        if (active.signal.aborted) throw active.signal.reason;
      };
      assertActive();
      const command = parsed;
      const transport = context.fetch ?? globalThis.fetch;
      const task = async () => {
        let baseUrl = explicitBaseUrl ?? HOSTED_ORIGIN;
        const token = command.options["token-stdin"]
          ? (
              await readBounded(
                context.stdin,
                MAX_TOKEN_BYTES + 2,
                active.signal,
              )
            ).trim()
          : supplied
            ? supplied.value
            : await storedCredential();
        async function storedCredential(): Promise<string> {
          const stored = await openStoredCredential(
            {
              // A rotation is not the command's own request, so it
              // never marks the command's mutation as sent.
              fetch: (url, options) => {
                assertActive();
                return transport(url, {
                  ...options,
                  signal: linkSignals(
                    options?.signal ?? undefined,
                    active.signal,
                  ),
                  redirect: "error",
                  credentials: "omit",
                });
              },
              signal: active.signal,
              timeoutMs,
              clock: context.clock ?? realClock,
              addSecret: (secret) => {
                if (secret) secrets.push(secret);
              },
            },
            {
              home: resolveHome(textOption(command.options.home), context.env),
              origins: () => resolveOrigins(command.options, context.env),
              waitMs: timeoutMs,
              rateLimited: () =>
                new CliError(
                  "RATE_LIMITED",
                  "Daykeeper rate-limited the credential refresh. Run the command again.",
                  [],
                  true,
                ),
              missing: () =>
                new CliError(
                  "AUTH_REQUIRED",
                  "No Daykeeper credential was found. Run init to create one, or supply DAYKEEPER_API_KEY or --token-stdin.",
                  ["home"],
                  false,
                  ["run_init"],
                ),
              unenrolled:
                "The Daykeeper state file has no enrolled workspace. Run init again, or supply DAYKEEPER_API_KEY or --token-stdin.",
            },
          );
          // The stored credential only ever talks to the API that issued it.
          baseUrl = stored.origins.apiUrl;
          return stored.token;
        }
        if (
          token.length < 20 ||
          token.length > MAX_TOKEN_BYTES ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
        ) {
          throw new CliError(
            "INVALID_ACCESS_TOKEN",
            "Access tokens must contain 20–16384 bearer-token characters. No token was logged.",
          );
        }
        secrets.push(token);
        if (command.options["token-stdin"] || supplied)
          baseUrl = await suppliedCredentialUrl(
            token,
            explicitBaseUrl,
            command.options,
            context.env,
          );
        const input = command.command?.input
          ? validateInput(
              command.command.input,
              await readJsonInput(
                String(command.options.input),
                context.stdin,
                active.signal,
              ),
            )
          : undefined;
        assertActive();
        const fetch: typeof globalThis.fetch = async (url, options) => {
          assertActive();
          requestSent = true;
          const pending = transport(url, {
            ...options,
            signal: active.signal,
            redirect: "error",
            credentials: "omit",
          });
          void pending.then(
            (response) => {
              if (active.signal.aborted)
                void response.body?.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          const response = await abortable(pending, active.signal);
          const body = response.body?.pipeThrough(new TransformStream(), {
            signal: active.signal,
          });
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        };
        const client = new DaykeeperClient({
          baseUrl,
          token,
          timeoutMs,
          fetch,
        });
        const data = await dispatch(client, command, input);
        assertActive();
        return data;
      };
      const data = await abortable(task(), active.signal);
      envelope = {
        schemaVersion: ENVELOPE_VERSION,
        ok: true,
        command: parsed.command!.name,
        data,
      };
    }
  } catch (error) {
    exitCode = 1;
    const actual = controller?.signal.aborted
      ? controller.signal.reason
      : error;
    const projected = errorEnvelope(actual, secrets);
    // `init` reports the step it reached, and says a rerun resumes whenever
    // the state file already carries the work that was completed.
    // Admission refusals are the operator's to lift: a rerun cannot change
    // them, so they never suggest one.
    const operatorGated =
      initFailure !== undefined &&
      OPERATOR_GATED_CODES.has(String(projected.code));
    const details = initFailure
      ? {
          ...projected,
          ...(operatorGated
            ? {
                message:
                  "Daykeeper is not admitting new agent workspaces right now. Ask the Daykeeper operator to raise the signup admission budget, then run init again.",
              }
            : {}),
          fields: [...new Set([...projected.fields, initFailure.step])],
          nextActions: operatorGated
            ? ["contact_daykeeper_operator"]
            : [
                ...new Set([
                  ...projected.nextActions,
                  ...(initFailure.resumable ? ["run_init_again"] : []),
                ]),
              ],
        }
      : projected;
    const uncertainMutation =
      parsed?.command?.name === "init"
        ? // One `init` sends both reads and mutations, so only the SDK's own
          // per-request signal says whether a mutation was left uncertain.
          reportedOutcomeUnknown(actual)
        : requestSent &&
          parsed?.command?.effect !== "read" &&
          (details.kind === "transport" ||
            details.code === "REQUEST_TIMEOUT" ||
            details.code === "REQUEST_ABORTED" ||
            ("status" in details &&
              typeof details.status === "number" &&
              details.status >= 500));
    envelope = {
      schemaVersion: ENVELOPE_VERSION,
      ok: false,
      command: parsed?.command?.name ?? null,
      error: {
        ...details,
        ...(uncertainMutation
          ? {
              mutationOutcome: "unknown",
              nextActions: [
                ...new Set([
                  ...details.nextActions,
                  ...(parsed?.command?.name === "init"
                    ? ["run_init_again"]
                    : parsed?.command?.name === "claim"
                      ? // A claim keeps its stored idempotency key, so the
                        // rerun replays it; `claim status` says what landed.
                        ["run_claim_status", "reuse_original_idempotency_key"]
                      : parsed?.command?.name.endsWith(" apply")
                        ? [
                            "inspect_operation_before_retry",
                            "reuse_original_idempotency_key",
                          ]
                        : ["inspect_resource_before_retry"]),
                ]),
              ],
            }
          : {}),
      },
    };
  } finally {
    cleanup();
    if (controller && !controller.signal.aborted) {
      controller.abort(
        new CliError("REQUEST_ABORTED", "The command has finished."),
      );
    }
  }
  if (warnings.length) envelope = { ...envelope, warnings };
  let output = JSON.stringify(envelope);
  for (const secret of new Set(secrets)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped) output = output.split(escaped).join("[REDACTED]");
  }
  // Redaction runs first and unconditionally. `--reveal-key` then restores the
  // one value the caller explicitly asked to see, and nothing else.
  for (const [placeholder, secret] of revealed) {
    output = output
      .split(placeholder)
      .join(JSON.stringify(secret).slice(1, -1));
  }
  if (
    context.interactive &&
    parsed?.command?.name === "init" &&
    parsed.options.json !== true
  ) {
    // Rendered from the already-redacted envelope, so text mode can never
    // print more than JSON mode would.
    context.write(renderInitText(JSON.parse(output)));
    return exitCode;
  }
  context.write(`${output}\n`);
  return exitCode;
}

function textOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Where a supplied credential may be sent. An explicit URL wins, except that
 * the stored credential itself is never sent anywhere but the origin that
 * issued it. Without an explicit URL, the stored credential goes to its own
 * origin, and any other key goes to the hosted API only when no state file
 * pins this machine to a different origin; otherwise an explicit URL is
 * required rather than guessing.
 */
async function suppliedCredentialUrl(
  token: string,
  explicit: string | undefined,
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  let state: InitState | undefined;
  let unreadable = false;
  try {
    state = await readState(
      join(resolveHome(textOption(options.home), env), STATE_FILE),
    );
  } catch {
    unreadable = true;
  }
  const isStored = state?.credential?.token === token;
  if (explicit !== undefined) {
    if (isStored && urlOrigin(explicit) !== state!.apiUrl)
      throw new CliError(
        "STATE_ORIGIN_MISMATCH",
        "The supplied key is the stored Daykeeper credential, which was issued for a different origin. No request was sent.",
        ["base-url"],
      );
    return explicit;
  }
  if (isStored) return state!.apiUrl;
  if (!unreadable && (!state || state.apiUrl === HOSTED_ORIGIN))
    return HOSTED_ORIGIN;
  throw new CliError(
    "CONFIGURATION_REQUIRED",
    "This machine's stored Daykeeper state points at a different origin, so a supplied key is not sent to the hosted API by default. Set DAYKEEPER_API_URL or --base-url.",
    ["base-url"],
  );
}

function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** The token `init` stored, or undefined when there is none or it is unreadable. */
async function storedToken(
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  try {
    const state = await readState(
      join(resolveHome(textOption(options.home), env), STATE_FILE),
    );
    return state?.credential?.token ?? undefined;
  } catch {
    return undefined;
  }
}

function requestTimeoutMs(
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const timeoutMs = positiveInteger(
    String(options["timeout-ms"] ?? env.DAYKEEPER_TIMEOUT_MS ?? "30000"),
    "timeout-ms",
  );
  if (timeoutMs < 1000 || timeoutMs > 60000)
    throw new CliError(
      "INVALID_ARGUMENT",
      "The timeout must be 1000–60000 milliseconds.",
      ["timeout-ms"],
    );
  return timeoutMs;
}

/** Keep the SDK's own per-request lifetime while honoring CLI cancellation. */
function linkSignals(
  request: AbortSignal | undefined,
  outer: AbortSignal,
): AbortSignal {
  if (!request) return outer;
  return AbortSignal.any([request, outer]);
}

function abortable<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
