import * as vscode from "vscode";
import * as https from "https";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const INSTA_DEFAULT_API_BASE = "https://api.instacloud.com";

/**
 * The public client the InstaCloud CLI uses. The device flow is a public
 * client flow: there is no secret to protect, the user proves who they are
 * in the browser.
 */
const INSTA_DEVICE_CLIENT_ID = "insta-cli";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const SECRET_ACCESS_TOKEN = "instacloud.accessToken";
const SECRET_REFRESH_TOKEN = "instacloud.refreshToken";
const SECRET_EXPIRES_AT = "instacloud.expiresAt";
const SECRET_ACCOUNT = "instacloud.account";

/** Refresh a little before the token actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface InstaSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  account?: InstaAccount;
}

export interface InstaAccount {
  email?: string;
  name?: string;
  /** `jwt` for an interactive session, `api` for a machine API key. */
  via?: "jwt" | "api" | string;
}

export type InstaCredentialKind = "session" | "apiKey";

export interface InstaCredential {
  token: string;
  kind: InstaCredentialKind;
  account?: InstaAccount;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  // Some InstaCloud endpoints answer in camelCase.
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
  error_description?: string;
}

/* ------------------------------------------------------------------ */
/* API base                                                           */
/* ------------------------------------------------------------------ */

/** The InstaCloud API base URL. `INSTA_API_URL` overrides it. */
export function getInstaApiBase(): string {
  const env = process.env["INSTA_API_URL"];
  if (env && env.trim().length > 0) {
    return env.trim().replace(/\/+$/, "");
  }
  return INSTA_DEFAULT_API_BASE;
}

/* ------------------------------------------------------------------ */
/* Secret storage                                                     */
/* ------------------------------------------------------------------ */

let secrets: vscode.SecretStorage | undefined;

/**
 * The session is cached in memory: listing a project tree issues several
 * requests and every one of them would otherwise read the secret store.
 */
let cachedSession: InstaSession | undefined;
let cachedAccount: InstaAccount | undefined;

/**
 * Hands the extension's secret storage to this module. Tokens live in
 * secret storage rather than in settings so they never end up in a
 * settings.json that users share or commit.
 */
export function initInstaAuthStore(store: vscode.SecretStorage): void {
  secrets = store;
}

function store(): vscode.SecretStorage {
  if (!secrets) {
    throw new Error(
      "InstaCloud secret storage is not initialised. This is an extension bug.",
    );
  }
  return secrets;
}

/* ------------------------------------------------------------------ */
/* Low level request                                                  */
/* ------------------------------------------------------------------ */

/**
 * A plain JSON request against the InstaCloud API.
 *
 * Uses node's `https` module rather than the global `fetch` so the
 * extension also works on extension hosts running Node < 18.
 */
export function instaApiRequest<T>(
  requestPath: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(`${getInstaApiBase()}${requestPath}`);
    } catch {
      reject(new Error(`Invalid InstaCloud API path: ${requestPath}`));
      return;
    }

    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
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
            if (!data.trim()) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(
                new Error("InstaCloud API returned an invalid JSON response."),
              );
            }
            return;
          }

          let message = data.trim() || response.statusMessage || "Unknown error";
          try {
            const error = JSON.parse(data) as {
              error?: string;
              error_description?: string;
              message?: string;
            };
            message =
              error.error_description ?? error.message ?? error.error ?? message;
          } catch {
            // Use the response body as-is when it is not JSON.
          }
          const error = new Error(
            `InstaCloud API request failed (${status}): ${message}`,
          ) as Error & { status?: number; body?: unknown };
          error.status = status;
          try {
            error.body = JSON.parse(data);
          } catch {
            error.body = data;
          }
          reject(error);
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
/* Device flow                                                        */
/* ------------------------------------------------------------------ */

/**
 * Starts the browser login.
 *
 * The device flow is used instead of a local callback server: the user is
 * shown a short code, approves it in a browser, and the extension polls
 * for the result. Nothing has to listen on a port, which keeps the flow
 * working behind proxies and on locked-down machines.
 */
