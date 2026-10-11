import * as vscode from "vscode";
import { parseTensorlakeUri } from "./uri";

export interface ConnectedTensorlakeSession {
  sandboxId: string;
  name: string;
  remotePath: string;
}

export class TensorlakeConnectionStore {
  resolveCurrent(): ConnectedTensorlakeSession | undefined {
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (candidate) => candidate.uri.scheme === "tensorlake",
    );
    if (!folder) {
      return undefined;
    }

    const parsed = parseTensorlakeUri(folder.uri);
    return {
      sandboxId: parsed.sandboxId,
      name: folder.uri.authority || folder.name,
      remotePath: parsed.remotePath,
    };
  }
}
