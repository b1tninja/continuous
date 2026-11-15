# Permissions

## Permission types

To make sure that users can oversee the actions of the LLM, we implement a permissions system. Every tool has one of the following permissions:

- `allow`: The tool will be automatically called without asking
- `ask`: We will ask the user before calling the tool, giving them the options to accept or reject
- `exclude`: This tool will be completely excluded, so the model won't even know it exists

## Rule precedence

There is a default set of permissions for the builtin tools in [`src/permissions/defaultPolicies.ts`](../src/permissions/defaultPolicies.ts). But these policies can be overriden by multiple layers. The order of precedence is as follows, which the earlier items taking precedence:

1. **Mode policies** (highest priority - see [modes.md](./modes.md))
2. Command line flags (`--allow`, `--ask`, `--exclude`)
3. Permissions in `config.yaml` / configuration
4. Permissions in `~/.continue/permissions.yaml`
5. Default policies

**Note:** Mode policies **completely override all other permission settings** in plan and auto modes. Available modes:

- `normal`: No mode policies (uses existing configuration)
- `plan`: **Absolute override** - excludes all write tools, allows only read tools (ignores user config)
- `auto`: **Absolute override** - allows all tools without asking (ignores user config)

## Tool matching patterns

We use a tool matching pattern to match tools to permissions. This format looks like the following:

- `Read` matches any call to the `Read` tool
- `Read(*)` also matches any call to the `Read` tool
- `Read(**/*.ts)` matches any call to the `Read` tool where the primary parameter matches the glob pattern `**/*.ts`.

Note that for an `exclude` policy, it doesn't make sense to have argument matching.

## Command line flags

Each of the `--allow`, `--ask`, and `--exclude` flags allow you to set the permission for a tool. Usage must be a "tool matching pattern" as described above for each flag, with each providing a policy that will be added to the list of policies in order.

```bash
# Allow Read, Ask Write, and Exclude Bash
cn --allow Read --ask Write --exclude Bash

# Start in plan mode (read-only tools only)
cn --readonly "Help me understand this codebase"

# Use mode switching during chat
cn "Let me work on this feature"  # Starts in normal mode
# Then use Shift+Tab to cycle through modes
```

## `config.yaml` / Configuration (implement later)

::: info
This should not be implemented yet.
:::

To let users define their permissions as a part of their custom assistant, they can do so in the permissions section of `config.yaml` or their configuration:

```yaml
permissions:
  allow:
    - Read(*)

  ask:
    - Write(**/*.py)

  exclude:
    - Write
```

## `~/.continue/permissions.yaml` (personal settings)

It would be frustrating for users to have to set the same permissions across all of their assistants, so we provide them a file for personal settings. It should be basically equivalent to the `permissions` section of `config.yaml`:

```yaml title="~/.continue/permissions.yaml"
allow:
  - Read(*)

ask:
  - Write(**/*.py)

exclude:
  - Write
```

Except that it's important to understand that this file is _not_ intended to be edited by the user. It is only for persistence, and users should interact with their permissions by using the TUI.

This file should be created the first time that the CLI starts.

## Headless mode permissions

Headless runs (`-p` or `--print`, and `serve`) use the same defaults as the TUI, and run at the person's own policy levels: the ones saved in `permissions.yaml`, or the defaults (Careful).

- **TUI**: Bash, and any tool without its own entry, asks. Edit, MultiEdit and Write ask.
- **Headless**: the same lists and the same levels. Nobody can answer a question, so a call that would ask is refused. The tool result says so and names the flags that allow it, and one line on stderr per tool says the same to whoever runs the script. A call that the levels or a rule allow (a read-only command at Context use Permissive, an allow rule) runs.
- **IDGAF**: `--policy idgaf` or `--auto` (IDGAF on the three tool areas) runs everything, headless too. Nothing asks, so nothing is refused.

A headless run starts with one line on stderr that names the levels it runs at and the flag that set them.

`--allow` grants a tool whose default is ask. `--auto` or `--policy <preset|area=level|file>` loosens the levels for the run. A `--policy` file is in the `permissions.yaml` format; its levels and settings stand in for the person's own.

```bash
# Let a headless run use Write, which asks by default
cn -p --allow Write "Write a hello world script"

# Run commands and edits without asking (a dependency change still asks, so it is refused)
cn -p --policy handsOff "Fix the failing test"

# Levels from a file kept with the pipeline
cn -p --policy ./ci/policy.yaml "Fix the failing test"
```

Before 2.18.0 the headless lists allowed Bash and every tool without its own entry, MCP tools included. `CONTINUOUS_HEADLESS_LEGACY_ALLOW=1` brings those lists back for one release; it is removed in the release after, so a script should pass `--auto` or `--policy` instead.
