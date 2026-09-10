import { randomUUID } from "node:crypto";
import { DaykeeperClient } from "@skyporch/daykeeper";
import {
  CLI_VERSION,
  ENVELOPE_VERSION,
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
  const environmentToken = context.env.DAYKEEPER_ACCESS_TOKEN;
  if (environmentToken && environmentToken.length >= 20)
    secrets.push(environmentToken);
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
                output: "One JSON envelope on stdout. No interactive prompts.",
                authentication:
                  "DAYKEEPER_ACCESS_TOKEN or --token-stdin; use exactly one source. The server enforces scopes and tenant access. init and claim are the exceptions: init mints and stores its own credential, claim uses the one it stored, and both reject either source.",
                globalOptions: [
                  "--base-url",
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
      if (environmentToken)
        throw new CliError(
          "INVALID_ARGUMENT",
          name === "init"
            ? "init creates its own credential; unset DAYKEEPER_ACCESS_TOKEN before running it."
            : "claim uses the credential init stored; unset DAYKEEPER_ACCESS_TOKEN before running it.",
          ["DAYKEEPER_ACCESS_TOKEN"],
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
      const baseUrl =
        parsed.options["base-url"] ?? context.env.DAYKEEPER_API_URL;
      if (typeof baseUrl !== "string" || !baseUrl)
        throw new CliError(
          "CONFIGURATION_REQUIRED",
          "Set DAYKEEPER_API_URL or --base-url to the intended Daykeeper management API.",
          ["base-url"],
        );
      if (parsed.options["token-stdin"] && environmentToken)
        throw new CliError(
          "AUTH_SOURCE_CONFLICT",
          "Use either DAYKEEPER_ACCESS_TOKEN or --token-stdin, not both.",
        );
      if (!parsed.options["token-stdin"] && !environmentToken)
        throw new CliError(
          "AUTH_REQUIRED",
          "Supply a scoped access token through DAYKEEPER_ACCESS_TOKEN or --token-stdin.",
        );

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
      const task = async () => {
        const token = command.options["token-stdin"]
          ? (
              await readBounded(
                context.stdin,
                MAX_TOKEN_BYTES + 2,
                active.signal,
              )
            ).trim()
          : environmentToken!;
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
        const transport = context.fetch ?? globalThis.fetch;
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
  context.write(`${output}\n`);
  return exitCode;
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
