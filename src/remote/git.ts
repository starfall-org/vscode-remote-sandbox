import * as path from "path";
import {
  createTensorlakeDirectory,
  runTensorlakeProcess,
} from "../tensorlake/processes";
import { DEFAULT_TENSORLAKE_WORKSPACE } from "./uri";

export async function tensorlakeHasGit(sandboxId: string): Promise<boolean> {
  try {
    const result = await runTensorlakeProcess(sandboxId, "git", ["--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function repositoryFolderName(repositoryUrl: string): string {
  const normalized = repositoryUrl.trim().replace(/\/+$/, "");
  const lastPart = normalized.split(/[/:]/).pop() ?? "repository";
  const name = lastPart.replace(/\.git$/i, "").trim();
  return name || "repository";
}

export async function cloneTensorlakeGitRepository(
  sandboxId: string,
  repositoryUrl: string,
  parentPath = DEFAULT_TENSORLAKE_WORKSPACE,
): Promise<string> {
  await createTensorlakeDirectory(sandboxId, parentPath);

  const destination = path.posix.join(
    parentPath,
    repositoryFolderName(repositoryUrl),
  );
  const result = await runTensorlakeProcess(
    sandboxId,
    "git",
    ["clone", "--progress", "--", repositoryUrl, destination],
    parentPath,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Git clone failed with exit code ${result.exitCode}.`,
    );
  }
  return destination;
}
