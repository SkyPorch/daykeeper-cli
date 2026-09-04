import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { MAX_INPUT_BYTES } from "./constants.ts";
import { CliError } from "./errors.ts";

export type InputStream = Readable & { isTTY?: boolean };

export async function readBounded(
  stream: InputStream,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  if (stream.isTTY) {
    throw new CliError(
      "STDIN_REQUIRED",
      "Pipe input into stdin; interactive input and prompts are disabled.",
    );
  }
  const abort = () => stream.destroy(new Error("Input cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw signal.reason;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maximum) {
        throw new CliError(
          "INPUT_TOO_LARGE",
          "Input exceeds the documented byte limit.",
        );
      }
      chunks.push(bytes);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof CliError) throw error;
    throw new CliError(
      "INPUT_READ_FAILED",
      "Input could not be read as UTF-8. No input contents were logged.",
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function readJsonInput(
  source: string,
  stdin: InputStream,
  signal: AbortSignal,
): Promise<unknown> {
  let text: string;
  if (source === "-") {
    text = await readBounded(stdin, MAX_INPUT_BYTES, signal);
  } else {
    let handle;
    try {
      handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new CliError(
          "INVALID_INPUT_FILE",
          "JSON input must be a regular file or '-' for stdin.",
          ["input"],
        );
      if (stat.size > MAX_INPUT_BYTES)
        throw new CliError("INPUT_TOO_LARGE", "JSON input exceeds 512 KiB.", [
          "input",
        ]);
      text = await readBounded(
        handle.createReadStream({ autoClose: false }),
        MAX_INPUT_BYTES,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof CliError) throw error;
      throw new CliError(
        "INPUT_READ_FAILED",
        "The JSON input file could not be read. No path or contents were logged.",
        ["input"],
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      "INVALID_JSON",
      "Input must contain one valid JSON value. No input contents were logged.",
      ["input"],
    );
  }
}
