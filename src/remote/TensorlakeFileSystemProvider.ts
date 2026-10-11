import * as vscode from "vscode";
import {
  TensorlakeError,
  TensorlakeErrorKind,
  toFileSystemError,
} from "../tensorlake/errors";
import {
  deleteTensorlakePath,
  listTensorlakeDirectory,
  readTensorlakeFile,
  statTensorlakePath,
  writeTensorlakeFile,
} from "../tensorlake/files";
import {
  createTensorlakeDirectory,
  deleteTensorlakeDirectory,
  renameTensorlakePath,
} from "../tensorlake/processes";
import { parseTensorlakeUri } from "./uri";

interface TensorlakeTarget {
  sandboxId: string;
  remotePath: string;
}

export class TensorlakeFileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.changes.event;

  constructor(
    private readonly ensureSandbox: (sandboxId: string) => Promise<unknown>,
    private readonly output?: vscode.LogOutputChannel,
  ) {}

  watch(
    _uri: vscode.Uri,
    _options: {
      readonly recursive: boolean;
      readonly excludes: readonly string[];
    },
  ): vscode.Disposable {
    // Tensorlake currently exposes request/response file operations but no
    // filesystem watch stream. We emit events for mutations made here.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const { sandboxId, remotePath } = await this.resolve(uri);
      const stat = await statTensorlakePath(sandboxId, remotePath);
      return {
        type:
          stat.type === "directory"
            ? vscode.FileType.Directory
            : vscode.FileType.File,
        ctime: 0,
        mtime: stat.mtime,
        size: stat.size,
      };
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const { sandboxId, remotePath } = await this.resolve(uri);
      const entries = await listTensorlakeDirectory(sandboxId, remotePath);
      return entries.map((entry) => [
        entry.name,
        entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { sandboxId, remotePath } = await this.resolve(uri);
      return await readTensorlakeFile(sandboxId, remotePath);
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    try {
      const target = await this.resolve(uri);
      const exists = await this.pathExists(target);
      if (exists && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      if (!exists && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      this.output?.debug(
        `FS write: sandbox=${target.sandboxId} path=${target.remotePath} bytes=${content.byteLength}`,
      );
      await writeTensorlakeFile(
        target.sandboxId,
        target.remotePath,
        content,
      );
      this.fire(
        exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      );
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { sandboxId, remotePath } = await this.resolve(uri);
      this.output?.debug(`FS mkdir: sandbox=${sandboxId} path=${remotePath}`);
      await createTensorlakeDirectory(sandboxId, remotePath);
      this.fire(vscode.FileChangeType.Created, uri);
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async delete(
    uri: vscode.Uri,
    options: { readonly recursive: boolean },
  ): Promise<void> {
    try {
      const { sandboxId, remotePath } = await this.resolve(uri);
      this.output?.debug(
        `FS delete: sandbox=${sandboxId} path=${remotePath} recursive=${options.recursive}`,
      );
      const stat = await statTensorlakePath(sandboxId, remotePath);
      if (stat.type === "directory") {
        await deleteTensorlakeDirectory(
          sandboxId,
          remotePath,
          options.recursive,
        );
      } else {
        await deleteTensorlakePath(sandboxId, remotePath);
      }
      this.fire(vscode.FileChangeType.Deleted, uri);
    } catch (error) {
      this.logFailure("filesystem operation", uri, error);
      throw toFileSystemError(error);
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    if (oldUri.toString() === newUri.toString()) {
      return;
    }

    const oldParsed = parseTensorlakeUri(oldUri);
    const newParsed = parseTensorlakeUri(newUri);
    if (oldParsed.sandboxId !== newParsed.sandboxId) {
      throw vscode.FileSystemError.Unavailable(
        "Cross-sandbox rename is not supported.",
      );
    }

    try {
      await this.ensureSandbox(oldParsed.sandboxId);
      const destinationExists = await this.pathExists(newParsed);
      if (destinationExists && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(newUri);
      }

      this.output?.debug(
        `FS rename: sandbox=${oldParsed.sandboxId} from=${oldParsed.remotePath} to=${newParsed.remotePath} overwrite=${options.overwrite}`,
      );
      await renameTensorlakePath(
        oldParsed.sandboxId,
        oldParsed.remotePath,
        newParsed.remotePath,
        options.overwrite,
      );
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
      this.fireParentChanged(oldUri);
      this.fireParentChanged(newUri);
    } catch (error) {
      this.logFailure("rename", oldUri, error);
      throw toFileSystemError(error);
    }
  }

  private async resolve(uri: vscode.Uri): Promise<TensorlakeTarget> {
    const target = parseTensorlakeUri(uri);
    await this.ensureSandbox(target.sandboxId);
    return target;
  }

  private async pathExists(target: TensorlakeTarget): Promise<boolean> {
    try {
      await statTensorlakePath(target.sandboxId, target.remotePath);
      return true;
    } catch (error) {
      if (
        error instanceof TensorlakeError &&
        error.kind === TensorlakeErrorKind.NotFound
      ) {
        return false;
      }
      throw error;
    }
  }

  private fire(type: vscode.FileChangeType, uri: vscode.Uri): void {
    const events: vscode.FileChangeEvent[] = [{ type, uri }];
    const parent = this.parentUri(uri);
    if (parent.toString() !== uri.toString()) {
      events.push({ type: vscode.FileChangeType.Changed, uri: parent });
    }
    this.changes.fire(events);
  }

  private fireParentChanged(uri: vscode.Uri): void {
    const parent = this.parentUri(uri);
    if (parent.toString() !== uri.toString()) {
      this.changes.fire([
        { type: vscode.FileChangeType.Changed, uri: parent },
      ]);
    }
  }

  private parentUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({
      path: uri.path.replace(/\/[^/]+\/?$/, "") || "/",
    });
  }


  private logFailure(operation: string, uri: vscode.Uri, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output?.error(
      `FS ${operation} failed: uri=${uri.toString()} error=${message}`,
    );
  }

  dispose(): void {
    this.changes.dispose();
  }
}
