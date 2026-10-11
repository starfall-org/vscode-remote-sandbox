import * as path from "node:path";
import * as vscode from "vscode";
import type { SandboxProviderId } from "../models/types";
import { hasE2bApiKey, listE2bSandboxes } from "../services/e2b";
import { hasFreestyleApiKey, listFreestyleVms, type FreestyleVM } from "../services/freestyle";
import {
  hasTensorlakeApiKey,
  listTensorlakeSandboxes,
  type TensorlakeSandbox,
} from "../services/tensorlake";
import { TENSORLAKE_HOME } from "../remote/uri";

export type SandboxTreeItem = vscode.TreeItem;

const RECENT_FOLDERS_KEY = "tensorlake.recentFolders";
const MAX_RECENT_FOLDERS_PER_SANDBOX = 12;

export interface TensorlakeRecentFolder {
  sandboxId: string;
  sandboxName?: string | null;
  remotePath: string;
  lastUsedAt: number;
}

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

export class TensorlakeSandboxItem extends vscode.TreeItem {
  constructor(
    public readonly sandbox: TensorlakeSandbox,
    hasRecentFolders: boolean,
  ) {
    super(
      sandbox.name ?? sandbox.sandbox_id,
      hasRecentFolders
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
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

export class TensorlakeRecentFolderItem extends vscode.TreeItem {
  constructor(public readonly recent: TensorlakeRecentFolder) {
    const normalized = path.posix.normalize(recent.remotePath);
    const label =
      normalized === "/"
        ? "/"
        : path.posix.basename(normalized) || normalized;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = normalized;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "tensorlakeRecentFolder";
    this.tooltip = new vscode.MarkdownString(
      [
        `**${recent.sandboxName ?? recent.sandboxId}**`,
        "",
        `\`${normalized}\``,
      ].join("\n"),
    );
  }
}

/**
 * Tree data provider for the "Sandboxes" view. The root shows one collapsible
 * section per provider (Freestyle, E2B, Tensorlake); each section lazily lists
 * the user's sandboxes / VMs from the corresponding service. Tensorlake
 * sandboxes can expand to show recently used folders.
 */
export class SandboxProvider
  implements vscode.TreeDataProvider<SandboxTreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    SandboxTreeItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  refresh(item?: SandboxTreeItem): void {
    this.changeEmitter.fire(item);
  }

  getTreeItem(element: SandboxTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SandboxTreeItem): Promise<SandboxTreeItem[]> {
    if (!element) {
      return [
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
        new SandboxSectionItem(
          "Tensorlake Sandboxes",
          "tensorlake",
          vscode.TreeItemCollapsibleState.Expanded,
          "cloud",
        ),
      ];
    }

    if (element instanceof SandboxSectionItem) {
      switch (element.provider) {
        case "e2b":
          return this.getE2bChildren();
        case "freestyle":
          return this.getFreestyleChildren();
        case "tensorlake":
          return this.getTensorlakeChildren();
      }
    }

    if (element instanceof TensorlakeSandboxItem) {
      return this.getRecentFolders(element.sandbox.sandbox_id).map(
        (recent) => new TensorlakeRecentFolderItem(recent),
      );
    }

    return [];
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
      items.push(new ActionItem("No Tensorlake sandboxes found", undefined, "info"));
    } else {
      items.push(
        ...sandboxes.map(
          (sandbox) =>
            new TensorlakeSandboxItem(
              sandbox,
              this.getRecentFolders(sandbox.sandbox_id).length > 0,
            ),
        ),
      );
    }
    return items;
  }

  async rememberRecentFolder(
    sandboxId: string,
    sandboxName: string | null | undefined,
    remotePath: string,
  ): Promise<void> {
    const normalized = path.posix.normalize(
      remotePath.startsWith("/") ? remotePath : `/${remotePath}`,
    );
    if (normalized === TENSORLAKE_HOME) {
      return;
    }

    const all = this.readAllRecentFolders().filter(
      (item) =>
        !(
          item.sandboxId === sandboxId &&
          path.posix.normalize(item.remotePath) === normalized
        ),
    );

    all.unshift({
      sandboxId,
      sandboxName,
      remotePath: normalized,
      lastUsedAt: Date.now(),
    });

    const kept: TensorlakeRecentFolder[] = [];
    const counts = new Map<string, number>();
    for (const item of all) {
      const count = counts.get(item.sandboxId) ?? 0;
      if (count >= MAX_RECENT_FOLDERS_PER_SANDBOX) {
        continue;
      }
      counts.set(item.sandboxId, count + 1);
      kept.push(item);
    }

    await this.context.globalState.update(RECENT_FOLDERS_KEY, kept);
    this.outputChannel.appendLine(
      `[Tensorlake] Recent folder saved: sandbox=${sandboxId} path=${normalized}`,
    );
    this.refresh();
  }

  async removeRecentFolder(item: TensorlakeRecentFolderItem): Promise<void> {
    const recent = item.recent;
    const normalized = path.posix.normalize(recent.remotePath);
    const next = this.readAllRecentFolders().filter(
      (entry) =>
        !(
          entry.sandboxId === recent.sandboxId &&
          path.posix.normalize(entry.remotePath) === normalized
        ),
    );
    await this.context.globalState.update(RECENT_FOLDERS_KEY, next);
    this.outputChannel.appendLine(
      `[Tensorlake] Recent folder removed: sandbox=${recent.sandboxId} path=${normalized}`,
    );
    this.refresh();
  }

  async clearRecentFolders(sandboxId: string): Promise<void> {
    const next = this.readAllRecentFolders().filter(
      (item) => item.sandboxId !== sandboxId,
    );
    await this.context.globalState.update(RECENT_FOLDERS_KEY, next);
    this.refresh();
  }

  private getRecentFolders(sandboxId: string): TensorlakeRecentFolder[] {
    return this.readAllRecentFolders()
      .filter((item) => item.sandboxId === sandboxId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private readAllRecentFolders(): TensorlakeRecentFolder[] {
    const stored = this.context.globalState.get<unknown>(RECENT_FOLDERS_KEY);
    if (!Array.isArray(stored)) {
      return [];
    }

    return stored.filter(
      (item): item is TensorlakeRecentFolder =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as TensorlakeRecentFolder).sandboxId === "string" &&
            typeof (item as TensorlakeRecentFolder).remotePath === "string" &&
            typeof (item as TensorlakeRecentFolder).lastUsedAt === "number" &&
            path.posix.normalize(
              (item as TensorlakeRecentFolder).remotePath,
            ) !== TENSORLAKE_HOME,
        ),
    );
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
