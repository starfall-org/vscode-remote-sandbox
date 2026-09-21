# Remote Sandbox

Remote Sandbox manages sandboxed environments — **Tensorlake**, **E2B**, and **Freestyle** — and helps you connect to them over SSH from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar (like Remote Extended) that lists Tensorlake sandboxes first, followed by Freestyle VMs and E2B sandboxes. Connecting to a sandbox **starts/resumes it, writes the matching `~/.ssh/*.conf` file if needed, and opens Remote-SSH** — no manual "get SSH info" step required.

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

- **Tensorlake Sandboxes** — shown first. Supports create, suspend/resume for named sandboxes, terminate, and Remote-SSH connect. Before connecting, the extension discovers local SSH keys from `~/.ssh` and `ssh-agent`, registers any missing public keys with Tensorlake, and writes the SSH config.
- **Freestyle VMs** — list of your VMs with actions to create, suspend, resume, start, or connect. Connecting writes the SSH config (if needed) and opens Remote-SSH.
- **E2B Sandboxes** — list of your E2B sandboxes. Connecting writes the SSH config (if needed) and opens Remote-SSH.

Each item has a context menu to **Connect in Current Window** or **Connect in New Window**. Next to the connect buttons, each sandbox/VM shows a lifecycle toggle:

- **Tensorlake**: **Suspend** for named running sandboxes, **Resume** when suspended.
- **E2B**: **Pause** when running, **Resume** when paused.
- **Freestyle**: **Suspend** when running, **Resume** when suspended.

The view title bar has a shortcut for:

- Refresh

All commands are also available from the Command Palette.

## SSH configuration

Each provider manages its own SSH config file under `~/.ssh` and only writes it when needed:

- **Tensorlake** (`~/.ssh/tensorlake.conf`) — uses the sandbox-specific hostname returned by Tensorlake and the same default identity path as the Tensorlake CLI: `~/.ssh/id_ed25519_tensorlake`. Remote Sandbox only writes the SSH config; it does not create or register SSH keys.
- **E2B** (`~/.ssh/e2b.conf`) — the entry is fully deterministic, so it is rewritten only when the file is missing or does not match.

The config is (re)written automatically as part of **Connect in Current Window**, **Connect in New Window**, **Resume** and **Start** actions — whenever a check shows the stored config is outdated. The standalone "Get SSH Info" / "Save SSH Config" commands were removed.

Each provider writes its own `.conf` file and prints the `Include` line to the output channel; make sure that line is present in `~/.ssh/config`.

## Configuration

Open Settings and search for `Remote Sandbox`.

```json
{
  "remoteSandbox.tensorlakeApiKey": "",
  "remoteSandbox.e2bApiKey": "",
  "remoteSandbox.freestyleApiKey": ""
}
```

- `remoteSandbox.tensorlakeApiKey`: Your Tensorlake project API key for sandbox lifecycle operations. You can also set it with the **Tensorlake: Set API Key** command or `TENSORLAKE_API_KEY`.
- `remoteSandbox.e2bApiKey`: Your E2B API key. You can also set it with the **E2B: Set API Key** command or the `E2B_API_KEY` environment variable.
- `remoteSandbox.freestyleApiKey`: Your Freestyle API key. You can also set it with the **Freestyle: Set API Key** command or the `FREESTYLE_API_KEY` environment variable.

## Troubleshooting

- Check the Remote Sandbox output channel for operation details and errors.
- Verify the generated configuration file is included by `~/.ssh/config` (each provider writes its own `.conf` file and prints the `Include` line to the output channel).
- Confirm the required API keys and tools (`websocat` for E2B) are available.

## License

GPL-3.0-only