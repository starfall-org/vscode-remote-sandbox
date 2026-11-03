import * as vscode from "vscode";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  ensureSshConfigInclude,
  sshDirectory,
  upsertSshConfigBlock,
} from "./sshConfig";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const FREESTYLE_API_BASE = "https://api.freestyle.sh";
/** The Freestyle public API lives under the /v5 prefix. */
const FREESTYLE_API_PREFIX = "/v5";
/** SSH proxy host used by every Freestyle VM. */
const FREESTYLE_SSH_HOST = "beta-ssh.freestyle.sh";
/** Key used to remember the identity that owns the SSH access tokens. */
const FREESTYLE_IDENTITY_STATE_KEY = "freestyle.identityId";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

/** Lifecycle states a Freestyle VM can be in. */
export type FreestyleVmState =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "stopped";

export interface FreestyleVM {
  id: string;
  state: FreestyleVmState;
  slug?: string | null;
  displayName?: string | null;
  /** cpu is a count, memory and storage are in MiB. */
  resources?: {
    cpu: number;
    memory: number;
    storage: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface FreestyleIdentity {
  id: string;
  managed?: boolean;
}

export interface FreestyleToken {
  id: string;
  token: string;
}

export interface FreestyleSnapshot {
  id: string;
  slug?: string | null;
  displayName?: string | null;
  sourceVmDisplayName?: string | null;
}

/* ------------------------------------------------------------------ */
/* API key handling                                                   */
/* ------------------------------------------------------------------ */

export function getFreestyleApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("freestyleApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return apiKey.trim();
  }
  const env = process.env["FREESTYLE_API_KEY"];
  if (env && env.trim().length > 0) {
    return env.trim();
  }
  return undefined;
}

export function hasFreestyleApiKey(): boolean {
  return getFreestyleApiKey() !== undefined;
}

export async function setFreestyleApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Freestyle API key",
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
    .update("freestyleApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Freestyle API key saved to settings.");
}

function promptApiKey(): void {
  void vscode.window
    .showWarningMessage(
      "No Freestyle API key found. Set remoteSandbox.freestyleApiKey or the FREESTYLE_API_KEY environment variable.",
      "Set API Key",
    )
    .then((selection) => {
      if (selection === "Set API Key") {
        vscode.commands.executeCommand("remote-sandbox.freestyleSetApiKey");
      }
    });
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                        */
/* ------------------------------------------------------------------ */

/**
 * Performs a request against the Freestyle API.
 *
 * Uses node's `https` module rather than the global `fetch` so the
 * extension also works on extension hosts running Node < 18.
 */
function freestyleRequest<T>(
  requestPath: string,
  apiKey: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(
        `${FREESTYLE_API_BASE}${FREESTYLE_API_PREFIX}${requestPath}`,
      );
    } catch {
      reject(new Error(`Invalid Freestyle API path: ${requestPath}`));
      return;
    }

    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (requestBody !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(requestBody));
    }

    const request = https.request(
      url,
      { method, headers },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            // Endpoints such as delete answer with 204 and no body.
            if (!data.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(
                new Error("Freestyle API returned an invalid JSON response."),
              );
            }
            return;
          }

          let message =
            data.trim() || response.statusMessage || "Unknown error";
          try {
            const error = JSON.parse(data) as {
              code?: string;
              message?: string;
            };
            message = error.message ?? message;
            if (error.code) {
              message = `${error.code}: ${message}`;
            }
          } catch {
            // Use the response body as-is when it is not JSON.
          }
          reject(new Error(`Freestyle API request failed (${status}): ${message}`));
        });
      },
    );

    request.on("error", reject);
    if (requestBody !== undefined) {
      request.write(requestBody);
    }
    request.end();
  });
}

/* ------------------------------------------------------------------ */
/* List VMs                                                           */
/* ------------------------------------------------------------------ */

