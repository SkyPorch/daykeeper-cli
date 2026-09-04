import { DaykeeperClient } from "@skyporch/daykeeper";
import {
  CLI_VERSION,
  ENVELOPE_VERSION,
  MAX_TOKEN_BYTES,
  SDK_VERSION,
} from "./constants.ts";
import {
  commandCatalog,
  dispatch,
  parseCommand,
  type ParsedCommand,
} from "./commands.ts";
import { CliError, errorEnvelope } from "./errors.ts";
import { readBounded, readJsonInput, type InputStream } from "./io.ts";
import { positiveInteger, validateInput } from "./schemas.ts";

export { CLI_VERSION, ENVELOPE_VERSION, SDK_VERSION } from "./constants.ts";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdin: InputStream;
  write: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export async function runCli(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  let parsed: ParsedCommand | undefined;
  let requestSent = false;
  let exitCode = 0;
  const secrets: string[] = [];
  const environmentToken = context.env.DAYKEEPER_ACCESS_TOKEN;
  if (environmentToken && environmentToken.length >= 20)
    secrets.push(environmentToken);
  let cleanup = () => {};
  let controller: AbortController | undefined;
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
                  "DAYKEEPER_ACCESS_TOKEN or --token-stdin; use exactly one source. The server enforces scopes and tenant access.",
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
    } else {
      const timeoutMs = positiveInteger(
        String(
          parsed.options["timeout-ms"] ??
            context.env.DAYKEEPER_TIMEOUT_MS ??
            "30000",
        ),
        "timeout-ms",
      );
      if (timeoutMs < 1000 || timeoutMs > 60000)
        throw new CliError(
          "INVALID_ARGUMENT",
          "The timeout must be 1000–60000 milliseconds.",
          ["timeout-ms"],
        );
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
    const details = errorEnvelope(actual, secrets);
    const uncertainMutation =
      requestSent &&
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
                  ...(parsed?.command?.name.endsWith(" apply")
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
  context.write(`${output}\n`);
  return exitCode;
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
