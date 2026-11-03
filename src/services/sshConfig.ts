import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/* ------------------------------------------------------------------ */
/* Paths                                                              */
/* ------------------------------------------------------------------ */

/** The user's SSH directory (`~/.ssh`). */
export function sshDirectory(): string {
  return path.join(os.homedir(), ".ssh");
}

/** The user's main SSH config (`~/.ssh/config`). */
export function sshConfigPath(): string {
  return path.join(sshDirectory(), "config");
}

/* ------------------------------------------------------------------ */
/* Blocks                                                             */
/* ------------------------------------------------------------------ */

/**
 * Inserts or replaces a delimited block in an SSH config file.
 *
 * Each host gets its own `# BEGIN <marker>` / `# END <marker>` block, so
 * connecting to a second host does not drop the first one. The file is
 * created when missing and the previous content is preserved.
 */
export function upsertSshConfigBlock(
  configPath: string,
  marker: string,
  lines: string[],
): void {
  const begin = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const block = [begin, ...lines, end, ""].join("\n");

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

  let current = "";
  if (fs.existsSync(configPath)) {
    current = fs.readFileSync(configPath, "utf8");
  }

  const start = current.indexOf(begin);
  const stop = current.indexOf(end);
  if (start !== -1 && stop !== -1 && stop > start) {
    const before = current.slice(0, start);
    const after = current.slice(stop + end.length).replace(/^\n/, "");
    const merged = `${before}${block}${after ? `\n${after}` : ""}`;
    fs.writeFileSync(configPath, merged, { mode: 0o600 });
    return;
  }

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(configPath, `${separator}${block}`, { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* Include                                                            */
/* ------------------------------------------------------------------ */

/**
 * Makes sure `~/.ssh/config` includes the given file.
 *
 * Remote-SSH resolves a host alias through `~/.ssh/config`, so without the
 * `Include` directive the alias would be unknown and the connection would
 * fail. The directive is added once and never duplicated.
 */
export function ensureSshConfigInclude(
  includedPath: string,
  outputChannel?: vscode.OutputChannel,
): void {
  const configPath = sshConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

  let current = "";
  if (fs.existsSync(configPath)) {
    current = fs.readFileSync(configPath, "utf8");
  }

  const directive = `Include "${includedPath}"`;
  const alreadyIncluded = current
    .split("\n")
    .some((line) => line.trim() === directive);

  if (!alreadyIncluded) {
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    const header =
      current.length === 0
        ? "# Managed by the Remote Sandbox extension\n"
        : "";
    fs.appendFileSync(
      configPath,
      `${header}${separator}${directive}\n`,
      { mode: 0o600 },
    );
    outputChannel?.appendLine(`[SSH] Added to ~/.ssh/config: ${directive}`);
  }

  outputChannel?.appendLine(
    `[SSH] ~/.ssh/config now includes ${includedPath}.`,
  );
}
