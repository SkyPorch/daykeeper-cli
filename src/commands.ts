import { parseArgs } from "node:util";
import {
  type CreateFlowInput,
  type CreateFlowVersionInput,
  type DaykeeperClient,
  type DaykeeperScope,
  type EmailChannelSpec,
  type TenantSpec,
} from "@skyporch/daykeeper";
import { CliError } from "./errors.ts";
import {
  idempotencyKey,
  positiveInteger,
  resourceId,
  type InputKind,
} from "./schemas.ts";

interface Command {
  name: string;
  effect: "read" | "plan" | "mutation";
  summary: string;
  required: readonly string[];
  optional?: readonly string[];
  scopes: readonly DaykeeperScope[];
  input?: InputKind;
}

const commands: readonly Command[] = [
  {
    name: "init",
    effect: "mutation",
    summary:
      "Enroll a machine owner, create one Free workspace with an API inbox, and store the credential.",
    required: ["name"],
    optional: [
      "plan",
      "origin",
      "onboarding-url",
      "base-url",
      "gateway-url",
      "slug",
      "locale",
      "home",
      "wait-ms",
      "reveal-key",
      "json",
    ],
    // The credential this command mints carries its own fixed scopes. The
    // command itself runs without a pre-existing access token.
    scopes: [],
  },
  {
    name: "capabilities",
    effect: "read",
    summary: "Inspect server capabilities and execution gates.",
    required: [],
    scopes: ["daykeeper.accounts:read"],
  },
  {
    name: "tenants list",
    effect: "read",
    summary: "List tenants visible to the supplied credential.",
    required: [],
    scopes: ["daykeeper.accounts:read"],
  },
  {
    name: "tenants get",
    effect: "read",
    summary: "Inspect one authorized tenant.",
    required: ["tenant-id"],
    scopes: ["daykeeper.accounts:read"],
  },
  {
    name: "tenants plan",
    effect: "plan",
    summary: "Create an expiring plan; do not provision resources.",
    required: ["input"],
    scopes: ["daykeeper.accounts:write"],
    input: "tenant",
  },
  {
    name: "tenants apply",
    effect: "mutation",
    summary: "Explicitly apply the reviewed tenant plan.",
    required: ["plan-id", "plan-version", "idempotency-key"],
    scopes: ["daykeeper.provisioning:apply"],
  },
  {
    name: "email-channels get",
    effect: "read",
    summary: "Inspect channel state and DNS requirements.",
    required: ["tenant-id"],
    scopes: ["daykeeper.accounts:read"],
  },
  {
    name: "email-channels plan",
    effect: "plan",
    summary: "Create an expiring email-channel plan.",
    required: ["tenant-id", "input"],
    scopes: ["daykeeper.accounts:write"],
    input: "channel",
  },
  {
    name: "email-channels apply",
    effect: "mutation",
    summary: "Explicitly apply the reviewed channel plan.",
    required: ["plan-id", "plan-version", "idempotency-key"],
    scopes: ["daykeeper.provisioning:apply"],
  },
  {
    name: "operations get",
    effect: "read",
    summary: "Inspect durable operation state without polling or retrying.",
    required: ["operation-id"],
    scopes: ["daykeeper.provisioning:read"],
  },
  {
    name: "operations retry",
    effect: "mutation",
    summary: "Explicitly request one operation retry.",
    required: ["operation-id"],
    scopes: ["daykeeper.provisioning:apply"],
  },
  {
    name: "flows list",
    effect: "read",
    summary: "List visible flows, optionally restricted to one tenant.",
    required: [],
    optional: ["tenant-id"],
    scopes: ["daykeeper.flows:read"],
  },
  {
    name: "flows get",
    effect: "read",
    summary: "Inspect a flow and its latest immutable version.",
    required: ["flow-id"],
    scopes: ["daykeeper.flows:read"],
  },
  {
    name: "flows create",
    effect: "mutation",
    summary: "Create a draft flow; do not publish or execute it.",
    required: ["tenant-id", "input", "idempotency-key"],
    scopes: ["daykeeper.flows:write"],
    input: "flow",
  },
  {
    name: "flows versions get",
    effect: "read",
    summary: "Read an exact immutable flow version.",
    required: ["flow-id", "version"],
    scopes: ["daykeeper.flows:read"],
  },
  {
    name: "flows versions create",
    effect: "mutation",
    summary:
      "Create a revision using the expected latest version in JSON input.",
    required: ["flow-id", "input", "idempotency-key"],
    scopes: ["daykeeper.flows:write"],
    input: "flowVersion",
  },
  {
    name: "flows versions publish",
    effect: "mutation",
    summary:
      "Publish an existing revision using an explicit expected resource version.",
    required: [
      "flow-id",
      "version",
      "expected-resource-version",
      "idempotency-key",
    ],
    scopes: ["daykeeper.flows:publish"],
  },
];

const globalOptions = [
  "base-url",
  "timeout-ms",
  "token-stdin",
  "json",
  "help",
  "version",
];
const stringOptions = [
  "base-url",
  "timeout-ms",
  "tenant-id",
  "operation-id",
  "flow-id",
  "plan-id",
  "plan-version",
  "idempotency-key",
  "version",
  "expected-resource-version",
  "input",
  "name",
  "plan",
  "origin",
  "onboarding-url",
  "gateway-url",
  "slug",
  "locale",
  "home",
  "wait-ms",
];
const booleanOptions = ["token-stdin", "json", "help", "reveal-key"];