/** Lists the Freestyle VMs visible to the configured API key. */
export async function listFreestyleVms(
  outputChannel?: vscode.OutputChannel,
): Promise<FreestyleVM[]> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    return [];
  }
  try {
    // GET /v5/vms answers with { vms: [...], totalCount, ... }.
    const response = await freestyleRequest<{
      vms?: FreestyleVM[];
      items?: FreestyleVM[];
    }>("/vms", apiKey);
    const vms = response?.vms ?? response?.items ?? [];
    outputChannel?.appendLine(`[Freestyle] Listed ${vms.length} VM(s).`);
    return vms;
  } catch (error) {
    if (outputChannel) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[Freestyle] Error listing VMs: ${message}`);
    }
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Create VM                                                          */
/* ------------------------------------------------------------------ */

interface CreateVMOptions {
  displayName?: string;
  slug?: string;
  snapshotId?: string;
  idleTimeoutSeconds?: number;
  allowOutboundInternet: boolean;
}

/** Creates a new Freestyle VM. API: POST /v5/vms */
export async function createFreestyleVm(
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return undefined;
  }

  try {
    const options = await promptForVmOptions(apiKey, outputChannel);
    if (!options) {
      return undefined;
    }

    // A VM reaches nothing it has not been allowed to: the firewall block is
    // required by the API. The SSH proxy is always allowed by the platform.
    const body: Record<string, unknown> = {
      firewall: {
        rules: options.allowOutboundInternet
          ? [{ action: "allow", source: {}, destination: { public: true } }]
          : [],
      },
    };
    if (options.displayName) {
      body.displayName = options.displayName;
    }
    if (options.slug) {
      body.slug = options.slug;
    }
    if (options.snapshotId) {
      body.snapshotId = options.snapshotId;
    }
    if (options.idleTimeoutSeconds !== undefined) {
      body.idleTimeoutSeconds = options.idleTimeoutSeconds;
    }

    const vm = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Creating Freestyle VM...",
        cancellable: false,
      },
      () => freestyleRequest<FreestyleVM>("/vms", apiKey, "POST", body),
    );

    outputChannel.appendLine(
      `[Freestyle] Created VM: ${vm.id} (state: ${vm.state})`,
    );
    vscode.window.showInformationMessage(
      `Freestyle VM created: ${vm.id} (${vm.state}). Connect to it from the tree view.`,
    );
    return vm.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error creating VM: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to create Freestyle VM: ${message}`,
    );
    return undefined;
  }
}

/** Collects the options used to create a VM. Returns undefined when the
 * user cancels any of the prompts. */
async function promptForVmOptions(
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<CreateVMOptions | undefined> {
  // Step 1: display name (optional)
  const nameStr = await vscode.window.showInputBox({
    prompt: "VM display name (optional)",
    placeHolder: "my-workspace",
    ignoreFocusOut: true,
  });
  if (nameStr === undefined) {
    return undefined;
  }
  const displayName = nameStr.trim() || undefined;

  // Step 2: slug (optional, unique in the account)
  const slugStr = await vscode.window.showInputBox({
    prompt: "VM slug (optional, unique in your account)",
    placeHolder: "my-workspace",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      return /^[a-z0-9-]{1,63}$/.test(trimmed)
        ? null
        : "Use 1-63 characters: lowercase letters, digits and dashes.";
    },
  });
  if (slugStr === undefined) {
    return undefined;
  }
  const slug = slugStr.trim() || undefined;

  // Step 3: base snapshot (optional, defines the VM size)
  const snapshotId = await pickSnapshot(apiKey, outputChannel);
  if (snapshotId === undefined) {
    return undefined;
  }

  // Step 4: firewall
  const firewallChoice = await vscode.window.showQuickPick(
    [
      {
        label: "Allow outbound internet",
        description: "Default — the VM can reach the public internet.",
      },
      {
        label: "No extra rules",
        description:
          "The VM is only reachable through the Freestyle SSH proxy.",
      },
    ],
    { placeHolder: "Choose the network rules for the new VM" },
  );
  if (!firewallChoice) {
    return undefined;
  }

  // Step 5: idle timeout
  const idleStr = await vscode.window.showInputBox({
    prompt:
      "Idle timeout in seconds (optional, leave empty to never pause for idleness)",
    placeHolder: "600",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v) {
        return null;
      }
      const n = parseInt(v, 10);
      return isNaN(n) || n < 0 ? "Must be a non-negative integer" : null;
    },
  });
  if (idleStr === undefined) {
    return undefined;
  }
  const idleTimeoutSeconds = idleStr.trim()
    ? parseInt(idleStr, 10)
    : undefined;

  return {
    displayName,
    slug,
    snapshotId,
    idleTimeoutSeconds,
    allowOutboundInternet: firewallChoice.label === "Allow outbound internet",
  };
}

/** Lets the user pick a base snapshot. Returns undefined when the user
 * cancels, or a snapshot id ("" means "platform default"). */
