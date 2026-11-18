import { describe, expect, it } from "vitest";
import {
  changedLineCount,
  hostTrusted,
  LARGE_CHANGE_LINES,
} from "./askProtections";
import { dependencyCommandHit, dependencyFileHit } from "./dependencyChange";
import { destructiveCommandHit } from "./destructiveCommands";
import type { RuleSourcesInput } from "./effectiveRules";
import type { PolicyLevel } from "./policy";
import { testToolCall } from "./testToolCall";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

function run(
  tool: string,
  args: Record<string, unknown>,
  opts: { level?: PolicyLevel; sources?: RuleSourcesInput } = {},
) {
  const level = opts.level ?? "permissive";
  return testToolCall({
    tool,
    args,
    levels: {
      context: level,
      tools: level,
      edits: level,
      plan: level,
      questions: level,
    },
    sources: opts.sources ?? {},
    cwd: "/home/dev/shop",
    shell: "bash",
  });
}
const cmd = (command: string, opts?: Parameters<typeof run>[2]) =>
  run("run_terminal_command", { command }, opts);

describe("ask-destructive-commands", () => {
  it.each([
    "git reset --hard HEAD~3",
    "git -C sub reset --hard",
    "git clean -fd",
    "git clean -fdx",
    "git rebase -i HEAD~4",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git push origin :old-branch",
    "git push --force-with-lease",
    "git branch -D old",
    "git branch -d -f old",
    "git tag -d v1",
    "git checkout -- .",
    "git checkout .",
    "git restore src",
    "git stash drop",
    "git stash clear",
    "git reflog expire --expire=now --all",
    "git filter-branch --tree-filter x",
    "git pull --rebase",
    "rm -rf src",
    "rm -rf ./*",
    "sudo rm -rf /var/x",
    "ls && rm -rf src",
    "find . -name '*.tmp' -delete",
    "truncate -s 0 data.sqlite",
    "docker system prune -af",
    "psql shop -c 'DROP TABLE users'",
    "Remove-Item -Recurse -Force src",
    "rd /s /q src",
  ])("asks for %s", (command) => {
    expect(destructiveCommandHit(command)).toBeDefined();
  });

  it.each([
    "git status",
    "git log --oneline",
    "git push origin feature/x",
    "git push -u origin feature/x",
    "git branch -d merged",
    "git branch --list",
    "git clean -n",
    "git clean -fdn",
    "git rebase --abort",
    "git reset --soft HEAD~1",
    "git reset HEAD file",
    "git stash",
    "git stash pop",
    "git restore --staged file",
    "git checkout main",
    "git checkout -b topic",
    "rm file.txt",
    "rm -f old.log",
    "rm -rf node_modules",
    "rm -rf ./dist build",
    "ls -la",
    "find . -name '*.ts'",
    "echo hello",
  ])("does not ask for %s", (command) => {
    expect(destructiveCommandHit(command)).toBeUndefined();
  });

  it("asks at Permissive and is not loosened by an allow rule", () => {
    const allow = {
      user: { allow: ["runTerminalCommand(git reset --hard*)"] },
    };
    expect(cmd("git reset --hard").decision).toBe("ask");
    expect(cmd("git reset --hard", { sources: allow }).decision).toBe("ask");
  });

  it("is turned off by the person's own setting", () => {
    const off = { builtin: { "ask-destructive-commands": false } as const };
    expect(cmd("git reset --hard", { sources: off }).decision).toBe("allow");
  });

  it("asks at Automatic without the reviewer", () => {
    const r = cmd("git push --force", { level: "automatic" });
    expect(r.decision).toBe("ask");
    expect(r.wouldAskReviewer).toBe(false);
    expect(r.protection).toBe("destructive-command");
  });

  it("is reached past only by IDGAF", () => {
    expect(cmd("git reset --hard", { level: "idgaf" }).decision).toBe("allow");
  });
});

