export const CLI_VERSION = "0.1.0";
export const SDK_VERSION = "0.3.0";
export const ENVELOPE_VERSION = "daykeeper.cli.v1";
export const MAX_INPUT_BYTES = 512 * 1024;
export const MAX_TOKEN_BYTES = 16 * 1024;

/**
 * The hosted Daykeeper origins `init` falls back to when no origin is given.
 * The API origin also serves machine onboarding; the gateway serves customer
 * SDK traffic. `--origin`, `--gateway-url`, and their environment variables
 * override these.
 */
export const HOSTED_ORIGIN = "https://api.mydaykeeper.com";
export const HOSTED_GATEWAY_URL = "https://gateway.mydaykeeper.com";

export const SDK_PACKAGE = "@skyporch/daykeeper";
export const MCP_PACKAGE = "@skyporch/daykeeper-mcp@0.2.0";
export const REACT_NATIVE_PACKAGE = "@skyporch/daykeeper-react-native@0.1.0";
