import { HOSTED_GATEWAY_URL, HOSTED_ORIGIN } from "./constants.ts";
import { CliError } from "./errors.ts";
import type { InitState } from "./state.ts";

/** The four origins a stored credential is pinned to. */
export interface Origins {
  origin: string;
  onboardingUrl: string;
  apiUrl: string;
  gatewayUrl: string;
}

const PINNED_ORIGINS = [
  ["origin", "origin"],
  ["onboardingUrl", "onboarding-url"],
  ["apiUrl", "base-url"],
  ["gatewayUrl", "gateway-url"],
] as const;

/**
 * Resolve the origins a stateful command talks to: explicit flags first, then
 * their environment variables, then the single `--origin`, then the built-in
 * hosted origins. Every result is a canonical HTTPS root.
 */
export function resolveOrigins(
  options: Readonly<Record<string, string | boolean | undefined>>,
  env: Readonly<Record<string, string | undefined>>,
): Origins {
  const text = (value: string | boolean | undefined) =>
    typeof value === "string" && value !== "" ? value : undefined;
  const explicitOrigin = text(options.origin) ?? env.DAYKEEPER_ORIGIN;
  const origin = explicitOrigin ?? HOSTED_ORIGIN;
  // A custom origin serves its own gateway; only the hosted origin pairs with
  // the hosted gateway.
  const gatewayFallback = explicitOrigin ? origin : HOSTED_GATEWAY_URL;
  const services: [keyof Origins, string, string | undefined][] = [
    [
      "onboardingUrl",
      "onboarding-url",
      text(options["onboarding-url"]) ?? env.DAYKEEPER_ONBOARDING_URL ?? origin,
    ],
    [
      "apiUrl",
      "base-url",
      text(options["base-url"]) ?? env.DAYKEEPER_API_URL ?? origin,
    ],
    [
      "gatewayUrl",
      "gateway-url",
      text(options["gateway-url"]) ??
        env.DAYKEEPER_GATEWAY_URL ??
        gatewayFallback,
    ],
  ];
  const resolved: Record<string, string> = {};
  for (const [key, field, value] of services) {
    if (!value) {
      throw new CliError(
        "ORIGIN_REQUIRED",
        "No Daykeeper origin is configured. Pass --origin or set DAYKEEPER_ORIGIN, then run init again.",
        ["origin", field],
        false,
        ["run_init_again"],
      );
    }
    resolved[key] = canonicalOrigin(value, field);
  }
  return {
    origin: origin ? canonicalOrigin(origin, "origin") : resolved.apiUrl!,
    onboardingUrl: resolved.onboardingUrl!,
    apiUrl: resolved.apiUrl!,
    gatewayUrl: resolved.gatewayUrl!,
  };
}

/**
 * The state file records the origins its credential was minted against. A run
 * that resolves different ones is refused rather than resumed: no stored token
 * is ever sent to a host that did not issue it. Only hostnames are reported,
 * never the configured URLs.
 */
export function assertPinnedOrigin(stored: InitState, args: Origins): void {
  const differing = PINNED_ORIGINS.filter(([key]) => stored[key] !== args[key]);
  if (differing.length === 0) return;
  const [key] = differing[0]!;
  throw new CliError(
    "STATE_ORIGIN_MISMATCH",
    "The stored Daykeeper credential was issued for a different origin. No request was sent. Point --home at a separate directory for this origin, or remove the state file.",
    differing.map(([, field]) => field),
    false,
    [],
    {
      ...host("storedHost", stored[key]),
      ...host("requestedHost", args[key]),
    },
  );
}

function host(label: string, value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  try {
    const { host: name } = new URL(value);
    return name ? { [label]: name } : {};
  } catch {
    return {};
  }
}

/**
 * Preflight: `GET /v1/capabilities` needs a credential, so the only check that
 * can run before enrollment is the origin itself.
 */
export function canonicalOrigin(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      "INVALID_CONFIGURATION",
      "A Daykeeper origin must be an absolute URL.",
      [field],
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.host.split(":")[0] ?? "",
  );
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new CliError(
      "INVALID_CONFIGURATION",
      "A Daykeeper origin must use HTTPS; only loopback development origins may use HTTP.",
      [field],
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "INVALID_CONFIGURATION",
      "A Daykeeper origin cannot carry credentials, a query, or a fragment.",
      [field],
    );
  }
  if (url.pathname !== "/") {
    throw new CliError(
      "INVALID_CONFIGURATION",
      "A Daykeeper origin cannot carry a path.",
      [field],
    );
  }
  return url.origin;
}
