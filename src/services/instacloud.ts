import * as vscode from "vscode";

import {
  getInstaCredential,
  instaApiRequest,
} from "./instacloudAuth";

export { getInstaApiBase } from "./instacloudAuth";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type InstaServiceType =
  | "postgres"
  | "storage"
  | "compute"
  | "redis"
  | "mysql"
  | "mongodb";

export type InstaDesiredState = "running" | "stopped" | "suspended";

export interface InstaOrg {
  id: string;
  name?: string;
  slug?: string;
  is_personal?: boolean;
  role?: string;
}

export interface InstaProject {
  id: string;
  org_id: string;
  name: string;
  status: "active" | "error" | "deleting" | "deleted";
  created_at?: string;
}

export interface InstaBranch {
  id: string;
  project_id: string;
  name: string;
  is_default?: boolean;
  status: "creating" | "active" | "error" | "deleting";
}

export interface InstaService {
  id: string;
  project_id: string;
  type: InstaServiceType;
  name: string;
  spec?: Record<string, unknown>;
  machine_count?: number;
  desired_state?: InstaDesiredState;
  always_on?: boolean;
  endpoint?: "http" | "tcp" | null;
  endpoint_host?: string | null;
  region?: string | null;
  domain?: string | null;
  image?: string | null;
  port?: number | null;
  status: "creating" | "active" | "error" | "deleting" | "deleted";
  created_at?: string;
}

export interface InstaServiceState {
  desiredState: InstaDesiredState;
  state: "running" | "suspended" | "stopped" | "none" | "unknown";
  lastFailure?: {
    kind?: string;
    at?: string;
    reason?: string;
  };
}

export interface InstaExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

/**
 * The API answers a command that needs a human decision with 202 instead of
 * 200: the command was parked, not run.
 */
export interface InstaExecPending {
  status?: string;
  approvalId?: string;
  message?: string;
  url?: string;
}

export interface InstaSshTarget {
  host: string;
  username: string;
  port: number;
}

/* ------------------------------------------------------------------ */
/* Credentials                                                        */
/* ------------------------------------------------------------------ */

/**
 * Runs an authenticated request.
 *
 * The credential is resolved per call so that a session which was signed
 * in, refreshed or signed out is picked up immediately, and so that an
 * interactive session takes precedence over a static API key.
 */
async function instaRequest<T>(
  requestPath: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const credential = await getInstaCredential();
  if (!credential) {
    promptSignIn();
    throw new Error("No InstaCloud credential is available.");
  }
  return instaApiRequest<T>(requestPath, method, body, credential.token);
}

/** Asks the user to sign in. */
function promptSignIn(): void {
  void vscode.window
    .showWarningMessage(
      "Not signed in to InstaCloud. Sign in to browse projects and services.",
      "Sign In",
    )
    .then((selection) => {
      if (selection === "Sign In") {
        vscode.commands.executeCommand("remote-sandbox.instacloudSignIn");
      }
    });
}

/**
 * Stores a static API key.
 *
 * An interactive session is preferred, but a key still works for the
 * endpoints that do not require a human session.
 */
export async function setInstaApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your InstaCloud API key (insta_...)",
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
    .update("instacloudApiKey", trimmed, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("InstaCloud API key saved to settings.");
}

/* ------------------------------------------------------------------ */
/* Orgs / Projects / Branches / Services                              */
/* ------------------------------------------------------------------ */

/** Lists the organizations the token belongs to. */
export async function listInstaOrgs(
  outputChannel?: vscode.OutputChannel,
): Promise<InstaOrg[]> {
  try {
    const response = await instaRequest<{ orgs?: InstaOrg[] }>(
      "/orgs",
    );
    const orgs = response?.orgs ?? [];
    outputChannel?.appendLine(`[InstaCloud] Listed ${orgs.length} org(s).`);
    return orgs;
  } catch (error) {
    logError(outputChannel, "listing orgs", error);
    return [];
  }
}

