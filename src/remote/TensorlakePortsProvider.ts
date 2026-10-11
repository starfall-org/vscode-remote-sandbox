import * as vscode from "vscode";
import {
  getTensorlakeSandboxInfo,
  publicTensorlakePortUrl,
} from "../tensorlake/lifecycle";
import type { TensorlakeConnectionStore } from "./connection";

export interface TensorlakePortItem {
  port: number;
  url?: string;
  public: boolean;
}

export class TensorlakePortsProvider
  implements vscode.TreeDataProvider<TensorlakePortItem>
{
  private readonly changeEmitter = new vscode.EventEmitter<
    TensorlakePortItem | undefined | void
  >();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly connectionStore: TensorlakeConnectionStore,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  refresh(): void {
    this.output.debug("Ports refresh requested");
    this.changeEmitter.fire();
  }

  getTreeItem(item: TensorlakePortItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      String(item.port),
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.description = item.url ?? "Endpoint unavailable";
    treeItem.contextValue = "tensorlakePort";
    treeItem.iconPath = new vscode.ThemeIcon("globe");

    if (item.url) {
      treeItem.tooltip = new vscode.MarkdownString(
        [
          `**Port ${item.port}**`,
          "",
          item.public ? "Public Tensorlake ingress" : "Tensorlake ingress",
          "",
          item.url,
        ].join("\n"),
      );
      treeItem.command = {
        command: "remote-tensorlake.openPort",
        title: "Open Port",
        arguments: [item],
      };
    } else {
      treeItem.tooltip = `Port ${item.port}`;
    }

    return treeItem;
  }

  async getChildren(
    element?: TensorlakePortItem,
  ): Promise<TensorlakePortItem[]> {
    if (element) {
      return [];
    }

    const connected = this.connectionStore.resolveCurrent();
    if (!connected) {
      this.output.debug("Ports view: no Tensorlake workspace connected");
      return [];
    }

    this.output.info(`Refreshing Ports view: sandbox=${connected.sandboxId}`);
    try {
      const sandbox = await getTensorlakeSandboxInfo(connected.sandboxId);
      const exposedPorts = sandbox.exposed_ports ?? [];
      this.output.info(
        `Ports view refreshed: sandbox=${connected.sandboxId} ports=${exposedPorts.join(",") || "none"}`,
      );
      return exposedPorts
        .slice()
        .sort((a, b) => a - b)
        .map((port) => {
          let url: string | undefined;
          try {
            url = publicTensorlakePortUrl(sandbox, port);
          } catch {
            // Keep the port visible even if Tensorlake omitted URL metadata.
          }
          return {
            port,
            url,
            public: sandbox.allow_unauthenticated_access,
          };
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.error(
        `Failed to refresh Ports view: sandbox=${connected.sandboxId}: ${message}`,
      );
      return [];
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
