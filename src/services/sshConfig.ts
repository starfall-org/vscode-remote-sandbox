import { execFile } from "node:child_process";
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

/**
 * Formats a native path so that OpenSSH accepts it.
 *
 * Two things matter here:
 *
 * - OpenSSH treats a backslash as an escape character, so a Windows path
 *   such as `C:\Users\me\.ssh\key` has to be written with forward slashes.
 * - A path that contains spaces has to be quoted, otherwise the value is
 *   split into several arguments.
 */
export function sshPath(target: string): string {
  const resolved = path.resolve(target).replace(/\\/g, "/");
  return /\s/.test(resolved) ? `"${resolved}"` : resolved;
}

/**
 * The platform's "no file" device, used to disable host key checks.
 * `/dev/null` does not exist on Windows.
 */
export function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
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
/* Verification                                                       */
/* ------------------------------------------------------------------ */

export interface SshCheckResult {
  ok: boolean;
  /** The output of the ssh client, useful for diagnosing a failure. */
  output: string;
}

/**
 * Runs a harmless command over the given host to verify that the
 * generated SSH configuration actually works.
 *
 * Without this check a broken configuration only surfaces much later as
 * the generic Remote-SSH error "Failed to set up dynamic port forwarding
 * connection over SSH to the VS Code Server", which hides the real cause
 * (a bad `Include`, an unparsable path, a rejected key, ...).
 */
export function verifySshHost(
  hostAlias: string,
  timeoutMs = 20000,
): Promise<SshCheckResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        hostAlias,
        "true",
      ],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (!error && !output) {
          resolve({ ok: true, output });
          return;
        }
        if (!error) {
          resolve({ ok: true, output });
          return;
        }
        resolve({ ok: false, output: output || error.message });
      },
    );
    child.on("error", (error: Error) => {
      resolve({ ok: false, output: error.message });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Inspection & cleanup                                               */
/* ------------------------------------------------------------------ */

export interface SshConfigBlock {
  marker: string;
  lines: string[];
}

/**
 * Parses an SSH config file into its delimited `# BEGIN` / `# END` blocks.
 * Returns an empty list when the file does not exist.
 */
export function readSshConfigBlocks(
  configPath: string,
): SshConfigBlock[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const current = fs.readFileSync(configPath, "utf8");
  const blocks: SshConfigBlock[] = [];
  const pattern = /^# BEGIN (.+)\r?\n([\s\S]*?)^# END \1\r?\n?/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(current)) !== null) {
    blocks.push({
      marker: match[1],
      lines: match[2]
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.trim().length > 0),
    });
  }
  return blocks;
}

/**
 * Removes every block whose marker matches the predicate.
 * Used to drop stale entries left behind by an older naming scheme.
 */
export function removeSshConfigBlocks(
  configPath: string,
  predicate: (marker: string) => boolean,
): number {
  if (!fs.existsSync(configPath)) {
    return 0;
  }
  const current = fs.readFileSync(configPath, "utf8");
  const pattern = /^# BEGIN (.+)\r?\n[\s\S]*?^# END \1\r?\n?/gm;
  let removed = 0;
  const next = current.replace(pattern, (block, marker: string) => {
    if (!predicate(marker)) {
      return block;
    }
    removed += 1;
    return "";
  });
  if (removed > 0) {
    fs.writeFileSync(configPath, next, { mode: 0o600 });
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* Include                                                            */
/* ------------------------------------------------------------------ */

/**
 * Strips the quoting from an `Include` target so that two spellings of
 * the same path compare equal.
 */
function normalizeIncludeTarget(value: string): string {
  return value
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .replace(/\\/g, "/");
}

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

  const directive = `Include ${sshPath(includedPath)}`;
  const existing = current.split(/\r?\n/);

  // Drop an Include that points at the same file, we re-add it at the top.
  // Both sides are compared unquoted, otherwise a path that contains
  // spaces would never match and a stale Include would survive.
  const target = normalizeIncludeTarget(includedPath);
  const kept = existing.filter((line) => {
    const trimmed = line.trim();
    if (!/^include\s+/i.test(trimmed)) {
      return true;
    }
    const value = trimmed.replace(/^include\s+/i, "");
    return normalizeIncludeTarget(value) !== target;
  });

  const header = [
    "# Managed by the Remote Sandbox extension",
    "# The Include below has to stay at the top: OpenSSH keeps the FIRST",
    "# value it finds for a directive, so a 'Host *' block further down",
    "# would otherwise override the settings written for the sandboxes.",
  ];

  const body = kept.join("\n").replace(/^\n+/, "");
  const merged = [
    ...header,
    directive,
    ...(body.trim().length > 0 ? ["", body] : []),
  ].join("\n");

  fs.writeFileSync(configPath, `${merged.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, {
    mode: 0o600,
  });

  outputChannel?.appendLine(`[SSH] ~/.ssh/config now includes ${includedPath}.`);
}
