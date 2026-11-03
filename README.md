# Remote Sandbox

Remote Sandbox manages sandboxed environments — **Freestyle**, **InstaCloud**, and **Tensorlake** — and helps you connect to them from VS Code.

The extension provides a **Sandboxes** view in the Activity Bar that lists Freestyle VMs, InstaCloud projects, and Tensorlake sandboxes. Connecting to a Freestyle VM **starts it, writes the matching `~/.ssh/freestyle.conf` file if needed, and opens Remote-SSH** — no manual "get SSH info" step required. The Tensorlake provider additionally offers a lightweight remote workspace (virtual filesystem, integrated terminal, and port forwarding) that does not require VS Code Server. The InstaCloud provider signs in through the browser, manages the lifecycle of InstaCloud services, runs commands inside them over the REST API, and can open a Remote-SSH window with a short-lived certificate.

## Requirements

- VS Code 1.80.0 or later
- Remote - SSH extension (for Freestyle and InstaCloud)
- Node.js 18 or later for development
- An InstaCloud account (sign in through the browser) or API keys for the providers you use (see Configuration)

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

- **Freestyle VMs** — list of your VMs with actions to create, pause, resume, start, run a command, or connect. Connecting writes the SSH config (if needed) and opens Remote-SSH.
- **InstaCloud** — a project → branch → service tree for your InstaCloud account. Sign in through the browser, then services can be started, stopped, suspended, restarted, connected to over SSH, and can run one-shot commands.
- **Tensorlake Sandboxes** — manage Tensorlake sandboxes and connect to lightweight remote workspaces without VS Code Server. Each sandbox can show its recently opened remote folders.

Each Freestyle item has a context menu to **Connect in Current Window** or **Connect in New Window**, plus **Freestyle: Run Command…** which prompts for a shell command and runs it inside the VM (`POST /v5/vms/{id}/exec-await`), printing stdout, stderr and the exit code to the output channel. Tensorlake offers its own connect actions, plus remote terminal, folder browsing, Git clone, and public-port management.

Lifecycle actions:

- **Freestyle**: **Pause** when running, **Start** when paused or stopped, **Delete** for any VM.
- **InstaCloud**: **Start** when stopped or suspended, **Stop** and **Suspend** when running, **Restart** when running.
- **Tensorlake**: **Suspend** when running, **Resume** when suspended.

Tensorlake connections use a virtual `tensorlake:` filesystem and a dedicated **Ports** panel. In a Tensorlake workspace, the extension can open a remote terminal, browse/open remote folders, clone Git repositories, and expose or remove public ports. The view title bars provide refresh actions, and all commands are also available from the Command Palette.

## InstaCloud

### Signing in

Run **InstaCloud: Sign In**. The extension starts an OAuth device flow: it shows a short code, opens the InstaCloud console in your browser, and waits for you to approve the sign-in. There is no callback server to set up and nothing to paste into settings — the session token is stored in VS Code's secret storage and refreshed automatically.

| Command | Description |
| --- | --- |
| **InstaCloud: Sign In** | Signs in through the browser (device flow). |
| **InstaCloud: Sign Out** | Forgets the stored session. |
| **InstaCloud: Show Account** | Shows the signed-in user. |
| **InstaCloud: Set API Key** | Fallback for headless setups that cannot sign in. |

An API key still works for everything except SSH certificates: the certificate endpoint refuses machine credentials. When an interactive session is available the extension uses it in preference to the key.

### Browsing and controlling services

The **InstaCloud** section of the tree mirrors the InstaCloud resource hierarchy:

- **Project** — one node per project, annotated with its organization.
- **Branch** — the branches of a project; the default branch is listed first.
- **Service** — the services of a branch (compute, postgres, redis, mysql, mongodb, storage), annotated with the desired state.

Right-click a service to control it:

| Command | Description |
| --- | --- |
| **InstaCloud: Start Service** | Sets the desired state to `running`. |
| **InstaCloud: Stop Service** | Sets the desired state to `stopped`. |
| **InstaCloud: Suspend Service** | Sets the desired state to `suspended`. |
| **InstaCloud: Restart Service** | Restarts the service. |
| **InstaCloud: Run Command…** | Prompts for a shell command and runs it in the service. |
| **InstaCloud: Connect** | Issues an SSH certificate and opens a Remote-SSH window (requires a signed-in session). |
| **InstaCloud: Copy SSH Target** | Copies the `ssh -p <port> <user>@<host>` target to the clipboard. |

The exec endpoint takes an argv array and invokes no shell, so the extension wraps your input in `sh -c`. Commands are limited to 180 seconds and the output is capped at 1 MiB.

### Connecting over SSH

**InstaCloud: Connect** requests a short-lived SSH certificate for the service, which is only possible with an interactive session — API keys are refused. The extension then:

1. makes sure an SSH key exists (`~/.ssh/instacloud_ed25519`, or your existing default key),
2. writes the certificate to `~/.ssh/instacloud_<service>.cert`,
3. adds the certificate authority to `~/.ssh/known_hosts`,
4. writes `~/.ssh/instacloud.conf` with the `INSTA_<service-id>` host,
5. opens Remote-SSH on that host.

The certificate is short-lived (one hour by default) and the SSH proxy is regenerated on every connect, so re-connect after it expires.

## SSH configuration

Freestyle and InstaCloud manage their own SSH config files under `~/.ssh` and only write them when needed:

- **Freestyle** (`~/.ssh/freestyle.conf`) — credentials are generated when connecting or starting a VM.
- **InstaCloud** (`~/.ssh/instacloud.conf`) — the host, port and certificate of the service you connected to.

The config is (re)written automatically as part of **Connect in Current Window**, **Connect in New Window**, and **Start** — whenever a check shows the stored config is outdated. The standalone "Get SSH Info" / "Save SSH Config" commands were removed.

Tensorlake does not use SSH. It uses the `tensorlake:` virtual filesystem and an API-backed terminal/PTY instead.

Freestyle and InstaCloud write their own `.conf` files and print the `Include` line to the output channel; make sure those lines are present in `~/.ssh/config`.

## Configuration

Open Settings and search for `Remote Sandbox`.

```json
{
  "remoteSandbox.freestyleApiKey": "",
  "remoteSandbox.instacloudApiKey": "",
  "remoteSandbox.tensorlakeApiKey": ""
}
```

- `remoteSandbox.freestyleApiKey`: Your Freestyle API key. You can also set it with the **Freestyle: Set API Key** command or the `FREESTYLE_API_KEY` environment variable.
- `remoteSandbox.instacloudApiKey`: Your InstaCloud API key (`insta_...`), used as a fallback for headless setups. **InstaCloud: Sign In** is preferred; you can also set the key with the **InstaCloud: Set API Key** command or the `INSTA_API_KEY` environment variable.
- `remoteSandbox.tensorlakeApiKey`: Your Tensorlake API key. You can also set it with the **Tensorlake: Set API Key** command or the `TENSORLAKE_API_KEY` environment variable.

The InstaCloud API base URL defaults to `https://api.instacloud.com` and can be overridden with the `INSTA_API_URL` environment variable when you point the extension at a self-hosted deployment.

## Troubleshooting

- Check the Remote Sandbox output channel for operation details and errors.
- Verify the generated configuration file is included by `~/.ssh/config` (Freestyle writes its own `.conf` file and prints the `Include` line to the output channel).
- Confirm the required API keys are available and that the **Remote - SSH** extension is installed for Freestyle connections.

## License

GPL-3.0-only
