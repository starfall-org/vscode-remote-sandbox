import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { getInstaCredential, instaApiRequest } from "./instacloudAuth";
import {
  promptSshConfigInclude,
  removeSshConfigBlocks,
  sshDirectory,
  sshPath,
  upsertSshConfigBlock,
} from "./sshConfig";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

/** The certificate the API issues for a compute service. */
export interface InstaSshCertificate {
  certificate: string;
  host: string;
  username: string;
  port: number;
  expiresAt: string;
  caPublicKey?: string;
}

export interface InstaSshPending {
  status?: string;
  approvalId?: string;
  message?: string;
  url?: string;
}

/* ------------------------------------------------------------------ */
/* Host alias                                                         */
/* ------------------------------------------------------------------ */

/**
 * Host alias used in the SSH config.
 *
 * The alias is the service name, because that is what the user recognizes
 * in the tree and in the Remote-SSH host picker. SSH host patterns cannot
 * contain spaces or most punctuation, so the name is sanitized; the service
 * id is only used as a fallback when nothing usable is left.
 */
export function instaHostAlias(serviceName: string, serviceId: string): string {
  const sanitized = serviceName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || `INSTA_${serviceId}`;
}

/* ------------------------------------------------------------------ */
/* Key material                                                       */
/* ------------------------------------------------------------------ */

interface SshKeyPair {
  privateKeyPath: string;
  publicKeyPath: string;
}

/**
 * Finds an SSH key to sign the certificate with.
 *
 * A dedicated key is generated when possible; otherwise an existing
 * default key is reused so the user is not asked to install anything.
 */
async function ensureSshKeyPair(
  outputChannel: vscode.OutputChannel,
): Promise<SshKeyPair | undefined> {
  const sshDir = path.join(os.homedir(), ".ssh");
  const keyPath = path.join(sshDir, "instacloud_ed25519");
  const pubPath = `${keyPath}.pub`;

  if (fs.existsSync(keyPath) && fs.existsSync(pubPath)) {
    return { privateKeyPath: keyPath, publicKeyPath: pubPath };
  }

  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", "remote-sandbox-instacloud", "-f", keyPath],
        (error) => (error ? reject(error) : resolve()),
      );
    });
    outputChannel.appendLine(`[InstaCloud] Generated SSH key ${keyPath}`);
    return { privateKeyPath: keyPath, publicKeyPath: pubPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(
      `[InstaCloud] Could not generate an SSH key: ${message}`,
    );
  }

  // Fall back to the user's default key.
  for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
    const candidate = path.join(sshDir, name);
    const candidatePub = `${candidate}.pub`;
    if (fs.existsSync(candidate) && fs.existsSync(candidatePub)) {
      outputChannel.appendLine(
        `[InstaCloud] Using the existing SSH key ${candidate}`,
      );
      return { privateKeyPath: candidate, publicKeyPath: candidatePub };
    }
  }

  vscode.window.showErrorMessage(
    "No SSH key found. Install OpenSSH (ssh-keygen) or create one with: ssh-keygen -t ed25519",
  );
  return undefined;
}

/* ------------------------------------------------------------------ */
/* known_hosts                                                        */
/* ------------------------------------------------------------------ */

/**
 * Adds the certificate authority to the known hosts file.
 *
 * The API returns the CA in authorized_keys form; OpenSSH wants it as a
 * `@cert-authority` anchor for the host it signs.
 */
function trustCertificateAuthority(
  host: string,
  port: number,
  caPublicKey: string,
  outputChannel: vscode.OutputChannel,
): void {
  const sshDir = sshDirectory();
  const knownHosts = path.join(sshDir, "known_hosts");
  // known_hosts matches non-default ports in the bracketed [host]:port form.
  const hostKey = port && port !== 22 ? `[${host}]:${port}` : host;
  const entry = caPublicKey.startsWith("@cert-authority")
    ? caPublicKey
    : `@cert-authority ${hostKey} ${caPublicKey}`;

  let current = "";
  if (fs.existsSync(knownHosts)) {
    current = fs.readFileSync(knownHosts, "utf8");
  }
  if (current.split("\n").some((line) => line.trim() === entry.trim())) {
    return;
  }

  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(knownHosts, `${separator}${entry}\n`, { mode: 0o600 });
  outputChannel.appendLine(
    `[InstaCloud] Trusted the InstaCloud certificate authority for ${hostKey}.`,
  );
}

/* ------------------------------------------------------------------ */
/* Connect                                                            */
/* ------------------------------------------------------------------ */

/**
 * Issues an SSH certificate for a service and writes the SSH config.
 *
 * The certificate endpoint refuses API keys: it is only reachable with an
 * interactive session, which is exactly what the sign-in flow provides.
 * A service that is not running is started first, the same way a Freestyle
 * VM is started before connecting.
 * Returns the SSH host alias on success.
 */
