# Installing Continuous

Continuous is an unofficial, community-maintained fork of the Continue VS Code extension. It is published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=b1tninja.continuous) as `b1tninja.continuous` (search for **Continuous** in the Extensions view and check the publisher is `b1tninja`), and it is **not** on Open VSX. This guide covers the other way: installing by hand from the `.vsix` file attached to each [GitHub release](https://github.com/b1tninja/continuous/releases), for when the Marketplace is not reachable or you want a specific build.

Continuous is not affiliated with Continue Dev, Inc.

**Requirements:** VS Code 1.105 or newer (or a VS Code-based editor built on it). Older versions cannot load the extension and will refuse to install it, so they keep the previously installed version.

The current release is on the [latest release page](https://github.com/b1tninja/continuous/releases/latest). The file names below use 2.16.2 as the example version.

## Option 1: install the latest release

### 1. Download the `.vsix` for your platform

Open the [latest release](https://github.com/b1tninja/continuous/releases/latest) and download the file for your platform, plus `SHA256SUMS.txt`:

| Platform              | File                                     |
| --------------------- | ---------------------------------------- |
| Windows x64           | `continuous-win32-x64-<version>.vsix`    |
| Windows Arm64         | `continuous-win32-arm64-<version>.vsix`  |
| macOS (Apple Silicon) | `continuous-darwin-arm64-<version>.vsix` |
| macOS (Intel)         | `continuous-darwin-x64-<version>.vsix`   |
| Linux x64             | `continuous-linux-x64-<version>.vsix`    |
| Linux Arm64           | `continuous-linux-arm64-<version>.vsix`  |

For 2.16.2, the Windows x64 file is `continuous-win32-x64-2.16.2.vsix`. There are no 32-bit ARM or Alpine (musl) builds; the 2.2.0 release's `linux-armhf` and `alpine-x64` files did not work, because their native modules were built for other platforms.

Each platform also has an **agents** build, `continuous-<platform>-<version>-agents.vsix`. It adds Continuous to VS Code's Agents window through APIs that are still proposed, so it works in VS Code Insiders, or in Stable started with `code --enable-proposed-api b1tninja.continuous`; elsewhere it works like the normal build. See [VS Code Chat and Agents](https://b1tninja.github.io/continuous/customize/vscode-chat-and-agents). The commands below pick the normal build.

With the [GitHub CLI](https://cli.github.com/), you can download the latest release's file and checksums in one command. Change `win32-x64` to your platform:

```bash
gh release download --repo b1tninja/continuous --pattern "continuous-win32-x64-*[0-9].vsix" --pattern SHA256SUMS.txt --dir continuous-vsix
```

### 2. Verify the download (optional, recommended)

The packages are not code-signed, so the checksum is how you confirm you have the file the release published. In the folder that holds the `.vsix` and `SHA256SUMS.txt`:

```powershell
# Windows PowerShell: prints True when the checksum matches
$file = Get-ChildItem continuous-win32-x64-*[0-9].vsix
$expected = (Select-String -Path SHA256SUMS.txt -SimpleMatch $file.Name).Line.Split(' ')[0]
(Get-FileHash $file.FullName -Algorithm SHA256).Hash -eq $expected
```

```bash
# Linux: prints "<file>: OK" when the checksum matches
sha256sum --check --ignore-missing SHA256SUMS.txt
# macOS (change darwin-arm64 to darwin-x64 on an Intel Mac)
grep "continuous-darwin-arm64-.*[0-9].vsix$" SHA256SUMS.txt | shasum -a 256 --check
```

### 3. Install it

```bash
code --install-extension continuous-win32-x64-2.16.2.vsix --force
```

Or in VS Code: open the **Extensions** view, select **...** → **Install from VSIX...**, and choose the file.

### 4. Reload VS Code

Run **Developer: Reload Window**, then open the Continuous icon in the activity bar.

Continuous uses the extension ID `b1tninja.continuous`. It installs alongside the original Continue extension (`Continue.continue`) without conflicts, so you do not need to uninstall Continue first. It reads your existing `~/.continue` configuration.

To check which version is installed, run `code --list-extensions --show-versions` and look for `b1tninja.continuous@<version>`.

**Coming from 2.4.1 or earlier?** Those releases used the ID `b1tninja.continued`, which is taken on the VS Code Marketplace by another extension, so from 2.4.2 the ID is `b1tninja.continuous`. VS Code treats it as a different extension: uninstall `b1tninja.continued` (`code --uninstall-extension b1tninja.continued`) after installing 2.4.2, so the two do not both run. Your settings and configuration carry over: the first start copies `~/.continue` to `~/.continuous` (the codebase index is rebuilt) and each `continue.*` setting to its `continuous.*` name, and a workspace's `.continue` folder is still read. Keyboard shortcuts bound to a `continue.*` command need the new `continuous.*` name. API keys kept in VS Code's secure storage do not carry over, as each extension has its own: enter them again, or keep them in `~/.continuous/.env`. The welcome screen also shows once; close it, your models are already set up.

> Release files are named with the version only, for example `continuous-win32-x64-2.16.2.vsix`. GitHub Actions builds (Option 2) add the short commit SHA, for example `continuous-win32-x64-2.16.2-g62505d0.vsix`.

## Option 2: download an unreleased build from GitHub Actions

Fixes land on `main` before they are released. To try them, install a build from GitHub Actions. Builds are created on request, so you may need to trigger one:

1. Open **Actions** → **PR Build And Upload VSIX** on `b1tninja/continuous`.
2. Select **Run workflow**, choose `main`, and run it.
3. When the run finishes, open it and download the artifact for your platform: `win32-x64-vsix`, `linux-x64-vsix` or `darwin-arm64-vsix`.
4. Unzip the artifact and install the `.vsix` as in Option 1.

You need to be signed in to GitHub with access to the repository to download artifacts. Artifacts expire after the retention period set for the repository. Actions builds have no `SHA256SUMS.txt`.

With the GitHub CLI you can download the latest Windows build in one command:

```powershell
gh run download --repo b1tninja/continuous --name win32-x64-vsix --dir "$env:TEMP\continuous-vsix"
code --install-extension (Get-ChildItem "$env:TEMP\continuous-vsix" -Filter *.vsix | Select-Object -First 1).FullName --force
```

Replace `win32-x64-vsix` with `darwin-arm64-vsix` on a Mac and use `bash`/`zsh` syntax with `gh run download ... --dir "$TMPDIR/continuous-vsix"`.

## The terminal CLI

Releases from 2.4.3 on also carry the command-line agent, `continuous-cli-<version>.tgz`. It needs Node.js 22 or newer. The command is `continuous`, with the short alias `cn` (both run the same program). It uses the same `~/.continuous` folder as the extension, and `continuous --config <path to a .yaml>` runs with one config file.

### Install script

The scripts find the latest release, download its `continuous-cli-*.tgz`, check it against the release's `SHA256SUMS.txt`, install it with `npm install -g`, and print `continuous --version` and `cn --version`. If Node.js 22 is missing they install it with fnm. They send no telemetry and contact only `api.github.com`, `github.com` and the npm registry. Running one again upgrades in place.

Read a script before you run it. macOS, Linux, WSL and Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1
.\install.ps1
```

Once you have inspected them, the one-liners are `curl -fsSL <raw url above>/install.sh | bash` and `irm <raw url above>/install.ps1 | iex`.

To pin a version, or to skip the release lookup, set an environment variable:

```bash
CONTINUOUS_CLI_VERSION=2.14.0 bash install.sh
CONTINUOUS_CLI_URL=https://github.com/b1tninja/continuous/releases/download/v2.14.0-vscode/continuous-cli-2.14.0.tgz bash install.sh
```

```powershell
$env:CONTINUOUS_CLI_VERSION = "2.14.0"; .\install.ps1
```

`SHA256SUMS.txt` is published beside the tarball, so it catches a corrupt download but is not a signature. With `CONTINUOUS_CLI_URL`, the script looks for `SHA256SUMS.txt` in the same folder and, if it has no entry, prints the tarball's SHA-256 for you to compare.

### Install with npm, update and uninstall

Without the script, install straight from the release:

```bash
npm i -g https://github.com/b1tninja/continuous/releases/download/v2.16.2-vscode/continuous-cli-2.16.2.tgz
```

To update, run the install script again or install the next release's `.tgz` the same way; the CLI does not update itself. To uninstall, run `npm uninstall -g @b1tninja/continuous-cli`. That removes both commands and leaves `~/.continuous` alone.

## Updating

VS Code does not update side-loaded `.vsix` files automatically. To hear about new releases, select **Watch** → **Custom** → **Releases** on the [repository](https://github.com/b1tninja/continuous).

To update, download the new release's `.vsix` and run the install command again with `--force`. Your settings and `~/.continuous` configuration are kept.

To go back to an earlier version, install that release's `.vsix` the same way. Older releases are on the [releases page](https://github.com/b1tninja/continuous/releases).

## Troubleshooting

| Symptom                                           | Fix                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `code` is not recognised                          | In VS Code run **Shell Command: Install 'code' command in PATH**, then open a new terminal.          |
| Install fails with "Extension ... is not a valid" | The download is incomplete. Re-download and compare the SHA-256 checksum.                            |
| Install says the extension is not compatible      | Your VS Code is older than 1.105. Update VS Code, then install again.                                |
| The Continuous icon does not appear               | Reload the window, then check **View → Appearance** for the activity bar setting.                    |
| Models do not load                                | Check your provider credentials and use **Test connection** or the refresh icon in the model picker. |
| A corporate proxy blocks GitHub downloads         | Download the `.vsix` on another machine and copy it over.                                            |

## Building from source

```bash
git clone https://github.com/b1tninja/continuous.git
cd continuous
node ./scripts/build-packages.js
cd gui && npm ci && npm run build && cd ..
cd extensions/vscode && npm ci && npm run prepackage && npm run package
npx @vscode/vsce package --no-dependencies
```

Node.js 20.20.1 or later is required; `.nvmrc` pins the version CI builds with. Building on Windows also needs the Visual Studio Build Tools for native modules.