export interface ParsedCommand {
  command?: Command;
  options: Record<string, string | boolean | undefined>;
  help: boolean;
  version: boolean;
}

export function commandCatalog() {
  return structuredClone(commands);
}

export function parseCommand(args: readonly string[]): ParsedCommand {
  if (args.length === 1 && args[0] === "--version") {
    return { options: {}, help: false, version: true };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: Object.fromEntries([
        ...stringOptions.map((name) => [name, { type: "string" }]),
        ...booleanOptions.map((name) => [name, { type: "boolean" }]),
      ]),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Invalid command arguments. Use --help; access-token flags are not accepted.",
      ["arguments"],
    );
  }
  const names = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (names.has(token.name)) {
      throw new CliError(
        "INVALID_ARGUMENT",
        "Options may be supplied only once.",
        [token.name],
      );
    }
    names.add(token.name);
  }
  const options = parsed.values as ParsedCommand["options"];
  const name = parsed.positionals.join(" ");
  const command = commands.find((candidate) => candidate.name === name);
  if (!name && (args.length === 0 || options.help === true)) {
    return { options, help: true, version: false };
  }
  if (!command) {
    throw new CliError(
      "UNKNOWN_COMMAND",
      "Unknown command. Use --help to inspect the supported command contract.",
      ["command"],
    );
  }
  const allowed = new Set([
    ...globalOptions.filter((flag) => flag !== "version"),
    ...command.required,
    ...(command.optional ?? []),
  ]);
  const unsupported = Object.keys(options).filter((flag) => !allowed.has(flag));
  if (unsupported.length) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "An option is not supported by this command.",
      unsupported,
    );
  }
  if (options.help === true)
    return { command, options, help: true, version: false };
  const missing = command.required.filter(
    (flag) => options[flag] === undefined || options[flag] === "",
  );
  if (missing.length) {
    throw new CliError(
      "MISSING_ARGUMENT",
      "Required options are missing. No request was sent.",
      missing,
    );
  }
  if (command.name === "init" && options["token-stdin"]) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "init creates its own credential and must not run under another access token.",
      ["token-stdin"],
    );
  }
  if (options["token-stdin"] && options.input === "-") {
    throw new CliError(
      "STDIN_CONFLICT",
      "Use stdin for either the access token or the JSON input, not both.",
      ["token-stdin", "input"],
    );
  }
  for (const flag of ["tenant-id", "operation-id", "flow-id", "plan-id"]) {
    if (options[flag] !== undefined) resourceId(String(options[flag]), flag);
  }
  for (const flag of ["plan-version", "version", "expected-resource-version"]) {
    if (options[flag] !== undefined)
      positiveInteger(String(options[flag]), flag);
  }
  if (options["idempotency-key"] !== undefined)
    idempotencyKey(String(options["idempotency-key"]));
  return { command, options, help: false, version: false };
}

export async function dispatch(
  client: DaykeeperClient,
  parsed: ParsedCommand,
  input: unknown,
): Promise<unknown> {
  const option = (name: string) => String(parsed.options[name]);
  const apply = () => ({
    planId: option("plan-id"),
    planVersion: positiveInteger(option("plan-version"), "plan-version"),
  });
  switch (parsed.command?.name) {
    case "capabilities":
      return client.capabilities();
    case "tenants list":
      return client.tenants.list();
    case "tenants get":
      return client.tenants.get(option("tenant-id"));
    case "tenants plan":
      return client.tenants.plan(input as TenantSpec);
    case "tenants apply":
      return client.tenants.apply(apply(), {
        idempotencyKey: option("idempotency-key"),
      });
    case "email-channels get":
      return client.emailChannels.get(option("tenant-id"));
    case "email-channels plan":
      return client.emailChannels.plan(
        option("tenant-id"),
        input as EmailChannelSpec,
      );
    case "email-channels apply":
      return client.emailChannels.apply(apply(), {
        idempotencyKey: option("idempotency-key"),
      });
    case "operations get":
      return client.operations.get(option("operation-id"));
    case "operations retry":
      return client.operations.retry(option("operation-id"));
    case "flows list":
      return client.flows.list(
        parsed.options["tenant-id"] === undefined
          ? undefined
          : option("tenant-id"),
      );
    case "flows get":
      return client.flows.get(option("flow-id"));
    case "flows create":
      return client.flows.create(
        option("tenant-id"),
        input as CreateFlowInput,
        {
          idempotencyKey: option("idempotency-key"),
        },
      );
    case "flows versions get":
      return client.flows.getVersion(
        option("flow-id"),
        positiveInteger(option("version"), "version"),
      );
    case "flows versions create":
      return client.flows.createVersion(
        option("flow-id"),
        input as CreateFlowVersionInput,
        { idempotencyKey: option("idempotency-key") },
      );
    case "flows versions publish":
      return client.flows.publishVersion(
        option("flow-id"),
        positiveInteger(option("version"), "version"),
        {
          expectedResourceVersion: positiveInteger(
            option("expected-resource-version"),
            "expected-resource-version",
          ),
        },
        { idempotencyKey: option("idempotency-key") },
      );
    default:
      throw new CliError(
        "UNKNOWN_COMMAND",
        "No executable command was selected.",
      );
  }
}
