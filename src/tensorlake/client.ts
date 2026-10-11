import { getTensorlakeApiKey } from "../services/tensorlake";
import {
  extractErrorMessage,
  kindFromStatus,
  TensorlakeError,
  TensorlakeErrorKind,
} from "./errors";

const proxyBases = new Map<string, string>();

export function requireTensorlakeApiKey(): string {
  const apiKey = getTensorlakeApiKey();
  if (!apiKey) {
    throw new TensorlakeError(
      "Tensorlake API key is not configured.",
      TensorlakeErrorKind.Permission,
    );
  }
  return apiKey;
}

export function setTensorlakeProxyBase(
  sandboxId: string,
  sandboxUrl: string | undefined | null,
): void {
  if (!sandboxUrl) {
    return;
  }

  const normalized = sandboxUrl.replace(/\/+$/, "");
  proxyBases.set(sandboxId, normalized);
}

export function clearTensorlakeProxyBase(sandboxId: string): void {
  proxyBases.delete(sandboxId);
}

export function tensorlakeProxyBase(sandboxId: string): string {
  if (!sandboxId.trim()) {
    throw new TensorlakeError(
      "Tensorlake sandbox id is required.",
      TensorlakeErrorKind.InvalidArgument,
    );
  }

  return (
    proxyBases.get(sandboxId) ??
    `https://${sandboxId}.sandbox.tensorlake.ai`
  );
}

export async function tensorlakeProxyRequest(
  sandboxId: string,
  requestPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = requireTensorlakeApiKey();

  let response: Response;
  try {
    response = await fetch(`${tensorlakeProxyBase(sandboxId)}${requestPath}`, {
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

    const code =
      parsedBody && typeof parsedBody === "object" && "code" in parsedBody
        ? String((parsedBody as { code?: unknown }).code ?? "")
        : undefined;
    throw new TensorlakeError(
      `Tensorlake proxy request failed (${response.status}): ${extractErrorMessage(parsedBody)}`,
      kindFromStatus(response.status),
      { status: response.status, code },
    );
  }

  return response;
}

export async function tensorlakeProxyJson<T>(
  sandboxId: string,
  requestPath: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await tensorlakeProxyRequest(sandboxId, requestPath, init);
  return (await response.json()) as T;
}
