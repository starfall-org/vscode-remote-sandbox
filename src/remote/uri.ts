import * as path from "path";
import * as vscode from "vscode";

export const TENSORLAKE_SCHEME = "tensorlake";
export const TENSORLAKE_HOME = "/home/tl-user";
export const DEFAULT_TENSORLAKE_WORKSPACE = `${TENSORLAKE_HOME}/workspace`;

const LEGACY_TENSORLAKE_URI_NAMESPACE = "/.tensorlake";

function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(
    remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  );
  return normalized === "." ? "/" : normalized;
}

export function tensorlakeUri(
  sandboxId: string,
  remotePath = DEFAULT_TENSORLAKE_WORKSPACE,
  _sandboxName?: string | null,
): vscode.Uri {
  const normalizedSandboxId = sandboxId.trim();
  if (!normalizedSandboxId) {
    throw new Error("Tensorlake sandbox id is required.");
  }

  return vscode.Uri.from({
    scheme: TENSORLAKE_SCHEME,
    authority: normalizedSandboxId,
    path: normalizeRemotePath(remotePath),
  });
}

export function parseTensorlakeUri(uri: vscode.Uri): {
  sandboxId: string;
  remotePath: string;
} {
  if (uri.scheme !== TENSORLAKE_SCHEME || !uri.authority) {
    throw vscode.FileSystemError.Unavailable("Invalid Tensorlake URI.");
  }

  // Backward compatibility for named workspaces opened by <= 0.0.15.
  const legacyQuery = new URLSearchParams(uri.query);
  const legacySandboxId = legacyQuery.get("sandboxId")?.trim();
  if (legacySandboxId) {
    return {
      sandboxId: legacySandboxId,
      remotePath: normalizeRemotePath(uri.path || "/"),
    };
  }

  // Backward compatibility for the 0.0.16 path-namespaced URI format.
  const legacyPrefix = `${LEGACY_TENSORLAKE_URI_NAMESPACE}/`;
  if (uri.path.startsWith(legacyPrefix)) {
    const remainder = uri.path.slice(legacyPrefix.length);
    const separator = remainder.indexOf("/");
    if (separator <= 0) {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake URI.");
    }

    let sandboxId: string;
    try {
      sandboxId = decodeURIComponent(remainder.slice(0, separator)).trim();
    } catch {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake sandbox id.");
    }
    if (!sandboxId) {
      throw vscode.FileSystemError.Unavailable("Invalid Tensorlake sandbox id.");
    }

    return {
      sandboxId,
      remotePath: normalizeRemotePath(remainder.slice(separator) || "/"),
    };
  }

  return {
    sandboxId: uri.authority,
    remotePath: normalizeRemotePath(uri.path || "/"),
  };
}
