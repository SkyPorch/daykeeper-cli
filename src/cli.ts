#!/usr/bin/env node
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