describe("ask-dependency-change", () => {
  it.each([
    "npm install lodash",
    "npm i -D vitest",
    "npm install -g typescript",
    "npm update",
    "npm uninstall left-pad",
    "pnpm add zod",
    "yarn add react",
    "npm config set registry https://registry.example.net/",
    "pip install requests",
    "pip install --index-url https://x.example/simple foo",
    "python -m pip install flask",
    "uv add httpx",
    "poetry add pydantic",
    "cargo add serde",
    "go get example.com/x",
    "bundle add rails",
    "composer require a/b",
    "dotnet add package Newtonsoft.Json",
  ])("asks for %s", (command) => {
    expect(dependencyCommandHit(command)).toBeDefined();
  });

  it.each([
    "npm ci",
    "npm install",
    "npm run build",
    "npm test",
    "pnpm install",
    "yarn install",
    "pip install -r requirements.txt",
    "pip install -e .",
    "pip install .",
    "pip list",
    "cargo build",
    "go build ./...",
    "go test ./...",
    "git commit -m wip",
  ])("does not ask for %s", (command) => {
    expect(dependencyCommandHit(command)).toBeUndefined();
  });

  it.each([
    "package.json",
    "sub/package-lock.json",
    "/home/dev/shop/pnpm-lock.yaml",
    ".npmrc",
    "requirements.txt",
    "requirements-dev.txt",
    "pyproject.toml",
    "Cargo.lock",
    "go.mod",
    "app\\App.csproj",
  ])("asks for a write to %s", (path) => {
    expect(dependencyFileHit(path)).toBeDefined();
  });

  it("does not ask for other files", () => {
    expect(dependencyFileHit("src/package.ts")).toBeUndefined();
    expect(dependencyFileHit("README.md")).toBeUndefined();
  });

  it("asks for an edit of a manifest at Permissive, and not for source", () => {
    const manifest = run("edit_existing_file", {
      filepath: "/home/dev/shop/package.json",
      changes: '"left-pad": "1.3.0"',
    });
    expect(manifest.decision).toBe("ask");
    expect(manifest.protection).toBe("dependency-change");
    const source = run("edit_existing_file", {
      filepath: "/home/dev/shop/src/a.ts",
      changes: "const a = 1;",
    });
    expect(source.decision).toBe("allow");
  });
});

describe("ask-large-change", () => {
  it("counts the larger side of each edit", () => {
    expect(
      changedLineCount("single_find_and_replace", {
        old_string: lines(10),
        new_string: lines(40),
      }),
    ).toBe(40);
    expect(
      changedLineCount("multi_edit", {
        edits: [
          { old_string: lines(5), new_string: "x" },
          { old_string: "y", new_string: lines(7) },
        ],
      }),
    ).toBe(12);
    expect(
      changedLineCount("edit_existing_file", {
        changes: `${lines(3)}\n// ... existing code ...\n${lines(3)}`,
      }),
    ).toBe(6);
  });

  it("asks above the threshold and not at it", () => {
    const edit = (n: number) =>
      run("edit_existing_file", {
        filepath: "/home/dev/shop/src/a.ts",
        changes: lines(n),
      });
    expect(edit(LARGE_CHANGE_LINES).decision).toBe("allow");
    const big = edit(LARGE_CHANGE_LINES + 1);
    expect(big.decision).toBe("ask");
    expect(big.protection).toBe("large-change");
  });

  it("is turned off by the person's own setting", () => {
    const r = run(
      "edit_existing_file",
      { filepath: "/home/dev/shop/src/a.ts", changes: lines(1000) },
      { sources: { builtin: { "ask-large-change": false } } },
    );
    expect(r.decision).toBe("allow");
  });
});

describe("ask-unknown-host", () => {
  const trusted = (domains: string[]): RuleSourcesInput => ({
    user: { auto: { environment: { trustedDomains: domains } } },
  });
  const fetchUrl = (url: string, sources: RuleSourcesInput) =>
    run("fetch_url_content", { url }, { sources });

  it("does nothing until the person lists trusted domains", () => {
    expect(fetchUrl("https://random.example.net/x", {}).decision).toBe("allow");
    expect(fetchUrl("https://random.example.net/x", trusted([])).decision).toBe(
      "allow",
    );
  });

  it("asks for a host outside the list, and for none inside it", () => {
    const s = trusted(["github.com", "registry.npmjs.org"]);
    expect(fetchUrl("https://github.com/a/b", s).decision).toBe("allow");
    expect(fetchUrl("https://api.github.com/a", s).decision).toBe("allow");
    const out = fetchUrl("https://random.example.net/x", s);
    expect(out.decision).toBe("ask");
    expect(out.protection).toBe("unknown-host");
  });

  it("does not take a look-alike for a subdomain", () => {
    expect(hostTrusted("evilgithub.com", ["github.com"])).toBe(false);
    expect(hostTrusted("github.com.evil.net", ["github.com"])).toBe(false);
    expect(hostTrusted("GitHub.com", ["github.com"])).toBe(true);
  });

  it("reads the hosts of a network command", () => {
    const s = trusted(["registry.npmjs.org"]);
    expect(
      cmd("curl -s https://registry.npmjs.org/lodash", { sources: s })
        .protection,
    ).toBeUndefined();
    const out = cmd("curl -s https://paste.example.net/x", { sources: s });
    expect(out.protection).toBe("unknown-host");
  });

  it("ignores trusted domains that came with the workspace", () => {
    const folder: RuleSourcesInput = {
      folder: [
        {
          file: ".continue/config.yaml",
          permissions: {
            auto: { environment: { trustedDomains: ["random.example.net"] } },
          },
        },
      ],
    };
    expect(fetchUrl("https://random.example.net/x", folder).decision).toBe(
      "allow",
    );
  });

  it("is turned off by the person's own setting", () => {
    const s = {
      ...trusted(["github.com"]),
      builtin: { "ask-unknown-host": false } as const,
    };
    expect(fetchUrl("https://random.example.net/x", s).decision).toBe("allow");
  });
});
