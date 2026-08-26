import {
  DaykeeperApiError,
  DaykeeperClient,
  DaykeeperTransportError,
  type Operation,
} from "@skyporch/daykeeper";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DAYKEEPER_CLI_VERSION } from "./version.js";

const MAX_INPUT_BYTES = 256 * 1024;
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled"]);

export interface DaykeeperCliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export interface RunDaykeeperCliOptions {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  io?: DaykeeperCliIo;
  readJsonInput?: (path: string) => Promise<unknown>;
}

export async function runDaykeeperCli(
  options: RunDaykeeperCliOptions,
): Promise<number> {
  const io = options.io ?? process;
  try {
    const parsed = parseCliArgs(options.argv);
    if (parsed.values.help) {
      io.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (parsed.values.version) {
      io.stdout.write(`${DAYKEEPER_CLI_VERSION}\n`);
      return 0;
    }

    const [resource, action] = parsed.positionals;
    if (!resource) throw usageError("A command is required");

    const env = options.env ?? process.env;
    const baseUrl = parsed.values["api-url"] ?? env.DAYKEEPER_API_URL;
    const token = env.DAYKEEPER_ACCESS_TOKEN;
    if (!baseUrl) {
      throw usageError("Set DAYKEEPER_API_URL or pass --api-url");
    }
    if (!token) {
      throw usageError(
        "Set DAYKEEPER_ACCESS_TOKEN; tokens are not accepted in argv",
      );
    }

    const client = new DaykeeperClient({
      baseUrl,
      token,
      fetch: options.fetch,
    });
    const readJsonInput = options.readJsonInput ?? defaultReadJsonInput;
    const result = await execute({
      resource,
      action,
      values: parsed.values,
      client,
      readJsonInput,
    });
    writeJson(io.stdout, { data: result });
    return 0;
  } catch (error) {
    writeJson(io.stderr, { error: serializeError(error) });
    return error instanceof CliUsageError
      ? 2
      : error instanceof CliWaitError
        ? 3
        : 1;
  }
}

interface ExecuteOptions {
  resource: string;
  action?: string;
  values: Record<string, string | boolean | undefined>;
  client: DaykeeperClient;
  readJsonInput: (path: string) => Promise<unknown>;
}

async function execute(options: ExecuteOptions): Promise<unknown> {
  const { resource, action, values, client, readJsonInput } = options;
  if (resource === "capabilities" && action === undefined) {
    return client.capabilities();
  }
  if (resource === "tenants") {
    if (action === "list") return client.tenants.list();
    if (action === "get")
      return client.tenants.get(required(values.id, "--id"));
    if (action === "plan") {
      return client.tenants.plan(
        (await readJsonInput(required(values.input, "--input"))) as never,
      );
    }
    if (action === "apply") {
      return client.tenants.apply(
        (await readJsonInput(required(values.input, "--input"))) as never,
        {
          idempotencyKey: required(
            values["idempotency-key"],
            "--idempotency-key",
          ),
        },
      );
    }
  }
  if (resource === "channels") {
    if (action === "get") {
      return client.emailChannels.get(
        required(values["tenant-id"], "--tenant-id"),
      );
    }
    if (action === "plan") {
      return client.emailChannels.plan(
        required(values["tenant-id"], "--tenant-id"),
        (await readJsonInput(required(values.input, "--input"))) as never,
      );
    }
    if (action === "apply") {
      return client.emailChannels.apply(
        (await readJsonInput(required(values.input, "--input"))) as never,
        {
          idempotencyKey: required(
            values["idempotency-key"],
            "--idempotency-key",
          ),
        },
      );
    }
  }
  if (resource === "operations") {
    const id = required(values.id, "--id");
    if (action === "get") return client.operations.get(id);
    if (action === "retry") return client.operations.retry(id);
    if (action === "wait") {
      return waitForOperation(client, id, {
        pollMs: seconds(
          values["poll-seconds"] ?? "2",
          "--poll-seconds",
          0.25,
          60,
        ),
        timeoutMs: seconds(
          values["timeout-seconds"] ?? "300",
          "--timeout-seconds",
          1,
          3_600,
        ),
      });
    }
  }
  if (resource === "flows") {
    if (action === "list")
      return client.flows.list(optionalString(values["tenant-id"]));
    if (action === "get") return client.flows.get(required(values.id, "--id"));
    if (action === "version-get") {
      return client.flows.getVersion(
        required(values.id, "--id"),
        positiveInteger(values["flow-version"], "--flow-version"),
      );
    }
    if (action === "create") {
      return client.flows.create(
        required(values["tenant-id"], "--tenant-id"),
        (await readJsonInput(required(values.input, "--input"))) as never,
      );
    }
    if (action === "version-create") {
      return client.flows.createVersion(
        required(values.id, "--id"),
        (await readJsonInput(required(values.input, "--input"))) as never,
      );
    }
    if (action === "publish") {
      return client.flows.publishVersion(
        required(values.id, "--id"),
        positiveInteger(values["flow-version"], "--flow-version"),
        (await readJsonInput(required(values.input, "--input"))) as never,
      );
    }
  }
  throw usageError(
    `Unknown command: ${[resource, action].filter(Boolean).join(" ")}`,
  );
}

async function waitForOperation(
  client: DaykeeperClient,
  id: string,
  options: { pollMs: number; timeoutMs: number },
): Promise<Operation> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const operation = await client.operations.get(id);
    if (TERMINAL_OPERATION_STATES.has(operation.state)) return operation;
    if (Date.now() >= deadline) {
      throw new CliWaitError(
        `Operation ${id} did not finish within ${options.timeoutMs / 1_000} seconds`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

async function defaultReadJsonInput(path: string): Promise<unknown> {
  let bytes: Buffer;
  if (path === "-") {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_INPUT_BYTES)
        throw usageError("JSON input exceeds 256 KiB");
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } else {
    const metadata = await stat(path);
    if (!metadata.isFile())
      throw usageError("--input must reference a regular file or -");
    if (metadata.size > MAX_INPUT_BYTES)
      throw usageError("JSON input exceeds 256 KiB");
    bytes = await readFile(path);
    if (bytes.byteLength > MAX_INPUT_BYTES) {
      throw usageError("JSON input exceeds 256 KiB");
    }
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw usageError("Input must be valid JSON");
  }
}

function required(value: string | boolean | undefined, flag: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${flag} is required`);
  }
  return value;
}

function optionalString(
  value: string | boolean | undefined,
): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(
  value: string | boolean | undefined,
  flag: string,
): number {
  const raw = required(value, flag);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw usageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function seconds(
  value: string | boolean | undefined,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(required(value, flag));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw usageError(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed * 1_000;
}

function writeJson(
  output: { write(value: string): unknown },
  value: unknown,
): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "api-url": { type: "string" },
        help: { type: "boolean", short: "h" },
        id: { type: "string" },
        "idempotency-key": { type: "string" },
        input: { type: "string", short: "i" },
        "poll-seconds": { type: "string" },
        "tenant-id": { type: "string" },
        "timeout-seconds": { type: "string" },
        version: { type: "boolean" },
        "flow-version": { type: "string" },
      },
    });
  } catch (error) {
    throw usageError(
      error instanceof Error ? error.message : "Invalid command flags",
    );
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (
    error instanceof DaykeeperApiError ||
    error instanceof DaykeeperTransportError
  ) {
    return error.toJSON() as unknown as Record<string, unknown>;
  }
  if (error instanceof CliUsageError || error instanceof CliWaitError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      retryable: error instanceof CliWaitError,
      nextActions:
        error instanceof CliUsageError
          ? ["run_daykeeper_help"]
          : ["inspect_operation"],
    };
  }
  return {
    name: "DaykeeperCliError",
    code: "CLI_ERROR",
    message: "The Daykeeper command could not be completed",
    retryable: false,
  };
}

class CliUsageError extends Error {
  readonly code = "INVALID_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "DaykeeperCliUsageError";
  }
}

class CliWaitError extends Error {
  readonly code = "WAIT_TIMEOUT";

  constructor(message: string) {
    super(message);
    this.name = "DaykeeperCliWaitError";
  }
}

function usageError(message: string): CliUsageError {
  return new CliUsageError(message);
}

const HELP = `Daykeeper CLI ${DAYKEEPER_CLI_VERSION}

Usage:
  daykeeper capabilities
  daykeeper tenants list
  daykeeper tenants get --id ID
  daykeeper tenants plan --input FILE|-
  daykeeper tenants apply --input FILE|- --idempotency-key KEY
  daykeeper channels get --tenant-id ID
  daykeeper channels plan --tenant-id ID --input FILE|-
  daykeeper channels apply --input FILE|- --idempotency-key KEY
  daykeeper operations get --id ID
  daykeeper operations retry --id ID
  daykeeper operations wait --id ID [--timeout-seconds 300] [--poll-seconds 2]
  daykeeper flows list [--tenant-id ID]
  daykeeper flows get --id ID
  daykeeper flows create --tenant-id ID --input FILE|-
  daykeeper flows version-get --id ID --flow-version NUMBER
  daykeeper flows version-create --id ID --input FILE|-
  daykeeper flows publish --id ID --flow-version NUMBER --input FILE|-

Environment:
  DAYKEEPER_API_URL         API origin; can be overridden with --api-url
  DAYKEEPER_ACCESS_TOKEN    Bearer credential; never accepted on the command line

All successful commands emit one JSON object to stdout. Errors emit one JSON
object to stderr. Use --input - to read at most 256 KiB of JSON from stdin.`;
