import {
  DaykeeperApiError,
  DaykeeperTransportError,
} from "@skyporch/daykeeper";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fields: readonly string[] = [],
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DaykeeperCliError";
  }
}

export function errorEnvelope(error: unknown, secrets: readonly string[]) {
  if (error instanceof CliError) {
    return {
      kind: "cli",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fields: error.fields,
      nextActions: [],
    };
  }
  if (error instanceof DaykeeperApiError) {
    const denied = error.status === 401 || error.status === 403;
    const hidden = denied || error.status === 404;
    return {
      kind: "api",
      code:
        safeValue(error.code, /^[A-Z][A-Z0-9_]{0,79}$/, secrets) ?? "API_ERROR",
      message: hidden
        ? "The request is not authorized or the resource is unavailable."
        : "The Daykeeper API rejected the request. Inspect the error code and next actions.",
      retryable: hidden ? false : error.retryable === true,
      status: error.status,
      fields: safeList(error.fields, /^[A-Za-z0-9_.[\]-]{1,120}$/, secrets),
      nextActions: safeList(
        error.nextActions,
        /^[a-z][a-z0-9_]{0,79}$/,
        secrets,
      ),
      ...(safeValue(error.correlationId, /^[A-Za-z0-9._:-]{1,128}$/, secrets)
        ? { correlationId: error.correlationId }
        : {}),
    };
  }
  if (error instanceof DaykeeperTransportError) {
    return {
      kind: "transport",
      code: error.code,
      message: "The Daykeeper request could not be completed.",
      retryable: error.retryable,
      fields: [],
      nextActions: [],
    };
  }
  return {
    kind: "cli",
    code: "INTERNAL_ERROR",
    message:
      "The command could not be completed. No diagnostic details were logged.",
    retryable: false,
    fields: [],
    nextActions: [],
  };
}

function safeValue(
  value: unknown,
  pattern: RegExp,
  secrets: readonly string[],
): string | undefined {
  return typeof value === "string" &&
    pattern.test(value) &&
    !secrets.some((secret) => value.includes(secret))
    ? value
    : undefined;
}

function safeList(
  values: unknown,
  pattern: RegExp,
  secrets: readonly string[],
): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.slice(0, 32).flatMap((value) => {
        const safe = safeValue(value, pattern, secrets);
        return safe === undefined ? [] : [safe];
      }),
    ),
  ];
}