async function pickSnapshot(
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  let snapshots: FreestyleSnapshot[] = [];
  try {
    const response = await freestyleRequest<{
      snapshots?: FreestyleSnapshot[];
      items?: FreestyleSnapshot[];
    }>("/snapshots", apiKey);
    snapshots = response?.snapshots ?? response?.items ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[Freestyle] Could not list snapshots: ${message}`,
    );
  }

  const items = [
    {
      label: "Platform default",
      description: "The default Freestyle image",
      id: "",
    },
    ...snapshots.map((snapshot) => ({
      label:
        snapshot.displayName ??
        snapshot.sourceVmDisplayName ??
        snapshot.slug ??
        snapshot.id,
      description: snapshot.id,
      id: snapshot.id,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select the base snapshot for the new VM",
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  return picked.id;
}

/* ------------------------------------------------------------------ */
/* Pause / Start / Delete                                             */
/* ------------------------------------------------------------------ */

/** Pauses a running Freestyle VM, keeping its memory in place.
 * API: POST /v5/vms/{id}/pause */
export async function pauseFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pausing Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () =>
        freestyleRequest<FreestyleVM>(
          `/vms/${encodeURIComponent(vmId)}/pause`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Freestyle] Paused VM: ${vmId}`);
    vscode.window.showInformationMessage(
      `Freestyle VM paused: ${vmId}. Resume it to reconnect.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to pause Freestyle VM: ${message}`,
    );
  }
}

/** Starts a stopped VM, or resumes a paused one.
 * API: POST /v5/vms/{id}/start */
export async function startFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () =>
        freestyleRequest<FreestyleVM>(
          `/vms/${encodeURIComponent(vmId)}/start`,
          apiKey,
          "POST",
        ),
    );
    outputChannel.appendLine(`[Freestyle] Started VM: ${vmId}`);
    vscode.window.showInformationMessage(`Freestyle VM started: ${vmId}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to start Freestyle VM: ${message}`,
    );
  }
}

/** Deletes a Freestyle VM permanently. API: DELETE /v5/vms/{id} */
export async function deleteFreestyleVm(
  vmId: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return;
  }

  try {
    const confirm = await vscode.window.showWarningMessage(
      `Delete Freestyle VM ${vmId}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting Freestyle VM ${vmId}...`,
        cancellable: false,
      },
      () =>
        freestyleRequest<void>(
          `/vms/${encodeURIComponent(vmId)}`,
          apiKey,
          "DELETE",
        ),
    );
    outputChannel.appendLine(`[Freestyle] Deleted VM: ${vmId}`);
    vscode.window.showInformationMessage(`Freestyle VM deleted: ${vmId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to delete Freestyle VM: ${message}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Exec                                                               */
/* ------------------------------------------------------------------ */

/** Result of a command run inside a Freestyle VM. */
export interface FreestyleExecResult {
  statusCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Runs a shell command inside a running VM and waits for it to finish.
 *
 * The command is a single string that the guest's shell interprets, so
 * pipes and redirections work as they would in a terminal.
 */
export async function execFreestyleVm(
  vmIdOrSlug: string,
  command: string,
  timeoutMs = 60000,
  outputChannel?: vscode.OutputChannel,
): Promise<FreestyleExecResult | undefined> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    promptApiKey();
    return undefined;
  }

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Freestyle: running command in ${vmIdOrSlug}...`,
        cancellable: false,
      },
      () =>
        freestyleRequest<FreestyleExecResult>(
          `/vms/${encodeURIComponent(vmIdOrSlug)}/exec-await`,
          apiKey,
          "POST",
          { command, timeoutMs },
        ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(
      `[Freestyle] Error running command in ${vmIdOrSlug}: ${message}`,
    );
    vscode.window.showErrorMessage(`Freestyle command failed: ${message}`);
    return undefined;
  }
}

/**
 * Asks the user for a shell command and runs it in the VM.
 */
export async function promptAndExecFreestyleVm(
  vmIdOrSlug: string,
  vmName: string,
  outputChannel: vscode.OutputChannel,
): Promise<FreestyleExecResult | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: `Command to run in Freestyle VM ${vmName}`,
    placeHolder: "ls -la /home",
    ignoreFocusOut: true,
  });
  if (input === undefined) {
    return undefined;
  }
  const command = input.trim();
  if (!command) {
    return undefined;
  }

  return execFreestyleVm(vmIdOrSlug, command, 60000, outputChannel);
}

/* ------------------------------------------------------------------ */
/* SSH / Connect                                                      */
/* ------------------------------------------------------------------ */

/** Host alias used in the SSH config. */
export function freestyleHostAlias(vmId: string): string {
  return `FS_${vmId}`;
}

/**
 * Returns the identity used to mint SSH access tokens, creating one when
 * needed. The identity id is remembered in the extension global state so
 * repeated connections do not pile up identities.
 */
