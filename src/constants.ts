export const CLI_VERSION = "0.1.0";
export const SDK_VERSION = "0.2.0";
export const ENVELOPE_VERSION = "daykeeper.cli.v1";
export const MAX_INPUT_BYTES = 512 * 1024;
export const MAX_TOKEN_BYTES = 16 * 1024;

/**
 * The single built-in hosted origin `init` falls back to. It is deliberately
 * empty in this repository: there is no default hostname anywhere in the code,
 * and `init` fails with `ORIGIN_REQUIRED` until a release PR sets it.
 */
export const HOSTED_ORIGIN = "";

export const SDK_PACKAGE = "@skyporch/daykeeper";
export const MCP_PACKAGE = "@skyporch/daykeeper-mcp@0.2.0";
export const REACT_NATIVE_PACKAGE = "@skyporch/daykeeper-react-native@0.1.0";
