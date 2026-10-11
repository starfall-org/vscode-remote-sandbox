import * as path from "path";
import * as vscode from "vscode";
import {
  listTensorlakeDirectory,
  statTensorlakePath,
} from "../tensorlake/files";
import {
  TensorlakeError,
  TensorlakeErrorKind,
} from "../tensorlake/errors";
import { DEFAULT_TENSORLAKE_WORKSPACE } from "./uri";

interface FolderPickItem extends vscode.QuickPickItem {
  action: "select" | "up" | "folder";
  remotePath: string;
}

async function directoryExists(
  sandboxId: string,
  remotePath: string,
): Promise<boolean> {
  try {
    const stat = await statTensorlakePath(sandboxId, remotePath);
    return stat.type === "directory";
  } catch (error) {
    if (
      error instanceof TensorlakeError &&
      error.kind === TensorlakeErrorKind.NotFound
    ) {
      return false;
    }
    throw error;
  }
}

export async function pickTensorlakeFolder(
  sandboxId: string,
): Promise<string | undefined> {
  let current = (await directoryExists(
    sandboxId,
    DEFAULT_TENSORLAKE_WORKSPACE,
  ))
    ? DEFAULT_TENSORLAKE_WORKSPACE
    : "/";

  while (true) {
    const entries = await listTensorlakeDirectory(sandboxId, current);
    const items: FolderPickItem[] = [
      {
        label: "$(folder-opened) Open this folder",
        description: current,
        action: "select",
        remotePath: current,
      },
    ];

    if (current !== "/") {
      items.push({
        label: "$(arrow-up) ..",
        description: path.posix.dirname(current),
        action: "up",
        remotePath: path.posix.dirname(current),
      });
    }

    items.push(
      ...entries
        .filter((entry) => entry.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          label: `$(folder) ${entry.name}`,
          description: path.posix.join(current, entry.name),
          action: "folder" as const,
          remotePath: path.posix.join(current, entry.name),
        })),
    );

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Open folder on Tensorlake · ${current}`,
      matchOnDescription: true,
    });
    if (!picked) {
      return undefined;
    }
    if (picked.action === "select") {
      return picked.remotePath;
    }
    current = picked.remotePath;
  }
}