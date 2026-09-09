import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.ts";

/** Only `init` persists state; every other command stays stateless. */
export const STATE_VERSION = 1;
export const STATE_FILE = "credentials.json";
export const MCP_FILE = "mcp.json";
export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;
const MAX_STATE_BYTES = 64 * 1024;

/** The private key is unrecoverable by design, so the file says so. */
export const STATE_WARNING =
  "This file holds the machine owner private key and a reveal-once credential. " +
  "The key is never sent to Daykeeper and cannot be recovered if this file is lost.";

export interface OwnerState {
  privateJwk: JsonWebKey;
}

export interface EnrollmentState {
  name: string;
  idempotencyKey: string;
}

export interface WorkspaceState {
  ownerId: string;
  organizationId: string;
  organizationSlug: string;
}

export interface CredentialState {
  id: string | null;
  expiresAt: string | null;
  token: string | null;
  rotationIntentId: string | null;
}

export interface InboxState {
  tenantId: string | null;
  name: string | null;
  slug: string | null;
  applyIdempotencyKey: string | null;
  operationId: string | null;
  activationIntent: string | null;
  provisionedAt: string | null;
}

export interface InitState {
  version: number;
  origin: string;
  onboardingUrl: string;
  apiUrl: string;
  gatewayUrl: string;
  warning: string;
  owner?: OwnerState;
  enrollment?: EnrollmentState;
  workspace?: WorkspaceState;
  credential?: CredentialState;
  inbox?: InboxState;
  updatedAt: string;
}

export function resolveHome(
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = option ?? env.DAYKEEPER_HOME;
  if (explicit) return explicit;
  const base = env.XDG_CONFIG_HOME;
  return base
    ? join(base, "daykeeper")
    : join(homedir(), ".config", "daykeeper");
}

/**
 * Read the state file. A missing file is a first run, not an error. A file that
 * any other account can read is refused rather than used: the credential and the
 * owner key inside it would already be compromised.
 */
export async function readState(path: string): Promise<InitState | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new CliError(
      "STATE_UNREADABLE",
      "The Daykeeper state file could not be opened. No path was logged.",
      ["home"],
      false,
      ["run_init_again"],
    );
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new CliError(
        "STATE_UNREADABLE",
        "The Daykeeper state path is not a regular file.",
        ["home"],
      );
    }
    if ((status.mode & 0o077) !== 0) {
      throw new CliError(
        "STATE_INSECURE",
        "The Daykeeper state file is readable by other accounts. Restore mode 0600 and run init again.",
        ["home"],
        false,
        ["run_init_again"],
      );
    }
    if (status.size > MAX_STATE_BYTES) {
      throw new CliError(
        "STATE_UNREADABLE",
        "The Daykeeper state file exceeds its documented size.",
        ["home"],
      );
    }
    const text = await handle.readFile("utf8");
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as InitState).version !== STATE_VERSION
    ) {
      throw new CliError(
        "STATE_UNREADABLE",
        "The Daykeeper state file is not a supported version 1 document.",
        ["home"],
      );
    }
    return parsed as InitState;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "STATE_UNREADABLE",
      "The Daykeeper state file could not be read. No contents were logged.",
      ["home"],
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeState(
  directory: string,
  path: string,
  state: InitState,
): Promise<void> {
  await writeSecureFile(directory, path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Write a 0600 file inside a 0700 directory through a temporary file and a
 * rename, so a crash never leaves a half-written credential behind.
 */
export async function writeSecureFile(
  directory: string,
  path: string,
  contents: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE,
    );
    try {
      await handle.writeFile(contents, "utf8");
      await handle.chmod(FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError(
      "STATE_UNREADABLE",
      "The Daykeeper state directory could not be written. No path was logged.",
      ["home"],
    );
  }
}
