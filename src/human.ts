/**
 * Readable text for `init` when a person runs it in a terminal. It is built
 * only from the envelope after redaction, so it never shows more than the
 * JSON would.
 */
export function renderInitText(envelope: Record<string, any>): string {
  if (!envelope.ok) {
    const error = envelope.error ?? {};
    const lines = [
      `Daykeeper init stopped: ${error.message ?? "Unknown error."}`,
    ];
    if (error.code) lines.push(`  Code: ${error.code}`);
    const next: string[] = Array.isArray(error.nextActions)
      ? error.nextActions
      : [];
    // Only a failure that a plain rerun can get past says so. A refusal that
    // needs something fixed first already says what to fix in its message.
    if (next.includes("run_init_again") && error.retryable === true)
      lines.push("  Run the same command again to resume where it stopped.");
    lines.push("", "Add --json for the full machine-readable result.");
    return `${lines.join("\n")}\n`;
  }

  const data = envelope.data ?? {};
  const rows: [string, string][] = [
    ["Workspace", `${data.workspace?.name ?? ""}  ${data.workspaceId ?? ""}`],
    ["Inbox", `${data.inbox?.slug ?? ""}  ${data.inboxId ?? ""}`],
    ["API", data.endpoints?.apiUrl ?? ""],
    ["Credential", data.credential?.storedAt ?? ""],
    ["MCP config", data.mcp?.configPath ?? ""],
  ];
  const key = data.sdk?.env?.DAYKEEPER_API_KEY;
  if (typeof key === "string" && !key.startsWith("<"))
    rows.push(["API key", key]);
  const width = Math.max(...rows.map(([label]) => label.length));

  const lines = [
    data.resumed
      ? "Your Daykeeper inbox is ready. This run resumed an earlier one."
      : "Your Daykeeper inbox is ready.",
    "",
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ];
  const owner = data.ownerClaim;
  if (owner?.handoff) {
    lines.push("", "Owner claim");
    if (owner.claimUrl) lines.push(`  ${owner.claimUrl}`);
    lines.push(...handoffLines(owner.handoff.message, "  "));
  }
  const steps: Record<string, any>[] = Array.isArray(data.nextSteps)
    ? data.nextSteps
    : [];
  if (steps.length) {
    lines.push("", "Next steps");
    steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.description}`);
      lines.push(`     ${step.command ?? step.url}`);
    });
  }
  const warnings: Record<string, any>[] = Array.isArray(envelope.warnings)
    ? envelope.warnings
    : [];
  for (const warning of warnings) lines.push("", `Note: ${warning.message}`);
  lines.push("", "Add --json for the full machine-readable result.");
  return `${lines.join("\n")}\n`;
}

/**
 * Readable text for `claim` and `claim status` in a terminal: the link, who it
 * is for, how long it lasts and how to replace it. Built only from the
 * envelope, so it never shows more than the JSON would.
 */
export function renderClaimText(envelope: Record<string, any>): string {
  if (!envelope.ok) {
    const error = envelope.error ?? {};
    const lines = [
      `Daykeeper claim stopped: ${error.message ?? "Unknown error."}`,
    ];
    if (error.code) lines.push(`  Code: ${error.code}`);
    lines.push("", "Add --json for the full machine-readable result.");
    return `${lines.join("\n")}\n`;
  }
  const data = envelope.data ?? {};
  const lines: string[] = [];
  if (Array.isArray(data.claims)) {
    if (data.claims.length === 0) lines.push("No claims have been issued.");
    else {
      lines.push("Claims for this workspace");
      for (const claim of data.claims)
        lines.push(
          `  ${claim.email}  ${claim.state}${claim.state === "pending" ? `  expires ${claim.expiresAt}` : ""}`,
        );
    }
  } else {
    const email = data.handoff?.sendTo ?? data.claim?.email ?? "";
    if (data.claimUrl)
      lines.push(`Claim link for ${email}`, "", `  ${data.claimUrl}`, "");
    if (data.handoff?.message)
      lines.push(...handoffLines(data.handoff.message, ""));
  }
  const warnings: Record<string, any>[] = Array.isArray(envelope.warnings)
    ? envelope.warnings
    : [];
  for (const warning of warnings) lines.push("", `Note: ${warning.message}`);
  lines.push("", "Add --json for the full machine-readable result.");
  return `${lines.join("\n")}\n`;
}

/**
 * The handoff message, wrapped, with its closing command on a line of its
 * own so it can be copied whole.
 */
function handoffLines(message: string, indent: string): string[] {
  const at = message.lastIndexOf(" run: ");
  if (at === -1) return wrap(message, indent);
  return [
    ...wrap(`${message.slice(0, at)} run:`, indent),
    `${indent}  ${message.slice(at + " run: ".length)}`,
  ];
}

/** Break a paragraph into lines of at most 78 characters. */
function wrap(text: string, indent: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && (indent + line + " " + word).length > 78) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}
