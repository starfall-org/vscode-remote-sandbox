import { tensorlakeProxyJson } from "./client";

interface TensorlakeProcessInfo {
  pid: number;
  status: string;
  exit_code?: number | null;
}

interface TensorlakeProcessOutput {
  lines?: string[];
}

export interface TensorlakeProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PROCESS_POLL_INTERVAL_MS = 100;

async function getProcess(
  sandboxId: string,
  pid: number,
): Promise<TensorlakeProcessInfo> {
  return tensorlakeProxyJson<TensorlakeProcessInfo>(
    sandboxId,
    `/api/v1/processes/${pid}`,
  );
}

async function getProcessOutput(
  sandboxId: string,
  pid: number,
  stream: "stdout" | "stderr",
): Promise<string> {
  const result = await tensorlakeProxyJson<TensorlakeProcessOutput>(
    sandboxId,
    `/api/v1/processes/${pid}/${stream}`,
  );
  return (result.lines ?? []).join("\n");
}

export async function runTensorlakeProcess(
  sandboxId: string,
  command: string,
  args: string[] = [],
  workingDir?: string,
): Promise<TensorlakeProcessResult> {
  const process = await tensorlakeProxyJson<TensorlakeProcessInfo>(
    sandboxId,
    "/api/v1/processes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command,
        args,
        ...(workingDir ? { working_dir: workingDir } : {}),
      }),
    },
  );

  let current = process;
  while (current.status.toLowerCase() === "running") {
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
    current = await getProcess(sandboxId, process.pid);
  }

  const [stdout, stderr] = await Promise.all([
    getProcessOutput(sandboxId, process.pid, "stdout"),
    getProcessOutput(sandboxId, process.pid, "stderr"),
  ]);

  return {
    exitCode: current.exit_code ?? 1,
    stdout,
    stderr,
  };
}

export async function createTensorlakeDirectory(
  sandboxId: string,
  remotePath: string,
): Promise<void> {
  const result = await runTensorlakeProcess(
    sandboxId,
    "mkdir",
    ["-p", "--", remotePath],
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to create directory: ${remotePath}`);
  }
}

export async function deleteTensorlakeDirectory(
  sandboxId: string,
  remotePath: string,
  recursive: boolean,
): Promise<void> {
  const command = recursive ? "rm" : "rmdir";
  const args = recursive
    ? ["-rf", "--", remotePath]
    : ["--", remotePath];
  const result = await runTensorlakeProcess(sandboxId, command, args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to delete directory: ${remotePath}`);
  }
}

export async function renameTensorlakePath(
  sandboxId: string,
  oldPath: string,
  newPath: string,
  overwrite: boolean,
): Promise<void> {
  const args = overwrite
    ? ["-T", "-f", "--", oldPath, newPath]
    : ["-T", "--", oldPath, newPath];
  const result = await runTensorlakeProcess(sandboxId, "mv", args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to rename ${oldPath} to ${newPath}`);
  }
}
