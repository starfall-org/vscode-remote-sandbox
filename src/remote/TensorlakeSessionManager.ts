import * as vscode from "vscode";
import {
  getTensorlakeSandboxInfo,
  resumeTensorlakeSandboxById,
  TensorlakeSandboxInfo,
} from "../tensorlake/lifecycle";

const READY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;
const RUNNING_CACHE_MS = 10_000;

interface CachedSandbox {
  sandbox: TensorlakeSandboxInfo;
  expiresAt: number;
}

export class TensorlakeSessionManager implements vscode.Disposable {
  private readonly connecting = new Map<
    string,
    Promise<TensorlakeSandboxInfo>
  >();
  private readonly cache = new Map<string, CachedSandbox>();
  private readonly manuallySuspended = new Set<string>();

  constructor(private readonly output: vscode.OutputChannel) {}

  ensureRunning(
    sandboxId: string,
    explicitResume = false,
  ): Promise<TensorlakeSandboxInfo> {
    if (explicitResume) {
      this.manuallySuspended.delete(sandboxId);
    } else if (this.manuallySuspended.has(sandboxId)) {
      return Promise.reject(
        new Error(
          `Tensorlake sandbox ${sandboxId} was suspended manually. Use Connect or Open Terminal to resume it.`,
        ),
      );
    }

    const cached = this.cache.get(sandboxId);
    if (cached && cached.expiresAt > Date.now()) {
      this.output.appendLine(
        `[Tensorlake] Session cache hit: sandbox=${sandboxId} status=${cached.sandbox.status}`,
      );
      return Promise.resolve(cached.sandbox);
    }

    const existing = this.connecting.get(sandboxId);
    if (existing) {
      this.output.appendLine(
        `[Tensorlake] Reusing in-flight connection: sandbox=${sandboxId}`,
      );
      return existing;
    }

    const pending = this.ensureRunningInternal(sandboxId)
      .then((sandbox) => {
        this.cache.set(sandboxId, {
          sandbox,
          expiresAt: Date.now() + RUNNING_CACHE_MS,
        });
        if (sandbox.id !== sandboxId) {
          this.cache.set(sandbox.id, {
            sandbox,
            expiresAt: Date.now() + RUNNING_CACHE_MS,
          });
        }
        return sandbox;
      })
      .finally(() => {
        this.connecting.delete(sandboxId);
      });
    this.connecting.set(sandboxId, pending);
    return pending;
  }

  markSuspended(sandboxId: string): void {
    this.invalidate(sandboxId);
    this.manuallySuspended.add(sandboxId);
  }

  markAvailable(sandboxId: string): void {
    this.manuallySuspended.delete(sandboxId);
    this.invalidate(sandboxId);
  }

  remove(sandboxId: string): void {
    this.manuallySuspended.delete(sandboxId);
    this.invalidate(sandboxId);
  }

  invalidate(sandboxId: string): void {
    const cached = this.cache.get(sandboxId);
    this.cache.delete(sandboxId);
    if (cached?.sandbox.id && cached.sandbox.id !== sandboxId) {
      this.cache.delete(cached.sandbox.id);
    }
  }

  private async ensureRunningInternal(
    sandboxId: string,
  ): Promise<TensorlakeSandboxInfo> {
    this.output.appendLine(
      `[Tensorlake] Checking sandbox state: sandbox=${sandboxId}`,
    );
    let sandbox = await getTensorlakeSandboxInfo(sandboxId);
    let status = sandbox.status.toLowerCase();
    this.output.appendLine(
      `[Tensorlake] Sandbox state: sandbox=${sandboxId} status=${sandbox.status}`,
    );

    if (status === "running") {
      this.output.appendLine(
        `[Tensorlake] Sandbox ready: sandbox=${sandboxId}`,
      );
      return sandbox;
    }

    if (status === "suspended") {
      this.output.appendLine(
        `[Tensorlake] Resuming sandbox ${sandboxId} for remote access...`,
      );
      await resumeTensorlakeSandboxById(sandboxId);
    } else if (
      status === "terminated" ||
      status === "failed"
    ) {
      throw new Error(
        `Tensorlake sandbox ${sandboxId} is ${sandbox.status} and cannot be connected.`,
      );
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      sandbox = await getTensorlakeSandboxInfo(sandboxId);
      status = sandbox.status.toLowerCase();

      if (status === "running") {
        this.output.appendLine(
          `[Tensorlake] Sandbox resumed and ready: sandbox=${sandboxId}`,
        );
        return sandbox;
      }
      if (status === "terminated" || status === "failed") {
        throw new Error(
          `Tensorlake sandbox ${sandboxId} became ${sandbox.status} while connecting.`,
        );
      }
    }

    throw new Error(
      `Tensorlake sandbox ${sandboxId} did not become ready within ${READY_TIMEOUT_MS / 1000} seconds.`,
    );
  }

  dispose(): void {
    this.connecting.clear();
    this.cache.clear();
    this.manuallySuspended.clear();
  }
}