export async function signInInstaCloud(
  outputChannel?: vscode.OutputChannel,
): Promise<boolean> {
  let device: DeviceCodeResponse;
  try {
    device = await instaApiRequest<DeviceCodeResponse>(
      "/api/auth/device/code",
      "POST",
      {
        client_id: INSTA_DEVICE_CLIENT_ID,
        scope: "openid profile email offline_access",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`[InstaCloud] Sign-in failed: ${message}`);
    vscode.window.showErrorMessage(`InstaCloud sign-in failed: ${message}`);
    return false;
  }

  const verifyUrl =
    device.verification_uri_complete ?? device.verification_uri;
  outputChannel?.appendLine(
    `[InstaCloud] Sign-in code: ${device.user_code} — open ${verifyUrl}`,
  );

  await vscode.env.clipboard.writeText(device.user_code);

  const openBrowser = vscode.window.showInformationMessage(
    `Sign in to InstaCloud. Code ${device.user_code} copied to the clipboard.`,
    "Open Browser",
    "Copy Code",
  );
  const choice = await openBrowser;
  if (choice === "Copy Code") {
    await vscode.env.clipboard.writeText(device.user_code);
  }
  if (choice === "Open Browser" || choice === undefined) {
    await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
  }

  const token = await pollForDeviceToken(device, outputChannel);
  const accessToken = token?.access_token ?? token?.accessToken;
  if (!accessToken) {
    return false;
  }

  const refreshToken = token?.refresh_token ?? token?.refreshToken;
  const expiresIn = token?.expires_in ?? token?.expiresIn;

  const session: InstaSession = {
    accessToken,
    refreshToken,
    expiresAt:
      expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
  };

  await store().store(SECRET_ACCESS_TOKEN, session.accessToken);
  if (session.refreshToken) {
    await store().store(SECRET_REFRESH_TOKEN, session.refreshToken);
  }
  if (session.expiresAt !== undefined) {
    await store().store(SECRET_EXPIRES_AT, String(session.expiresAt));
  }

  const account = await getInstaAccount(session.accessToken);
  if (account) {
    session.account = account;
    cachedAccount = account;
    await store().store(SECRET_ACCOUNT, JSON.stringify(account));
  }
  cachedSession = session;

  outputChannel?.appendLine(
    `[InstaCloud] Signed in as ${account?.email ?? "unknown user"}.`,
  );
  vscode.window.showInformationMessage(
    `Signed in to InstaCloud${account?.email ? ` as ${account.email}` : ""}.`,
  );
  return true;
}

/**
 * Polls the token endpoint until the user approves the code, the code
 * expires, or the poll is cancelled.
 */
async function pollForDeviceToken(
  device: DeviceCodeResponse,
  outputChannel?: vscode.OutputChannel,
): Promise<DeviceTokenResponse | undefined> {
  const intervalMs = Math.max(1, device.interval ?? 5) * 1000;
  const deadline =
    Date.now() + Math.max(60, device.expires_in ?? 900) * 1000;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Waiting for InstaCloud sign-in...",
      cancellable: true,
    },
    async (progress, token) => {
      let delay = intervalMs;
      while (Date.now() < deadline) {
        if (token.isCancellationRequested) {
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));

        let response: DeviceTokenResponse;
        try {
          response = await instaApiRequest<DeviceTokenResponse>(
            "/api/auth/device/token",
            "POST",
            {
              grant_type: DEVICE_CODE_GRANT_TYPE,
              device_code: device.device_code,
              client_id: INSTA_DEVICE_CLIENT_ID,
            },
          );
        } catch (error) {
          const err = error as Error & { body?: { error?: string } };
          const code = err.body?.error;
          if (code === "authorization_pending") {
            continue;
          }
          if (code === "slow_down") {
            delay += intervalMs;
            continue;
          }
          if (code === "expired_token" || code === "access_denied") {
            outputChannel?.appendLine(
              `[InstaCloud] Sign-in ${code === "access_denied" ? "was denied" : "expired"}.`,
            );
            vscode.window.showErrorMessage(
              code === "access_denied"
                ? "InstaCloud sign-in was denied."
                : "The InstaCloud sign-in code expired. Please try again.",
            );
            return undefined;
          }
          const message = error instanceof Error ? error.message : String(error);
          outputChannel?.appendLine(`[InstaCloud] Sign-in failed: ${message}`);
          vscode.window.showErrorMessage(`InstaCloud sign-in failed: ${message}`);
          return undefined;
        }

        if (response?.access_token || response?.accessToken) {
          return response;
        }
      }

      vscode.window.showErrorMessage(
        "The InstaCloud sign-in timed out. Please try again.",
      );
      return undefined;
    },
  );
}