export async function connectInstaService(
  projectId: string,
  serviceId: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
): Promise<string | undefined> {
  const credential = await getInstaCredential();
  if (!credential) {
    vscode.window.showWarningMessage(
      "Sign in to InstaCloud before connecting to a service.",
    );
    return undefined;
  }
  if (credential.kind !== "session") {
    vscode.window.showWarningMessage(
      "Connecting over SSH needs an interactive InstaCloud session. Run “InstaCloud: Sign In”.",
    );
    outputChannel.appendLine(
      "[InstaCloud] SSH certificates are refused for API keys.",
    );
    return undefined;
  }

  try {
    outputChannel.show(true);

    // A stopped service has no SSH endpoint, so wake it up first.
    const state = await instaApiRequest<{ desiredState?: string }>(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/state`,
      "GET",
      undefined,
      credential.token,
    ).catch(() => undefined);
    if (state && state.desiredState && state.desiredState !== "running") {
      outputChannel.appendLine(
        `[InstaCloud] Service ${serviceName} is ${state.desiredState} — starting...`,
      );
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting InstaCloud service ${serviceName}...`,
          cancellable: false,
        },
        () =>
          instaApiRequest(
            `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/start`,
            "POST",
            {},
            credential.token,
          ),
      );
    }

    const keys = await ensureSshKeyPair(outputChannel);
    if (!keys) {
      return undefined;
    }
    const publicKey = fs.readFileSync(keys.publicKeyPath, "utf8").trim();

    outputChannel.appendLine(
      `[InstaCloud] Requesting an SSH certificate for ${serviceName}...`,
    );

    let cert: InstaSshCertificate;
    try {
      cert = await instaApiRequest<InstaSshCertificate>(
        `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/ssh-cert`,
        "POST",
        { publicKey, ttlSec: 21600 },
        credential.token,
      );
    } catch (error) {
      const err = error as Error & { body?: InstaSshPending };
      const pending = err.body;
      if (pending?.status === "approval_required" || pending?.approvalId) {
        const message =
          pending.message ?? "The SSH certificate needs an approval.";
        outputChannel.appendLine(`[InstaCloud] ${message}`);
        if (pending.url) {
          outputChannel.appendLine(`[InstaCloud] Approve it at: ${pending.url}`);
        }
        vscode.window.showWarningMessage(`InstaCloud: ${message}`);
        return undefined;
      }
      throw error;
    }

    const sshDir = sshDirectory();
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

    const alias = instaHostAlias(serviceName, serviceId);
    const certPath = path.join(sshDir, `instacloud_${serviceId}.cert`);
    fs.writeFileSync(certPath, `${cert.certificate}\n`, { mode: 0o600 });

    if (cert.caPublicKey) {
      trustCertificateAuthority(
        cert.host,
        cert.port,
        cert.caPublicKey,
        outputChannel,
      );
    }

    const configPath = path.join(sshDir, "instacloud.conf");

    // Drop blocks written by an older version that keyed the host on the
    // service id, they would keep a stale Host entry around.
    removeSshConfigBlocks(configPath, (marker) =>
      /^INSTACLOUD SERVICE INSTA_/.test(marker),
    );

    upsertSshConfigBlock(configPath, `INSTACLOUD SERVICE ${serviceId}`, [
      `Host ${alias}`,
      `    HostName ${cert.host}`,
      `    User ${cert.username}`,
      `    Port ${cert.port}`,
      `    IdentityFile ${sshPath(keys.privateKeyPath)}`,
      `    CertificateFile ${sshPath(certPath)}`,
      `    IdentitiesOnly yes`,
      `    StrictHostKeyChecking ${
        cert.caPublicKey ? "yes" : "accept-new"
      }`,
      `    PasswordAuthentication no`,
      `    PreferredAuthentications publickey`,
      `    RemoteCommand none`,
      `    UserKnownHostsFile ${sshPath(path.join(sshDir, "known_hosts"))}`,
      `    ServerAliveInterval 60`,
      `    ServerAliveCountMax 3`,
    ]);

    // Remote-SSH resolves the alias through ~/.ssh/config, so the
    // Include directive has to be there for the connection to work. The
    // file is only touched after the user confirms it.
    await promptSshConfigInclude(configPath, outputChannel);

    outputChannel.appendLine(
      `[InstaCloud] SSH config written to ${configPath} (Host: ${alias})`,
    );
    outputChannel.appendLine(
      `[InstaCloud] Certificate expires at ${cert.expiresAt}.`,
    );
    return alias;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[InstaCloud] SSH setup error: ${message}`);
    vscode.window.showErrorMessage(
      `Failed to connect to InstaCloud service: ${message}`,
    );
    return undefined;
  }
}
