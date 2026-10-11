import * as vscode from "vscode";

const TENSORLAKE_SANDBOX_API_BASE = "https://api.tensorlake.ai";

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
    .getConfiguration("remoteTensorlake")
    .update("tensorlakeApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Tensorlake API key saved to settings.");


}

function promptApiKey(): void {
  vscode.window
    .showWarningMessage(
      "No Tensorlake API key found. Set remoteTensorlake.tensorlakeApiKey, run Tensorlake: Set API Key, or set TENSORLAKE_API_KEY.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        void vscode.commands.executeCommand("remote-tensorlake.tensorlakeSetApiKey");
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
): Promise<boolean> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return false;
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
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to suspend Tensorlake sandbox: ${message}`,
    );
    return false;
  }
}

export async function resumeTensorlakeSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return false;
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
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to resume Tensorlake sandbox: ${message}`,
    );
    return false;
  }
}

export async function deleteTensorlakeSandbox(
  sandboxId: string,
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    promptApiKey();
    return false;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Terminate Tensorlake sandbox ${sandboxId}? This cannot be undone.`,
    { modal: true },
    "Terminate",
  );
  if (confirm !== "Terminate") {
    return false;
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
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to terminate Tensorlake sandbox: ${message}`,
    );
    return false;
  }
}
