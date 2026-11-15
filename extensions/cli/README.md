# Continuous CLI

The Continuous CLI (`continuous`, short alias `cn`) is a customizable command line coding agent.

## Installation

Read a script before you run it, then run it. **macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/b1tninja/continuous/main/extensions/cli/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1
.\install.ps1
```

Or install a release tarball with npm if you have Node.js 22+ (see [Installing Continuous](../../docs/continuous-install.md) for pinning a version):

```bash
npm i -g https://github.com/b1tninja/continuous/releases/download/v2.16.2-vscode/continuous-cli-2.16.2.tgz
```

## Usage

The command is `continuous`, with the short alias `cn`.

```bash
cn
```

### Headless Mode

Headless mode (`-p` flag) runs without an interactive terminal UI, making it perfect for:

- Scripts and automation
- CI/CD pipelines
- Docker containers
- VSCode/IntelliJ extension integration
- Environments without a TTY

```bash
# Basic usage
cn -p "Generate a conventional commit name for the current git changes."

# With piped input
echo "Review this code" | cn -p

# JSON output for scripting
cn -p "Analyze the code" --format json

# Silent mode (strips thinking tags)
cn -p "Write a README" --silent
```

**TTY-less Environments**: Headless mode is designed to work in environments without a terminal (TTY), such as when called from VSCode/IntelliJ extensions using terminal commands. The CLI will not attempt to read stdin or initialize the interactive UI when running in headless mode with a supplied prompt.

### Session Management

The CLI automatically saves your chat history for each terminal session. You can resume where you left off:

```bash
# Choose a session to resume; the newest one of this folder is selected
cn --resume

# Resume a given session
cn --resume <sessionId>

# List sessions grouped by folder and choose one to resume
cn ls

# List sessions in JSON format (for scripting)
cn ls --json
```

## Command Line Options

- `-p`: Run in headless mode (no TUI)
- `--config <path>`: Specify agent configuration path
- `--resume [sessionId]`: Resume a session: that id, or pick one (headless: the newest session of this folder)
- `<prompt>`: Optional prompt to start with

## Environment Variables

- `FORCE_NO_TTY`: Force TTY-less mode, prevents stdin reading (useful for testing and automation)

## Commit and pull request attribution

The CLI adds no attribution to commits or pull request text. To ask for it, set this in your own `settings.json` in the global directory (project settings are ignored):

```json
{
  "attribution": {
    "commit": true,
    "pullRequest": true,
    "text": "Co-Authored-By: Me <me@example.com>"
  }
}
```

`text` is optional; the default is `Co-Authored-By: Continuous <noreply@continuous.invalid>`.

## Commands

- `cn`: Start an interactive chat session
- `cn ls`: List recent sessions, grouped by folder with this folder first, and choose one to resume
- `cn serve`: Start HTTP server mode

### Session Listing (`cn ls`)

Shows recent sessions, limited by screen height to ensure it fits on your terminal.

- `--json`: Output in JSON format for scripting (always shows 10 sessions)

## TTY-less Support

The CLI fully supports running in environments without a TTY (terminal):

```bash
# From Docker without TTY allocation
docker run --rm my-image cn -p "Generate docs"

# From CI/CD pipeline
cn -p "Review changes" --format json

# From VSCode/IntelliJ extension terminal tool
cn -p "Analyze code" --silent
```

The CLI automatically detects TTY-less environments and adjusts its behavior:

- Skips stdin reading when a prompt is supplied
- Disables interactive UI components
- Ensures clean stdout/stderr output

For more details, see [`spec/tty-less-support.md`](./spec/tty-less-support.md).