/** Exchanges a refresh token for a fresh access token. */
async function refreshSession(
  session: InstaSession,
): Promise<InstaSession | undefined> {
  if (!session.refreshToken) {
    return undefined;
  }
  try {
    const response = await instaApiRequest<DeviceTokenResponse>(
      "/api/auth/oauth2/token",
      "POST",
      {
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: INSTA_DEVICE_CLIENT_ID,
      },
    );
    const accessToken = response?.access_token ?? response?.accessToken;
    if (!accessToken) {
      return undefined;
    }
    const refreshed: InstaSession = {
      ...session,
      accessToken,
      refreshToken:
        response.refresh_token ?? response.refreshToken ?? session.refreshToken,
      expiresAt:
        response.expires_in ?? response.expiresIn
          ? Date.now() + (response.expires_in ?? response.expiresIn!) * 1000
          : session.expiresAt,
    };
    await store().store(SECRET_ACCESS_TOKEN, refreshed.accessToken);
    if (refreshed.refreshToken) {
      await store().store(SECRET_REFRESH_TOKEN, refreshed.refreshToken);
    }
    if (refreshed.expiresAt !== undefined) {
      await store().store(SECRET_EXPIRES_AT, String(refreshed.expiresAt));
    }
    cachedSession = refreshed;
    return refreshed;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Session state                                                      */
/* ------------------------------------------------------------------ */

/** Reads the stored session, refreshing it when it has expired. */
export async function getInstaSession(): Promise<InstaSession | undefined> {
  if (!secrets) {
    return undefined;
  }
  if (cachedSession) {
    return cachedSession;
  }

  const accessToken = await secrets.get(SECRET_ACCESS_TOKEN);
  if (!accessToken) {
    return undefined;
  }

  let session: InstaSession = { accessToken };
  const refreshToken = await secrets.get(SECRET_REFRESH_TOKEN);
  if (refreshToken) {
    session.refreshToken = refreshToken;
  }
  const expiresAt = await secrets.get(SECRET_EXPIRES_AT);
  if (expiresAt) {
    const parsed = Number(expiresAt);
    if (Number.isFinite(parsed)) {
      session.expiresAt = parsed;
    }
  }
  const account = await secrets.get(SECRET_ACCOUNT);
  if (account) {
    try {
      session.account = JSON.parse(account) as InstaAccount;
    } catch {
      // A malformed account blob only costs us the label in the tree.
    }
  }

  const expired =
    session.expiresAt !== undefined &&
    session.expiresAt - TOKEN_EXPIRY_MARGIN_MS <= Date.now();
  if (expired) {
    const refreshed = await refreshSession(session);
    if (!refreshed) {
      // The refresh token is gone or rejected: fall back to a clean state
      // so the user is asked to sign in again.
      await signOutInstaCloud();
      return undefined;
    }
    session = refreshed;
  }

  cachedSession = session;
  return session;
}

/** Forgets the stored session. */
export async function signOutInstaCloud(): Promise<void> {
  cachedSession = undefined;
  cachedAccount = undefined;
  if (!secrets) {
    return;
  }
  await Promise.all([
    secrets.delete(SECRET_ACCESS_TOKEN),
    secrets.delete(SECRET_REFRESH_TOKEN),
    secrets.delete(SECRET_EXPIRES_AT),
    secrets.delete(SECRET_ACCOUNT),
  ]);
}

/** Reads the profile of the signed-in user. */
export async function getInstaAccount(
  token?: string,
): Promise<InstaAccount | undefined> {
  if (!token && cachedAccount) {
    return cachedAccount;
  }
  const accessToken = token ?? (await getInstaSession())?.accessToken;
  if (!accessToken) {
    return undefined;
  }
  try {
    const response = await instaApiRequest<{
      user?: { email?: string; name?: string };
      via?: string;
    }>("/me", "GET", undefined, accessToken);
    const account: InstaAccount = {
      email: response?.user?.email,
      name: response?.user?.name,
      via: response?.via,
    };
    if (!token) {
      cachedAccount = account;
    }
    return account;
  } catch {
    return undefined;
  }
}

/**
 * The credential used for API calls.
 *
 * An interactive session wins over an API key: it is scoped to the signed-in
 * user and it is the only credential the SSH certificate endpoint accepts.
 */
export async function getInstaCredential(): Promise<InstaCredential | undefined> {
  const session = await getInstaSession();
  if (session) {
    return {
      token: session.accessToken,
      kind: "session",
      account: session.account,
    };
  }

  const config = vscode.workspace.getConfiguration("remoteSandbox");
  const apiKey = config.get<string>("instacloudApiKey");
  if (apiKey && apiKey.trim().length > 0) {
    return { token: apiKey.trim(), kind: "apiKey" };
  }
  const env = process.env["INSTA_API_KEY"];
  if (env && env.trim().length > 0) {
    return { token: env.trim(), kind: "apiKey" };
  }
  return undefined;
}

/** True when a usable credential is available. */
export async function hasInstaCredential(): Promise<boolean> {
  return (await getInstaCredential()) !== undefined;
}
