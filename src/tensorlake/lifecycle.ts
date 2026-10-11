import { getTensorlakeApiKey } from "../services/tensorlake";
import {
  extractErrorMessage,
  kindFromStatus,
  TensorlakeError,
  TensorlakeErrorKind,
} from "./errors";
import { setTensorlakeProxyBase } from "./client";

const MANAGEMENT_API_BASE = "https://api.tensorlake.ai";

export interface TensorlakeSandboxInfo {
  id: string;
  name?: string | null;
  namespace: string;
  status: string;
  ingress_endpoint?: string | null;
  sandbox_url?: string | null;
  exposed_ports?: number[] | null;
  allow_unauthenticated_access: boolean;
}

function requireApiKey(): string {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    throw new TensorlakeError(
      "Tensorlake API key is not configured.",
      TensorlakeErrorKind.Permission,
    );
  }
  return apiKey;
}

async function managementRequest(
  requestPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(`${MANAGEMENT_API_BASE}${requestPath}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
    });
  } catch (error) {
    throw new TensorlakeError(
      error instanceof Error ? error.message : String(error),
      TensorlakeErrorKind.Network,
      { cause: error },
    );
  }

  if (!response.ok) {
    const rawBody = await response.text();
    let parsedBody: unknown = rawBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // Keep plain text response.
    }
    throw new TensorlakeError(
      `Tensorlake API request failed (${response.status}): ${extractErrorMessage(parsedBody)}`,
      kindFromStatus(response.status),
      { status: response.status },
    );
  }

  return response;
}

export async function getTensorlakeSandboxInfo(
  sandboxId: string,
): Promise<TensorlakeSandboxInfo> {
  const response = await managementRequest(
    `/sandboxes/${encodeURIComponent(sandboxId)}`,
  );
  const sandbox = (await response.json()) as TensorlakeSandboxInfo;
  setTensorlakeProxyBase(sandbox.id, sandbox.sandbox_url);
  if (sandboxId !== sandbox.id) {
    setTensorlakeProxyBase(sandboxId, sandbox.sandbox_url);
  }
  return sandbox;
}

export async function resumeTensorlakeSandboxById(
  sandboxId: string,
): Promise<void> {
  await managementRequest(
    `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
    { method: "POST" },
  );
}

export async function exposeTensorlakePort(
  sandboxId: string,
  port: number,
): Promise<TensorlakeSandboxInfo> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TensorlakeError(
      "Port must be an integer between 1 and 65535.",
      TensorlakeErrorKind.InvalidArgument,
    );
  }

  const current = await getTensorlakeSandboxInfo(sandboxId);
  const exposedPorts = Array.from(
    new Set([...(current.exposed_ports ?? []), port]),
  ).sort((a, b) => a - b);

  const response = await managementRequest(
    `/sandboxes/${encodeURIComponent(current.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exposed_ports: exposedPorts,
        allow_unauthenticated_access: true,
      }),
    },
  );

  const updated = (await response.json()) as TensorlakeSandboxInfo;
  setTensorlakeProxyBase(updated.id, updated.sandbox_url);
  if (sandboxId !== updated.id) {
    setTensorlakeProxyBase(sandboxId, updated.sandbox_url);
  }
  return updated;
}

export async function removeTensorlakePort(
  sandboxId: string,
  port: number,
): Promise<TensorlakeSandboxInfo> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TensorlakeError(
      "Port must be an integer between 1 and 65535.",
      TensorlakeErrorKind.InvalidArgument,
    );
  }

  const current = await getTensorlakeSandboxInfo(sandboxId);
  const exposedPorts = (current.exposed_ports ?? []).filter(
    (exposedPort) => exposedPort !== port,
  );

  const response = await managementRequest(
    `/sandboxes/${encodeURIComponent(current.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exposed_ports: exposedPorts,
      }),
    },
  );

  const updated = (await response.json()) as TensorlakeSandboxInfo;
  setTensorlakeProxyBase(updated.id, updated.sandbox_url);
  if (sandboxId !== updated.id) {
    setTensorlakeProxyBase(sandboxId, updated.sandbox_url);
  }
  return updated;
}

export function publicTensorlakePortUrl(
  sandbox: TensorlakeSandboxInfo,
  port: number,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TensorlakeError(
      "Port must be an integer between 1 and 65535.",
      TensorlakeErrorKind.InvalidArgument,
    );
  }

  if (!sandbox.sandbox_url) {
    throw new TensorlakeError(
      "Tensorlake did not return sandbox_url for this running sandbox.",
      TensorlakeErrorKind.Unavailable,
    );
  }

  const url = new URL(sandbox.sandbox_url);
  const host = url.hostname;
  const suffixIndex = host.indexOf(".");
  if (suffixIndex <= 0) {
    throw new TensorlakeError(
      `Unexpected Tensorlake sandbox_url host: ${host}`,
      TensorlakeErrorKind.Unavailable,
    );
  }

  const identifier = host.slice(0, suffixIndex);
  const suffix = host.slice(suffixIndex + 1);
  return `https://${port}-${identifier}.${suffix}`;
}