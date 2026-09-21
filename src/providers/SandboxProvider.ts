import * as vscode from "vscode";
import type { SandboxProviderId } from "../models/types";
import { hasE2bApiKey, listE2bSandboxes } from "../services/e2b";
import { hasFreestyleApiKey, listFreestyleVms, type FreestyleVM } from "../services/freestyle";
import {
  hasTensorlakeApiKey,
  listTensorlakeSandboxes,
  type TensorlakeSandbox,
} from "../services/tensorlake";

export type SandboxTreeItem = vscode.TreeItem;

class SandboxSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly provider: SandboxProviderId,
    collapsibleState: vscode.TreeItemCollapsibleState,
    icon: string,
  ) {
    super(label, collapsibleState);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `${provider}Section`;
  }
}

/** A non-interactive / action leaf shown inside a provider section. */
class ActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string | undefined, icon: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: args };
    }
  }
}

export class TensorlakeSandboxItem extends vscode.TreeItem {
  constructor(public readonly sandbox: TensorlakeSandbox) {
    super(
      sandbox.name ?? sandbox.sandbox_id,
      vscode.TreeItemCollapsibleState.None,
    );
    const status = sandbox.status.toLowerCase();
    this.description = sandbox.name
      ? `${sandbox.status} · ${sandbox.sandbox_id}`
      : sandbox.status;
    this.iconPath = new vscode.ThemeIcon(
      status === "running" ? "vm-running" : "vm-outline",
    );
    if (status === "running") {
      this.contextValue = sandbox.name
        ? "tensorlakeSandboxRunning"
        : "tensorlakeSandboxRunningEphemeral";
    } else if (status === "suspended") {
      this.contextValue = "tensorlakeSandboxSuspended";
    } else {
      this.contextValue = "tensorlakeSandboxBusy";
    }
    this.tooltip = sandbox.name
      ? `Tensorlake sandbox: ${sandbox.name} (${sandbox.sandbox_id})`
      : `Tensorlake sandbox: ${sandbox.sandbox_id}`;
  }
}

export class E2BSandboxItem extends vscode.TreeItem {
  constructor(
    public readonly sandboxID: string,
    public readonly state?: string,
  ) {
    super(sandboxID, vscode.TreeItemCollapsibleState.None);
    this.description = state ?? "";
    this.iconPath = new vscode.ThemeIcon(
      state === "paused" ? "vm-outline" : "vm-running",
    );
    // State-aware contextValue so the UI can show "Pause" for running
    // sandboxes and "Resume" for paused ones. All E2B sandboxes get a delete
    // action.
    this.contextValue =
      state === "paused" ? "e2bSandboxPaused" : "e2bSandboxRunning";
    this.tooltip = `E2B sandbox: ${sandboxID}`;
  }
}

export class FreestyleSandboxItem extends vscode.TreeItem {
  constructor(public readonly vm: FreestyleVM) {
    super(vm.id, vscode.TreeItemCollapsibleState.None);
    this.description = vm.state;
    this.iconPath = new vscode.ThemeIcon(
      vm.state === "running" ? "vm-running" : "vm-outline",
    );
    // State-aware contextValue so the UI can show "Stop"/"Suspend" when
    // running, "Resume" when suspended, and "Start" when stopped.
    switch (vm.state) {
      case "running":
        this.contextValue = "freestyleVmRunning";
        break;
      case "suspended":
        this.contextValue = "freestyleVmSuspended";
        break;
      case "stopped":
        this.contextValue = "freestyleVmStopped";
        break;
      case "lost":
        this.contextValue = "freestyleVmLost";
        break;
      default: // starting, suspending, building
        this.contextValue = "freestyleVmBusy";
        break;
    }
    this.tooltip = `Freestyle VM: ${vm.id}`;
  }
}

/**
 * Tree data provider for the "Sandboxes" view. The root shows one collapsible
 * section per provider (Freestyle, E2B); each section lazily lists the user's
 * sandboxes / VMs from the corresponding service.
 */
export class SandboxProvider implements vscode.TreeDataProvider<SandboxTreeItem> {
  private readonly _onDidChangeTreeData: vscode.EventEmitter<SandboxTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SandboxTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SandboxTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SandboxTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SandboxTreeItem): Promise<SandboxTreeItem[]> {
    if (!element) {
      return [
        new SandboxSectionItem(
          "Tensorlake Sandboxes",
          "tensorlake",
          vscode.TreeItemCollapsibleState.Expanded,
          "cloud",
        ),
        new SandboxSectionItem(
          "Freestyle VMs",
          "freestyle",
          vscode.TreeItemCollapsibleState.Expanded,
          "vm",
        ),
        new SandboxSectionItem(
          "E2B Sandboxes",
          "e2b",
          vscode.TreeItemCollapsibleState.Expanded,
          "server-process",
        ),
      ];
    }

    if (element instanceof SandboxSectionItem) {
      switch (element.provider) {
        case "tensorlake":
          return this.getTensorlakeChildren();
        case "e2b":
          return this.getE2bChildren();
        case "freestyle":
          return this.getFreestyleChildren();
      }
    }

    return [];
  }

  private async getTensorlakeChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasTensorlakeApiKey()) {
      items.push(
        new ActionItem(
          "Set Tensorlake API key...",
          "remote-sandbox.tensorlakeSetApiKey",
          "key",
        ),
      );
      return items;
    }
    const sandboxes = await listTensorlakeSandboxes(this.outputChannel);
    if (sandboxes.length === 0) {
      items.push(
        new ActionItem("No Tensorlake sandboxes found", undefined, "info"),
      );
    } else {
      items.push(...sandboxes.map((s) => new TensorlakeSandboxItem(s)));
    }
    return items;
  }

  private async getE2bChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasE2bApiKey()) {
      items.push(new ActionItem("Set E2B API key...", "remote-sandbox.e2bSetApiKey", "key"));
      return items;
    }
    const sandboxes = await listE2bSandboxes();
    if (sandboxes.length === 0) {
      items.push(new ActionItem("No E2B sandboxes found", undefined, "info"));
    } else {
      items.push(...sandboxes.map((s) => new E2BSandboxItem(s.sandboxID, s.state)));
    }
    return items;
  }

  private async getFreestyleChildren(): Promise<SandboxTreeItem[]> {
    const items: SandboxTreeItem[] = [];
    if (!hasFreestyleApiKey()) {
      items.push(new ActionItem("Set Freestyle API key...", "remote-sandbox.freestyleSetApiKey", "key"));
      return items;
    }
    const vms = await listFreestyleVms();
    if (vms.length === 0) {
      items.push(new ActionItem("No Freestyle VMs found", undefined, "info"));
    } else {
      items.push(...vms.map((v) => new FreestyleSandboxItem(v)));
    }
    return items;
  }
}