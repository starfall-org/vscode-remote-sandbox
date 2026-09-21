import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TENSORLAKE_SANDBOX_API_BASE = "https://sandbox.tensorlake.ai";
const SSH_READY_TIMEOUT_MS = 30_000;

export interface TensorlakeSandbox {
  sandbox_id: string;
  name?: string | null;
  namespace?: string;
  status: string;
  image?: string | null;
  sandbox_url?: string | null;
  ingress_endpoint?: string | null;
  resources?: {
    cpus?: number;
    memory_mb?: number;
    disk_mb?: number;
  };
  timeout_secs?: number;
}

type TensorlakeSandboxApi = Omit<TensorlakeSandbox, "sandbox_id"> & {
  sandbox_id?: string;
  id?: string;
};

interface TensorlakeCreateResponse {
  sandbox_id: string;
  status: string;
  pending_reason?: string | null;
  ingress_endpoint?: string | null;
}

export function getTensorlakeApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("tensorlakeApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  const env = process.env["TENSORLAKE_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }

  return undefined;
}

export function hasTensorlakeApiKey(): boolean {
  return getTensorlakeApiKey() !== undefined;
}

export async function setTensorlakeApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Tensorlake API key",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }

  const trimmed = key.trim();
  if (!trimmed) {
    vscode.window.showErrorMessage("API key cannot be empty.");
    return;
  }

  await vscode.workspace
    .getConfiguration("remoteSandbox")
    .update("tensorlakeApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Tensorlake API key saved to settings.");


}

function promptApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No Tensorlake API key found. Set remoteSandbox.tensorlakeApiKey, run Tensorlake: Set API Key, or set TENSORLAKE_API_KEY.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        void vscode.commands.executeCommand("remote-sandbox.tensorlakeSetApiKey");
      }
    });
}

async function tensorlakeRequestWithBase<T>(
  baseUrl: string,
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(requestBody ? { "Content-Type": "application/json" } : {}),
    },
    body: requestBody,
  });

  const text = await response.text();
  if (!response.ok) {
    let message = text.trim() || response.statusText || "Unknown error";
    try {
      const parsed = JSON.parse(text) as {
        detail?: string;
        message?: string;
        error?: string | { message?: string };
      };
      if (typeof parsed.error === "string") {
        message = parsed.error;
      } else {
        message =
          parsed.detail ??
          parsed.message ??
          parsed.error?.message ??
          message;
      }
    } catch {
      // Use response text as-is.
    }
    throw new Error(
      `Tensorlake API request failed (${response.status}): ${message}`,
    );
  }

  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function tensorlakeSandboxRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return tensorlakeRequestWithBase<T>(
    TENSORLAKE_SANDBOX_API_BASE,
    requestPath,
    apiKey,
    method,
    body,
  );
}

function normalizeTensorlakeSandbox(
  raw: TensorlakeSandboxApi,
): TensorlakeSandbox | undefined {
  const sandboxId = raw.sandbox_id ?? raw.id;
  if (!sandboxId) {
    return undefined;
  }
  const { id: _id, ...rest } = raw;
  return {
    ...rest,
    sandbox_id: sandboxId,
  };
}

async function getTensorlakeSandbox(
  sandboxId: string,
  apiKey: string,
): Promise<TensorlakeSandbox> {
  const raw = await tensorlakeSandboxRequest<TensorlakeSandboxApi>(
    `/sandboxes/${encodeURIComponent(sandboxId)}`,
    apiKey,
  );
  const sandbox = normalizeTensorlakeSandbox(raw);
  if (!sandbox) {
    throw new Error("Tensorlake returned sandbox data without an id.");
  }
  return sandbox;
}

export async function listTensorlakeSandboxes(
  outputChannel?: vscode.OutputChannel,
): Promise<TensorlakeSandbox[]> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    return [];
  }

  try {
    const response = await tensorlakeSandboxRequest<{
      sandboxes?: TensorlakeSandboxApi[];
    }>("/sandboxes?limit=100", apiKey);
    const sandboxes = (response.sandboxes ?? [])
      .map(normalizeTensorlakeSandbox)
      .filter((sandbox): sandbox is TensorlakeSandbox => Boolean(sandbox));

    outputChannel?.appendLine(
      `[Tensorlake] Listed ${sandboxes.length} sandbox(es).`,
    );
    return sandboxes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(
      `[Tensorlake] Error listing sandboxes: ${message}`,
    );
    return [];
  }
}

