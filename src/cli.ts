#!/usr/bin/env node
import { spawn } from "node:child_process";
import { ENVELOPE_VERSION, runCli } from "./index.ts";

const controller = new AbortController();
let cancelledExitCode = 1;
const interrupt = () => {
  cancelledExitCode = 130;
  controller.abort();
};
const terminate = () => {
  cancelledExitCode = 143;
  controller.abort();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  process.exit(1);
});

async function main() {
  try {
    const result = await runCli(process.argv.slice(2), {
      env: process.env,
      stdin: process.stdin,
      write: (line) => {
        process.stdout.write(line);
      },
      signal: controller.signal,
      interactive: process.stdout.isTTY === true,
      notify: (text) => {
        process.stderr.write(text);
      },
      openUrl,
    });
    process.exitCode = controller.signal.aborted ? cancelledExitCode : result;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

void main().catch(() => {
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: ENVELOPE_VERSION,
      ok: false,
      command: null,
      error: {
        kind: "cli",
        code: "INTERNAL_ERROR",
        message:
          "The command could not be completed. No diagnostic details were logged.",
        retryable: false,
        fields: [],
        nextActions: [],
      },
    })}\n`,
  );
  process.exitCode = 1;
});

/**
 * Open a claim link in the person's default browser. The URL is passed as one
 * argument, never through a shell, and a browser that does not open is not an
 * error: the link is printed either way.
 */
function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return Promise.resolve();
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}
