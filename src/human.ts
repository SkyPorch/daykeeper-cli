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
    if (next.includes("run_init_again"))
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
