import * as path from "path";
import {
  tensorlakeProxyJson,
  tensorlakeProxyRequest,
} from "./client";
import {
  TensorlakeError,
  TensorlakeErrorKind,
} from "./errors";

export interface TensorlakeDirectoryEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
}

interface RawDirectoryEntry {
  name?: unknown;
  is_dir?: unknown;
  isDirectory?: unknown;
  type?: unknown;
  size?: unknown;
  mtime?: unknown;
  modified_at?: unknown;
}

interface RawDirectoryListing {
  entries?: RawDirectoryEntry[];
}

export interface TensorlakeRemoteStat {
  type: "file" | "directory";
  size: number;
  mtime: number;
}

function normalizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(
    remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
  );
  return normalized === "." ? "/" : normalized;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function normalizeEntry(raw: RawDirectoryEntry): TensorlakeDirectoryEntry | undefined {
  if (typeof raw.name !== "string" || !raw.name) {
    return undefined;
  }
  const isDirectory =
    raw.is_dir === true ||
    raw.isDirectory === true ||
    raw.type === "directory" ||
    raw.type === "dir";

  return {
    name: raw.name,
    isDirectory,
    size: typeof raw.size === "number" ? raw.size : undefined,
    modifiedAt: normalizeTimestamp(raw.modified_at ?? raw.mtime),
  };
}

function fileApiPath(endpoint: string, remotePath: string): string {
  return `${endpoint}?path=${encodeURIComponent(normalizeRemotePath(remotePath))}`;
}

export async function listTensorlakeDirectory(
  sandboxId: string,
  remotePath: string,
): Promise<TensorlakeDirectoryEntry[]> {
  const response = await tensorlakeProxyJson<RawDirectoryListing | RawDirectoryEntry[]>(
    sandboxId,
    fileApiPath("/api/v1/files/list", remotePath),
  );

  const rawEntries = Array.isArray(response) ? response : response.entries ?? [];
  return rawEntries
    .map(normalizeEntry)
    .filter((entry): entry is TensorlakeDirectoryEntry => entry !== undefined);
}

export async function statTensorlakePath(
  sandboxId: string,
  remotePath: string,
): Promise<TensorlakeRemoteStat> {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === "/") {
    return { type: "directory", size: 0, mtime: 0 };
  }

  const parent = path.posix.dirname(normalized);
  const basename = path.posix.basename(normalized);
  const entries = await listTensorlakeDirectory(sandboxId, parent);
  const entry = entries.find((candidate) => candidate.name === basename);
  if (!entry) {
    throw new TensorlakeError(
      `Remote path not found: ${normalized}`,
      TensorlakeErrorKind.NotFound,
      { status: 404 },
    );
  }

  return {
    type: entry.isDirectory ? "directory" : "file",
    size: entry.size ?? 0,
    mtime: entry.modifiedAt ?? 0,
  };
}

export async function readTensorlakeFile(
  sandboxId: string,
  remotePath: string,
): Promise<Uint8Array> {
  const response = await tensorlakeProxyRequest(
    sandboxId,
    fileApiPath("/api/v1/files", remotePath),
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function writeTensorlakeFile(
  sandboxId: string,
  remotePath: string,
  content: Uint8Array,
): Promise<void> {
  await tensorlakeProxyRequest(
    sandboxId,
    fileApiPath("/api/v1/files", remotePath),
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(content),
    },
  );
}

export async function deleteTensorlakePath(
  sandboxId: string,
  remotePath: string,
): Promise<void> {
  await tensorlakeProxyRequest(
    sandboxId,
    fileApiPath("/api/v1/files", remotePath),
    { method: "DELETE" },
  );
}
