import WebSocket, { RawData } from "ws";
import {
  tensorlakeProxyBase,
  tensorlakeProxyJson,
  tensorlakeProxyRequest,
} from "./client";

interface CreatePtyResponse {
  session_id: string;
  token: string;
}

export interface TensorlakePtyOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  cols?: number;
  rows?: number;
}

export interface TensorlakePtySession {
  readonly sessionId: string;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  disconnect(): void;
  kill(): Promise<void>;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

class TensorlakePtySessionImpl implements TensorlakePtySession {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(exitCode: number) => void>();
  private pendingData: Buffer[] = [];
  private exitCode: number | undefined;

  constructor(
    private readonly sandboxId: string,
    readonly sessionId: string,
    private readonly socket: WebSocket,
  ) {
    socket.on("message", (raw) => this.handleFrame(rawDataToBuffer(raw)));
    socket.on("close", () => this.finishExit(1));
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    if (this.pendingData.length > 0) {
      const buffered = this.pendingData;
      this.pendingData = [];
      for (const data of buffered) {
        listener(data);
      }
    }
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number) => void): () => void {
    if (this.exitCode !== undefined) {
      queueMicrotask(() => listener(this.exitCode ?? 1));
      return () => undefined;
    }

    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  sendInput(data: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = Buffer.from(data, "utf8");
    this.socket.send(Buffer.concat([Buffer.from([0x00]), payload]));
  }

  resize(cols: number, rows: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const frame = Buffer.allocUnsafe(5);
    frame[0] = 0x01;
    frame.writeUInt16BE(Math.max(1, Math.min(1000, cols)), 1);
    frame.writeUInt16BE(Math.max(1, Math.min(500, rows)), 3);
    this.socket.send(frame);
  }

  disconnect(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  async kill(): Promise<void> {
    this.disconnect();
    await tensorlakeProxyRequest(
      this.sandboxId,
      `/api/v1/pty/${encodeURIComponent(this.sessionId)}`,
      { method: "DELETE" },
    );
  }

  private handleFrame(frame: Buffer): void {
    if (frame.length === 0) {
      return;
    }

    switch (frame[0]) {
      case 0x00: {
        const data = Buffer.from(frame.subarray(1));
        if (this.dataListeners.size === 0) {
          this.pendingData.push(data);
          return;
        }
        for (const listener of this.dataListeners) {
          listener(data);
        }
        break;
      }
      case 0x03: {
        if (frame.length < 5) {
          return;
        }
        this.finishExit(frame.readInt32BE(1));
        break;
      }
    }
  }

  private finishExit(exitCode: number): void {
    if (this.exitCode !== undefined) {
      return;
    }
    this.exitCode = exitCode;
    for (const listener of this.exitListeners) {
      listener(exitCode);
    }
    this.exitListeners.clear();
  }
}

export async function createTensorlakePty(
  sandboxId: string,
  options: TensorlakePtyOptions = {},
): Promise<TensorlakePtySession> {
  const created = await tensorlakeProxyJson<CreatePtyResponse>(
    sandboxId,
    "/api/v1/pty",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: options.command ?? "/bin/bash",
        args: options.args ?? ["-l"],
        env: { TERM: "xterm-256color", ...options.env },
        working_dir: options.workingDir ?? "/home/tl-user/workspace",
        rows: options.rows ?? 24,
        cols: options.cols ?? 80,
      }),
    },
  );

  const wsUrl = new URL(
    `/api/v1/pty/${encodeURIComponent(created.session_id)}/ws`,
    tensorlakeProxyBase(sandboxId),
  );
  wsUrl.protocol = "wss:";

  const socket = new WebSocket(wsUrl, {
    headers: {
      "X-PTY-Token": created.token,
    },
  });
  const session = new TensorlakePtySessionImpl(
    sandboxId,
    created.session_id,
    socket,
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        try {
          socket.send(Buffer.from([0x02]));
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    });
  } catch (error) {
    socket.terminate();
    await tensorlakeProxyRequest(
      sandboxId,
      `/api/v1/pty/${encodeURIComponent(created.session_id)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
    throw error;
  }

  return session;
}