/** Lists the projects of an organization. */
export async function listInstaProjects(
  orgId: string,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaProject[]> {
  try {
    const response = await instaRequest<{ projects?: InstaProject[] }>(
      `/orgs/${encodeURIComponent(orgId)}/projects`,
    );
    const projects = response?.projects ?? [];
    outputChannel?.appendLine(
      `[InstaCloud] Listed ${projects.length} project(s) in org ${orgId}.`,
    );
    return projects;
  } catch (error) {
    logError(outputChannel, `listing projects of org ${orgId}`, error);
    return [];
  }
}

/** Lists the branches of a project. */
export async function listInstaBranches(
  projectId: string,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaBranch[]> {
  try {
    const response = await instaRequest<{ branches?: InstaBranch[] }>(
      `/projects/${encodeURIComponent(projectId)}/branches`,
    );
    const branches = response?.branches ?? [];
    outputChannel?.appendLine(
      `[InstaCloud] Listed ${branches.length} branch(es) in project ${projectId}.`,
    );
    return branches;
  } catch (error) {
    logError(outputChannel, `listing branches of project ${projectId}`, error);
    return [];
  }
}

/** Lists the services of a project, optionally narrowed to one branch. */
export async function listInstaServices(
  projectId: string,
  branch?: string,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaService[]> {
  try {
    const query = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    const response = await instaRequest<{ services?: InstaService[] }>(
      `/projects/${encodeURIComponent(projectId)}/services${query}`,
    );
    const services = response?.services ?? [];
    outputChannel?.appendLine(
      `[InstaCloud] Listed ${services.length} service(s) in project ${projectId}.`,
    );
    return services;
  } catch (error) {
    logError(outputChannel, `listing services of project ${projectId}`, error);
    return [];
  }
}

/** Reads the desired and live state of a service. */
export async function getInstaServiceState(
  projectId: string,
  serviceId: string,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaServiceState | undefined> {
  try {
    return await instaRequest<InstaServiceState>(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/state`,
    );
  } catch (error) {
    logError(outputChannel, `reading the state of service ${serviceId}`, error);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                          */
/* ------------------------------------------------------------------ */

type InstaLifecycleAction = "start" | "stop" | "suspend" | "restart";

async function runLifecycleAction(
  action: InstaLifecycleAction,
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `InstaCloud: ${action} ${serviceName}...`,
        cancellable: false,
      },
      () =>
        instaRequest<unknown>(
          `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/${action}`,
                    "POST",
          {},
        ),
    );
    outputChannel.appendLine(
      `[InstaCloud] ${action} succeeded for service ${serviceName} (${serviceId}).`,
    );
    vscode.window.showInformationMessage(
      `InstaCloud service ${serviceName}: ${action} done.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[InstaCloud] Error: ${action} failed for ${serviceName}: ${message}`,
    );
    vscode.window.showErrorMessage(
      `InstaCloud: ${action} failed for ${serviceName}: ${message}`,
    );
  }
}

export async function startInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  await runLifecycleAction("start", projectId, serviceId, serviceName, outputChannel);
}

export async function stopInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  await runLifecycleAction("stop", projectId, serviceId, serviceName, outputChannel);
}

export async function suspendInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  await runLifecycleAction(
    "suspend",
    projectId,
    serviceId,
    serviceName,
    outputChannel,
  );
}

export async function restartInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  await runLifecycleAction(
    "restart",
    projectId,
    serviceId,
    serviceName,
    outputChannel,
  );
}

/* ------------------------------------------------------------------ */
/* Exec                                                               */
/* ------------------------------------------------------------------ */

/**
 * Runs a one-shot command inside a compute service.
 *
 * The API takes an argv array — no shell is invoked — so a shell command
 * is run through `sh -c`. A scaled-to-zero service is woken first.
 */
export async function execInstaService(
  projectId: string,
  serviceId: string,
  command: string[],
  timeoutSec = 60,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaExecResult | undefined> {

  try {
    const response = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "InstaCloud: running command...",
        cancellable: false,
      },
      () =>
        instaRequest<InstaExecResult | InstaExecPending>(
          `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/exec`,
                    "POST",
          { command, timeoutSec },
        ),
    );

    // A parked command comes back as 202 with an approval payload instead of
    // an exit code; surfacing it as "exit=undefined" would hide the reason.
    if (!response || typeof (response as InstaExecResult).exitCode !== "number") {
      const pending = response as InstaExecPending | undefined;
      const reason =
        pending?.message ??
        "The command needs an approval before it can run.";
      outputChannel?.appendLine(
        `[InstaCloud] Command not executed in ${serviceId}: ${reason}`,
      );
      if (pending?.url) {
        outputChannel?.appendLine(`[InstaCloud] Approve it at: ${pending.url}`);
      }
      vscode.window.showWarningMessage(`InstaCloud: ${reason}`);
      return undefined;
    }

    return response as InstaExecResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(
      `[InstaCloud] Error running command in ${serviceId}: ${message}`,
    );
    vscode.window.showErrorMessage(
      `InstaCloud command failed: ${message}`,
    );
    return undefined;
  }
}

/**
 * Asks the user for a shell command and runs it in the service.
 * Returns the result so the caller can render it.
 */
export async function promptAndExecInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<InstaExecResult | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: `Command to run in InstaCloud service ${serviceName}`,
    placeHolder: "ls -la /app",
    ignoreFocusOut: true,
  });
  if (input === undefined) {
    return undefined;
  }
  const command = input.trim();
  if (!command) {
    return undefined;
  }
  // The API speaks argv only — route a shell command through `sh -c`.
  return execInstaService(
    projectId,
    serviceId,
    ["sh", "-c", command],
    60,
    outputChannel,
  );
}

/* ------------------------------------------------------------------ */
/* SSH target                                                         */
/* ------------------------------------------------------------------ */

/**
 * Reads the SSH target of a compute service.
 *
 * The target is read-only: the certificate that actually authenticates an
 * SSH session can only be minted by an interactive login, which the API
 * refuses for API keys. The extension therefore shows the target instead
 * of opening a Remote-SSH window.
 */
export async function getInstaSshTarget(
  projectId: string,
  serviceId: string,
  outputChannel?: vscode.OutputChannel,
): Promise<InstaSshTarget | undefined> {
  try {
    const target = await instaRequest<InstaSshTarget | null>(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/ssh-target`,
    );
    if (!target) {
      outputChannel?.appendLine(
        `[InstaCloud] No SSH target for service ${serviceId} (the shell lane may be off, the service stopped, or the region has no gateway).`,
      );
      return undefined;
    }
    return target;
  } catch (error) {
    logError(outputChannel, `reading the SSH target of ${serviceId}`, error);
    return undefined;
  }
}

/** Formats an SSH target as the command a user can paste into a terminal. */
export function formatInstaSshCommand(target: InstaSshTarget): string {
  return `ssh -p ${target.port} ${target.username}@${target.host}`;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function logError(
  outputChannel: vscode.OutputChannel | undefined,
  what: string,
  error: unknown,
): void {
  if (!outputChannel) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  outputChannel.appendLine(`[InstaCloud] Error ${what}: ${message}`);
}

/**
 * Lists every project across every organization the token belongs to,
 * together with the name of the organization it lives in.
 */
export async function listInstaProjectsWithOrgs(
  outputChannel?: vscode.OutputChannel,
): Promise<{ project: InstaProject; orgName?: string }[]> {
  try {
    const response = await instaRequest<{ orgs?: InstaOrg[] }>("/orgs");
    const orgs = response?.orgs ?? [];
    const result: { project: InstaProject; orgName?: string }[] = [];
    for (const org of orgs) {
      const projects = await listInstaProjects(org.id, outputChannel);
      for (const project of projects) {
        result.push({ project, orgName: org.name ?? org.slug });
      }
    }
    return result;
  } catch (error) {
    logError(outputChannel, "listing projects", error);
    return [];
  }
}