export async function createTensorlakeSandbox(
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return undefined;
  }

  const nameInput = await vscode.window.showInputBox({
    prompt:
      "Sandbox name (recommended for suspend/resume; leave empty for ephemeral)",
    placeHolder: "my-dev",
    ignoreFocusOut: true,
  });
  if (nameInput === undefined) {
    return undefined;
  }

  const cpuInput = await vscode.window.showInputBox({
    prompt: "CPU cores (leave empty for Tensorlake default)",
    placeHolder: "1",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      return !Number.isFinite(n) || n <= 0 ? "Must be a positive number" : null;
    },
  });
  if (cpuInput === undefined) {
    return undefined;
  }

  const memoryInput = await vscode.window.showInputBox({
    prompt: "Memory in MiB (leave empty for Tensorlake default)",
    placeHolder: "1024",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      return !Number.isInteger(n) || n <= 0
        ? "Must be a positive integer"
        : null;
    },
  });
  if (memoryInput === undefined) {
    return undefined;
  }

  const diskInput = await vscode.window.showInputBox({
    prompt: "Root disk in MiB (leave empty for default 10240)",
    placeHolder: "10240",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      return !Number.isInteger(n) || n < 10240
        ? "Must be an integer of at least 10240 MiB"
        : null;
    },
  });
  if (diskInput === undefined) {
    return undefined;
  }

  const timeoutInput = await vscode.window.showInputBox({
    prompt: "Sandbox timeout in seconds (0 = plan maximum; empty = default)",
    placeHolder: "600",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      return !Number.isInteger(n) || n < 0
        ? "Must be a non-negative integer"
        : null;
    },
  });
  if (timeoutInput === undefined) {
    return undefined;
  }

  const body: Record<string, unknown> = {};
  const name = nameInput.trim();
  if (name) {
    body.name = name;
  }

  const resources: Record<string, number> = {};
  if (cpuInput.trim()) {
    resources.cpus = Number(cpuInput);
  }
  if (memoryInput.trim()) {
    resources.memory_mb = Number(memoryInput);
  }
  if (diskInput.trim()) {
    resources.disk_mb = Number(diskInput);
  }
  if (Object.keys(resources).length > 0) {
    body.resources = resources;
  }
  if (timeoutInput.trim()) {
    body.timeout_secs = Number(timeoutInput);
  }

  try {
    const created = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Tensorlake sandbox...",
        cancellable: false,
      },
      () =>
        tensorlakeSandboxRequest<TensorlakeCreateResponse>(
          "/sandboxes",
          apiKey,
          "POST",
          body,
        ),
    );

    outputChannel.appendLine(
      `[Tensorlake] Created sandbox: ${created.sandbox_id}`,
    );
    vscode.window.showInformationMessage(
      `Tensorlake sandbox created: ${name || created.sandbox_id}.`,
    );
    return created.sandbox_id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[Tensorlake] Error creating sandbox: ${message}`,
    );
    vscode.window.showErrorMessage(
      `Failed to create Tensorlake sandbox: ${message}`,
    );
    return undefined;
  }
}

export async function suspendTensorlakeSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Suspending Tensorlake sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        tensorlakeSandboxRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}/suspend`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(
      `[Tensorlake] Suspended sandbox: ${sandboxId}`,
    );
    vscode.window.showInformationMessage(
      `Tensorlake sandbox suspended: ${sandboxId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to suspend Tensorlake sandbox: ${message}`,
    );
  }
}

