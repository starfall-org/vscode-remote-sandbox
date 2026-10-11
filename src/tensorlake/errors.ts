import * as vscode from "vscode";

/**
 * Normalized Tensorlake error categories. The VS Code layer maps these into
 * `vscode.FileSystemError` values where appropriate.
 */
export enum TensorlakeErrorKind {
  NotFound = "NotFound",
  AlreadyExists = "AlreadyExists",
  Permission = "Permission",
  Unavailable = "Unavailable",
  InvalidArgument = "InvalidArgument",
  Conflict = "Conflict",
  Network = "Network",
  Unknown = "Unknown",
}

export class TensorlakeError extends Error {
  readonly kind: TensorlakeErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    kind: TensorlakeErrorKind = TensorlakeErrorKind.Unknown,
    options?: { status?: number; code?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "TensorlakeError";
    this.kind = kind;
    this.status = options?.status;
    this.code = options?.code;
    this.cause = options?.cause;
  }
}

interface TensorlakeErrorBody {
  error?: string | { message?: string };
  detail?: string;
  message?: string;
  code?: string;
}

/** Extract a human-readable message from a Tensorlake error response body. */
export function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") {
    return body.trim() || "Unknown error";
  }
  if (body && typeof body === "object") {
    const b = body as TensorlakeErrorBody;
    if (typeof b.error === "string") {
      return b.error;
    }
    if (b.error && typeof b.error === "object" && typeof b.error.message === "string") {
      return b.error.message;
    }
    return b.detail ?? b.message ?? "Unknown error";
  }
  return "Unknown error";
}

/** Map an HTTP status code to a normalized Tensorlake error kind. */
export function kindFromStatus(status: number): TensorlakeErrorKind {
  switch (status) {
    case 400:
      return TensorlakeErrorKind.InvalidArgument;
    case 401:
    case 403:
      return TensorlakeErrorKind.Permission;
    case 404:
      return TensorlakeErrorKind.NotFound;
    case 409:
      return TensorlakeErrorKind.Conflict;
    case 503:
      return TensorlakeErrorKind.Unavailable;
    default:
      return status >= 500 ? TensorlakeErrorKind.Unavailable : TensorlakeErrorKind.Unknown;
  }
}

/** Map a normalized Tensorlake error to a VS Code filesystem error. */
export function toFileSystemError(error: unknown): vscode.FileSystemError {
  if (error instanceof vscode.FileSystemError) {
    return error;
  }
  const tlError = error instanceof TensorlakeError ? error : undefined;
  const kind = tlError?.kind ?? TensorlakeErrorKind.Unknown;
  const message = error instanceof Error ? error.message : String(error);

  switch (kind) {
    case TensorlakeErrorKind.NotFound:
      return vscode.FileSystemError.FileNotFound(message);
    case TensorlakeErrorKind.AlreadyExists:
      return vscode.FileSystemError.FileExists(message);
    case TensorlakeErrorKind.Permission:
      return vscode.FileSystemError.NoPermissions(message);
    case TensorlakeErrorKind.InvalidArgument:
    case TensorlakeErrorKind.Unavailable:
      return vscode.FileSystemError.Unavailable(message);
    default:
      return vscode.FileSystemError.Unavailable(message);
  }
}
