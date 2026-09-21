import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

const TENSORLAKE_API_BASE = "https://api.tensorlake.ai";
const TENSORLAKE_SSH_KEYS_PATH = "/platform/v1/users/me/ssh-keys";
const SSH_KEYGEN_TIMEOUT_MS = 5_000;
const SSH_AGENT_TIMEOUT_MS = 5_000;
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

interface TensorlakeCreateResponse {
  sandbox_id: string;
  status: string;
  pending_reason?: string | null;
  ingress_endpoint?: string | null;
}

interface TensorlakeSshKey {
  id: string;
  name: string;
  keyType: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt?: string | null;
}

interface TensorlakeSshKeyListResponse {
  items: TensorlakeSshKey[];
}

interface LocalSshKey {
  publicKey: string;
  fingerprint: string;
  identityFile?: string;
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

export async function setTensorlakeApiKey(
  outputChannel?: vscode.OutputChannel,
): Promise<void> {
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

  if (outputChannel) {
    await syncTensorlakeSshKeys(trimmed, outputChannel);
  }
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

async function tensorlakeRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${TENSORLAKE_API_BASE}${requestPath}`, {
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

export async function listTensorlakeSandboxes(
  outputChannel?: vscode.OutputChannel,
): Promise<TensorlakeSandbox[]> {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    return [];
  }

  try {
    const response = await tensorlakeRequest<{
      sandboxes?: TensorlakeSandbox[];
    }>("/sandboxes?limit=100", apiKey);
    const sandboxes = response.sandboxes ?? [];

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
        tensorlakeRequest<TensorlakeCreateResponse>(
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
        tensorlakeRequest<void>(
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
        tensorlakeRequest<void>(
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
        tensorlakeRequest<void>(
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

function extractPublicKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const parts = line.split(/\s+/);
    const keyTypeIndex = parts.findIndex(
      (part) =>
        part.startsWith("ssh-") ||
        part.startsWith("ecdsa-") ||
        part.startsWith("sk-"),
    );
    if (keyTypeIndex < 0 || !parts[keyTypeIndex + 1]) {
      continue;
    }

    keys.push(
      [parts[keyTypeIndex], parts[keyTypeIndex + 1], ...parts.slice(keyTypeIndex + 2)]
        .join(" ")
        .trim(),
    );
  }
  return keys;
}

function fingerprintPublicKey(publicKey: string): string | undefined {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const blob = Buffer.from(parts[1], "base64");
    if (blob.length === 0) {
      return undefined;
    }
    const digest = crypto
      .createHash("sha256")
      .update(blob)
      .digest("base64")
      .replace(/=+$/g, "");
    return `SHA256:${digest}`;
  } catch {
    return undefined;
  }
}

function listFilesRecursively(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      continue;
    }
    if (visited.has(real)) {
      continue;
    }
    visited.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function execFileText(
  command: string,
  args: string[],
  timeout: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function discoverLocalSshKeys(
  outputChannel: vscode.OutputChannel,
): Promise<LocalSshKey[]> {
  const sshDir = path.join(os.homedir(), ".ssh");
  const discovered = new Map<string, LocalSshKey>();
  const files = listFilesRecursively(sshDir);

  const addKey = (publicKey: string, identityFile?: string): void => {
    const fingerprint = fingerprintPublicKey(publicKey);
    if (!fingerprint) {
      return;
    }

    const previous = discovered.get(fingerprint);
    discovered.set(fingerprint, {
      publicKey,
      fingerprint,
      identityFile: previous?.identityFile ?? identityFile,
    });
  };

  for (const publicPath of files.filter((file) => file.endsWith(".pub"))) {
    try {
      const text = fs.readFileSync(publicPath, "utf8");
      const identityFile = publicPath.slice(0, -4);
      const usableIdentity = fs.existsSync(identityFile)
        ? identityFile
        : publicPath;
      for (const publicKey of extractPublicKeys(text)) {
        addKey(publicKey, usableIdentity);
      }
    } catch {
      // Ignore unreadable public-key files and continue scanning.
    }
  }

  const privateKeyCandidates = files.filter((file) => !file.endsWith(".pub"));
  for (const privatePath of privateKeyCandidates) {
    let header = "";
    try {
      const fd = fs.openSync(privatePath, "r");
      const buffer = Buffer.alloc(256);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      header = buffer.subarray(0, bytes).toString("utf8");
    } catch {
      continue;
    }

    if (
      !header.includes("BEGIN OPENSSH PRIVATE KEY") &&
      !header.includes("BEGIN RSA PRIVATE KEY") &&
      !header.includes("BEGIN EC PRIVATE KEY") &&
      !header.includes("BEGIN DSA PRIVATE KEY")
    ) {
      continue;
    }

    const publicKey = await execFileText(
      "ssh-keygen",
      ["-y", "-P", "", "-f", privatePath],
      SSH_KEYGEN_TIMEOUT_MS,
    );
    if (publicKey) {
      for (const key of extractPublicKeys(publicKey)) {
        addKey(key, privatePath);
      }
    }
  }

  const agentKeys = await execFileText("ssh-add", ["-L"], SSH_AGENT_TIMEOUT_MS);
  if (agentKeys) {
    for (const publicKey of extractPublicKeys(agentKeys)) {
      addKey(publicKey);
    }
  }

  outputChannel.appendLine(
    `[Tensorlake] Found ${discovered.size} unique local SSH public key(s).`,
  );
  return [...discovered.values()];
}

async function syncTensorlakeSshKeys(
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<LocalSshKey[]> {
  const localKeys = await discoverLocalSshKeys(outputChannel);
  if (localKeys.length === 0) {
    outputChannel.appendLine(
      "[Tensorlake] No local SSH keys found in ~/.ssh or ssh-agent.",
    );
    return [];
  }

  try {
    const remote = await tensorlakeRequest<TensorlakeSshKeyListResponse>(
      TENSORLAKE_SSH_KEYS_PATH,
      apiKey,
    );
    const registered = new Set(remote.items.map((key) => key.fingerprint));
    let added = 0;

    for (const localKey of localKeys) {
      if (registered.has(localKey.fingerprint)) {
        continue;
      }

      const suffix = localKey.fingerprint
        .replace(/^SHA256:/, "")
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 16);
      try {
        const created = await tensorlakeRequest<TensorlakeSshKey>(
          TENSORLAKE_SSH_KEYS_PATH,
          apiKey,
          "POST",
          {
            name: `remote-sandbox-${suffix || "local"}`,
            publicKey: localKey.publicKey,
          },
        );
        registered.add(created.fingerprint || localKey.fingerprint);
        registered.add(localKey.fingerprint);
        added += 1;
        outputChannel.appendLine(
          `[Tensorlake] Registered SSH key ${localKey.fingerprint}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("(409)")) {
          // A 409 from Tensorlake means the key is already registered.
          registered.add(localKey.fingerprint);
          outputChannel.appendLine(
            `[Tensorlake] SSH key already registered: ${localKey.fingerprint}.`,
          );
          continue;
        }
        outputChannel.appendLine(
          `[Tensorlake] Rejected SSH key ${localKey.fingerprint}: ${message}`,
        );
      }
    }

    const confirmed = localKeys.filter((key) =>
      registered.has(key.fingerprint),
    );
    outputChannel.appendLine(
      `[Tensorlake] SSH key sync complete: ${added} added, ${confirmed.length - added} already registered, ${localKeys.length - confirmed.length} rejected.`,
    );
    return confirmed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[Tensorlake] SSH key sync failed: ${message}`,
    );
    return [];
  }
}

async function waitForTensorlakeSshReady(
  sandboxId: string,
  apiKey: string,
): Promise<TensorlakeSandbox> {
  const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
  let last: TensorlakeSandbox | undefined;

  while (Date.now() < deadline) {
    last = await tensorlakeRequest<TensorlakeSandbox>(
      `/sandboxes/${encodeURIComponent(sandboxId)}`,
      apiKey,
    );

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

function tensorlakeIdentityFiles(localKeys: LocalSshKey[]): string[] {
  const sshDir = path.join(os.homedir(), ".ssh");
  const cacheDir = path.join(sshDir, "remote-sandbox-tensorlake");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const identityFiles: string[] = [];
  for (const key of localKeys) {
    if (key.identityFile && fs.existsSync(key.identityFile)) {
      identityFiles.push(key.identityFile);
      continue;
    }

    // OpenSSH can use a public-key file to select the matching private key
    // from ssh-agent when IdentitiesOnly is enabled.
    const safeFingerprint = key.fingerprint
      .replace(/^SHA256:/, "")
      .replace(/[^A-Za-z0-9_-]/g, "_");
    const publicKeyPath = path.join(cacheDir, `${safeFingerprint}.pub`);
    fs.writeFileSync(publicKeyPath, `${key.publicKey.trim()}\n`, {
      mode: 0o600,
    });
    identityFiles.push(publicKeyPath);
  }

  return [...new Set(identityFiles)];
}

function buildTensorlakeSshBlock(
  sandbox: TensorlakeSandbox,
  localKeys: LocalSshKey[],
): string {
  if (!sandbox.sandbox_url) {
    throw new Error("Tensorlake did not return sandbox_url for SSH.");
  }

  const hostname = new URL(sandbox.sandbox_url).hostname;
  const identityFiles = tensorlakeIdentityFiles(localKeys);

  const lines = [
    `Host ${tensorlakeHostAlias(sandbox)}`,
    `    HostName ${hostname}`,
    `    User ${sandbox.sandbox_id}`,
  ];

  for (const identityFile of identityFiles) {
    lines.push(`    IdentityFile "${identityFile}"`);
  }

  // Only offer keys that Tensorlake confirmed as registered. This avoids
  // exhausting MaxAuthTries when the user's ssh-agent contains many keys.
  lines.push(
    "    IdentitiesOnly yes",
    "    ServerAliveInterval 30",
    "    ServerAliveCountMax 3",
    "",
  );

  return lines.join("\n");
}

function ensureTensorlakeSshConfig(
  sandbox: TensorlakeSandbox,
  localKeys: LocalSshKey[],
  outputChannel: vscode.OutputChannel,
): string {
  const sshDir = path.join(os.homedir(), ".ssh");
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  const configPath = path.join(sshDir, "tensorlake.conf");
  const expected = buildTensorlakeSshBlock(sandbox, localKeys);
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
    let current = await tensorlakeRequest<TensorlakeSandbox>(
      `/sandboxes/${encodeURIComponent(sandbox.sandbox_id)}`,
      apiKey,
    );
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
      await tensorlakeRequest<void>(
        `/sandboxes/${encodeURIComponent(current.sandbox_id)}/resume`,
        apiKey,
        "POST",
      );
      current = await waitForTensorlakeSshReady(current.sandbox_id, apiKey);
    } else if (status !== "running" || !current.sandbox_url) {
      current = await waitForTensorlakeSshReady(current.sandbox_id, apiKey);
    }

    const localKeys = await syncTensorlakeSshKeys(apiKey, outputChannel);
    if (localKeys.length === 0) {
      throw new Error(
        "Tensorlake did not accept any local SSH key. Check the Remote Sandbox output channel for the rejected fingerprint and API error.",
      );
    }

    return ensureTensorlakeSshConfig(current, localKeys, outputChannel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Tensorlake] SSH error: ${message}`);
    vscode.window.showErrorMessage(`Tensorlake SSH error: ${message}`);
    return undefined;
  }
}