export async function resumeTensorlakeSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resuming Tensorlake sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        tensorlakeSandboxRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Tensorlake] Resumed sandbox: ${sandboxId}`);
    vscode.window.showInformationMessage(
      `Tensorlake sandbox resumed: ${sandboxId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to resume Tensorlake sandbox: ${message}`,
    );
  }
}

export async function deleteTensorlakeSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Terminate Tensorlake sandbox ${sandboxId}? This cannot be undone.`,
    { modal: true },
    "Terminate",
  );
  if (confirm !== "Terminate") {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Terminating Tensorlake sandbox ${sandboxId}...`,
        cancellable: false,
      },
      () =>
        tensorlakeSandboxRequest<void>(
          `/sandboxes/${encodeURIComponent(sandboxId)}`,
          apiKey,
          "DELETE",
        ),
    );
    outputChannel.appendLine(
      `[Tensorlake] Terminated sandbox: ${sandboxId}`,
    );
    vscode.window.showInformationMessage(
      `Tensorlake sandbox terminated: ${sandboxId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to terminate Tensorlake sandbox: ${message}`,
    );
  }
}

function tensorlakeHostAlias(sandbox: TensorlakeSandbox): string {
  return sandbox.name ? `TL_${sandbox.name}` : `TL_${sandbox.sandbox_id}`;
}

async function waitForTensorlakeSshReady(
  sandboxId: string,
  apiKey: string,
): Promise<TensorlakeSandbox> {
  const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
  let last: TensorlakeSandbox | undefined;

  while (Date.now() < deadline) {
    last = await getTensorlakeSandbox(sandboxId, apiKey);

    const status = last.status.toLowerCase();
    if (status === "running" && last.sandbox_url) {
      return last;
    }
    if (status === "terminated" || status === "failed") {
      throw new Error(`Sandbox is ${last.status} and cannot be connected.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Sandbox did not become SSH-ready within ${SSH_READY_TIMEOUT_MS / 1000} seconds (last status: ${last?.status ?? "unknown"}).`,
  );
}

function buildTensorlakeSshBlock(
  sandbox: TensorlakeSandbox,
): string {
  if (!sandbox.sandbox_url) {
    throw new Error("Tensorlake did not return sandbox_url for SSH.");
  }

  const hostname = new URL(sandbox.sandbox_url).hostname;

  const lines = [
    `Host ${tensorlakeHostAlias(sandbox)}`,
    `    HostName ${hostname}`,
    `    User ${sandbox.sandbox_id}`,
    "    IdentityFile ~/.ssh/id_ed25519_tensorlake",
    "    IdentitiesOnly yes",
    "    ServerAliveInterval 30",
    "    ServerAliveCountMax 3",
    "",
  ];

  return lines.join("\n");
}

function ensureTensorlakeSshConfig(
  sandbox: TensorlakeSandbox,
  outputChannel: vscode.OutputChannel,
): string {
  const sshDir = path.join(os.homedir(), ".ssh");
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  const configPath = path.join(sshDir, "tensorlake.conf");
  const expected = buildTensorlakeSshBlock(sandbox);
  const existing = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  if (existing.trim() !== expected.trim()) {
    fs.writeFileSync(configPath, expected, { mode: 0o600 });
    outputChannel.appendLine(
      `[Tensorlake] SSH config written to ${configPath}.`,
    );
  } else {
    outputChannel.appendLine(
      `[Tensorlake] SSH config already up to date (Host: ${tensorlakeHostAlias(sandbox)}).`,
    );
  }

  outputChannel.appendLine("[Tensorlake] Ensure ~/.ssh/config contains:");
  outputChannel.appendLine(`Include "${configPath}"`);

  return tensorlakeHostAlias(sandbox);
}

export async function connectTensorlakeSandbox(
  sandbox: TensorlakeSandbox,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[Tensorlake] API key is not configured.");
    promptApiKey();
    return undefined;
  }

  outputChannel.show(true);

  try {
    let current = await getTensorlakeSandbox(sandbox.sandbox_id, apiKey);
    const status = current.status.toLowerCase();

    if (status === "suspended") {
      if (!current.name) {
        throw new Error(
          "This sandbox is suspended but has no name, so it cannot be resumed.",
        );
      }
      outputChannel.appendLine(
        `[Tensorlake] Resuming sandbox: ${current.sandbox_id}`,
      );
      await tensorlakeSandboxRequest<void>(
        `/sandboxes/${encodeURIComponent(current.sandbox_id)}/resume`,
        apiKey,
        "POST",
      );
      current = await waitForTensorlakeSshReady(current.sandbox_id, apiKey);
    } else if (status !== "running" || !current.sandbox_url) {
      current = await waitForTensorlakeSshReady(current.sandbox_id, apiKey);
    }

    return ensureTensorlakeSshConfig(current, outputChannel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] SSH error: ${message}`);
    vscode.window.showErrorMessage(`Tensorlake SSH error: ${message}`);
    return undefined;
  }
}