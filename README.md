# Remote Sandbox

Remote Sandbox manages sandboxed environments — **E2B**, **Freestyle**, and **Tensorlake** — and helps you connect to them from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar that lists Freestyle VMs, E2B sandboxes, and Tensorlake sandboxes. Connecting to an E2B or Freestyle sandbox **starts/resumes it, writes the matching `~/.ssh/*.conf` file if needed, and opens Remote-SSH** — no manual "get SSH info" step required. The merged Tensorlake provider additionally offers a lightweight remote workspace (virtual filesystem, integrated terminal, and port forwarding) that does not require VS Code Server.

## Requirements

- VS Code 1.80.0 or later
- Remote - SSH extension
- Node.js 18 or later for development
- API keys for the providers you use (see Configuration)

## Installation

### Run from source

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5` to launch an Extension Development Host.

### Package a VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

Install the generated VSIX from the Extensions view.

## Usage

Open the **Remote Sandbox** view in the Activity Bar. The tree shows one section per provider:

- **Freestyle VMs** — list of your VMs with actions to create, suspend, resume, start, or connect. Connecting writes the SSH config (if needed) and opens Remote-SSH.
- **E2B Sandboxes** — list of your E2B sandboxes. Connecting writes the SSH config (if needed) and opens Remote-SSH.
- **Tensorlake Sandboxes** — manage Tensorlake sandboxes and connect to lightweight remote workspaces without VS Code Server. Each sandbox can show its recently opened remote folders.

Each E2B/Freestyle item has a context menu to **Connect in Current Window** or **Connect in New Window**. Tensorlake offers its own connect actions, plus remote terminal, folder browsing, Git clone, and public-port management.

Lifecycle actions:

- **E2B**: **Pause** when running, **Resume** when paused.
- **Freestyle**: **Suspend** when running, **Resume** when suspended, **Start** when stopped.
- **Tensorlake**: **Suspend** when running, **Resume** when suspended.

Tensorlake connections use a virtual `tensorlake:` filesystem and a dedicated **Ports** panel. In a Tensorlake workspace, the extension can open a remote terminal, browse/open remote folders, clone Git repositories, and expose or remove public ports. The view title bars provide refresh actions, and all commands are also available from the Command Palette.

## SSH configuration

E2B and Freestyle manage their own SSH config files under `~/.ssh` and only write them when needed:

- **E2B** (`~/.ssh/e2b.conf`) — the entry is fully deterministic, so it is rewritten only when the file is missing or does not match.
- **Freestyle** (`~/.ssh/freestyle.conf`) — credentials are generated when connecting or starting a VM.

The config is (re)written automatically as part of **Connect in Current Window**, **Connect in New Window**, **Resume**, and **Start** actions — whenever a check shows the stored config is outdated. The standalone "Get SSH Info" / "Save SSH Config" commands were removed.

Tensorlake does not use SSH. It uses the `tensorlake:` virtual filesystem and an API-backed terminal/PTY instead.

Each SSH provider writes its own `.conf` file and prints the `Include` line to the output channel; make sure those lines are present in `~/.ssh/config`.

## Configuration

Open Settings and search for `Remote Sandbox`.

```json
{
  "remoteSandbox.e2bApiKey": "",
  "remoteSandbox.freestyleApiKey": "",
  "remoteSandbox.tensorlakeApiKey": ""
}
```

- `remoteSandbox.e2bApiKey`: Your E2B API key. You can also set it with the **E2B: Set API Key** command or the `E2B_API_KEY` environment variable.
- `remoteSandbox.freestyleApiKey`: Your Freestyle API key. You can also set it with the **Freestyle: Set API Key** command or the `FREESTYLE_API_KEY` environment variable.
- `remoteSandbox.tensorlakeApiKey`: Your Tensorlake API key. You can also set it with the **Tensorlake: Set API Key** command or the `TENSORLAKE_API_KEY` environment variable.

## Troubleshooting

- Check the Remote Sandbox output channel for operation details and errors.
- Verify the generated configuration file is included by `~/.ssh/config` (each provider writes its own `.conf` file and prints the `Include` line to the output channel).
- Confirm the required API keys and tools (`websocat` for E2B) are available.

## License

GPL-3.0-only