async function ensureFreestyleIdentity(
  context: vscode.ExtensionContext | undefined,
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<FreestyleIdentity> {
  const storedId = context?.globalState.get<string>(
    FREESTYLE_IDENTITY_STATE_KEY,
  );
  if (storedId) {
    try {
      const identity = await freestyleRequest<FreestyleIdentity>(
        `/identities/${encodeURIComponent(storedId)}`,
        apiKey,
      );
      if (identity?.id) {
        return identity;
      }
    } catch {
      // The identity is gone (or the API is unhappy) — mint a new one below.
      outputChannel.appendLine(
        `[Freestyle] Stored identity ${storedId} is unusable; creating a new one.`,
      );
    }
  }

  outputChannel.appendLine("[Freestyle] Creating SSH identity...");
  const identity = await freestyleRequest<FreestyleIdentity>(
    "/identities",
    apiKey,
    "POST",
    {},
  );
  if (context) {
    await context.globalState.update(
      FREESTYLE_IDENTITY_STATE_KEY,
      identity.id,
    );
  }
  return identity;
}

/**
 * Grants the identity access to the VM.
 * API: POST /v5/identities/{id}/permissions/vm
 */
async function grantFreestyleVmAccess(
  identityId: string,
  vmId: string,
  apiKey: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  outputChannel.appendLine("[Freestyle] Granting VM permission...");
  try {
    await freestyleRequest<void>(
      `/identities/${encodeURIComponent(identityId)}/permissions/vm`,
      apiKey,
      "POST",
      { vmId },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A grant that already exists is not a problem — the VM stays reachable.
    if (/already|CONFLICT|409/i.test(message)) {
      outputChannel.appendLine("[Freestyle] VM permission already granted.");
      return;
    }
    throw error;
  }
}

/**
 * Creates SSH access for a Freestyle VM by:
 * 1. Reusing (or creating) an identity
 * 2. Granting that identity access to the VM
 * 3. Minting an access token
 * 4. Writing ~/.ssh/freestyle.conf with the token embedded in the User field
 *
 * Returns the SSH host alias on success, undefined on failure.
 */
async function ensureFreestyleSshConfig(
  vmId: string,
  apiKey: string,
  outputChannel: vscode.OutputChannel,
  context?: vscode.ExtensionContext,
): Promise<string | undefined> {
  const alias = freestyleHostAlias(vmId);
  const sshDir = sshDirectory();
  const configPath = path.join(sshDir, "freestyle.conf");

  try {
    // Step 1: identity
    const identity = await ensureFreestyleIdentity(
      context,
      apiKey,
      outputChannel,
    );

    // Step 2: grant VM permission
    await grantFreestyleVmAccess(identity.id, vmId, apiKey, outputChannel);

    // Step 3: create token
    outputChannel.appendLine("[Freestyle] Creating access token...");
    const tokenResult = await freestyleRequest<FreestyleToken>(
      `/identities/${encodeURIComponent(identity.id)}/tokens`,
      apiKey,
      "POST",
      {},
    );

    // Step 4: write SSH config (token embedded in the User field)
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

    upsertSshConfigBlock(configPath, `FREESTYLE VM ${alias}`, [
      `Host ${alias}`,
      `    HostName ${FREESTYLE_SSH_HOST}`,
      `    User ${vmId}+root:${tokenResult.token}`,
      `    StrictHostKeyChecking no`,
      `    UserKnownHostsFile /dev/null`,
      `    ServerAliveInterval 60`,
      `    ServerAliveCountMax 3`,
    ]);

    // Remote-SSH resolves the alias through ~/.ssh/config, so the
    // Include directive has to be there for the connection to work.
    ensureSshConfigInclude(configPath, outputChannel);

    outputChannel.appendLine(
      `[Freestyle] SSH config written to ${configPath} (Host: ${alias})`,
    );
    return alias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] SSH setup error: ${message}`);
    return undefined;
  }
}

/**
 * Connects to a Freestyle VM by starting it when needed and writing the
 * SSH config. Returns the SSH host alias on success, undefined on failure.
 */
export async function connectFreestyleVm(
  vm: FreestyleVM,
  outputChannel: vscode.OutputChannel,
  context?: vscode.ExtensionContext,
): Promise<string | undefined> {
  const apiKey = getFreestyleApiKey();
  if (!apiKey) {
    outputChannel.appendLine("[Freestyle] API key is not configured.");
    promptApiKey();
    return undefined;
  }

  try {
    outputChannel.show(true);

    // Auto-start if stopped or paused
    if (vm.state === "stopped" || vm.state === "paused") {
      outputChannel.appendLine(
        `[Freestyle] VM ${vm.id} is ${vm.state} — starting...`,
      );
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting Freestyle VM ${vm.id}...`,
          cancellable: false,
        },
        () =>
          freestyleRequest<FreestyleVM>(
            `/vms/${encodeURIComponent(vm.id)}/start`,
            apiKey,
            "POST",
          ),
      );
    }

    return await ensureFreestyleSshConfig(
      vm.id,
      apiKey,
      outputChannel,
      context,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Freestyle] Error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to connect to Freestyle VM: ${message}`,
    );
    return undefined;
  }
}
