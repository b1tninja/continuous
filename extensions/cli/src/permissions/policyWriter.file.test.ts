import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { loadPermissionsYaml } from "./permissionsYamlLoader.js";
import {
  addPolicyToYaml,
  PolicyFileNotLoadedError,
  policySaveFailureNotice,
} from "./policyWriter.js";

const FULL_FILE = `# My permissions. Edited by hand.
levels:
  bash: cautious # never raise this
floor:
  # nothing may touch the deploy key
  - Read(~/.ssh/deploy_key)
  - Bash(git push --force*)
allow:
  - Read # reading is fine
  - Bash(git status)
ask:
  - Write
exclude:
  - Fetch # Never
mcpServers:
  github: trusted
`;

describe('addPolicyToYaml (the terminal\'s "always allow")', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-writer-"));
    file = path.join(dir, "permissions.yaml");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds one line and keeps everything else as written", async () => {
    fs.writeFileSync(file, FULL_FILE);
    await addPolicyToYaml("Bash(npm test)", file);

    const after = fs.readFileSync(file, "utf8");
    // The only difference is the new list entry
    expect(after).toBe(
      FULL_FILE.replace(
        "  - Bash(git status)\n",
        "  - Bash(git status)\n  - Bash(npm test)\n",
      ),
    );
    expect(loadPermissionsYaml(file)?.allow).toEqual([
      "Read",
      "Bash(git status)",
      "Bash(npm test)",
    ]);
    expect(fs.readdirSync(dir)).toEqual(["permissions.yaml"]);
  });

  it("does not write when the rule is already there", async () => {
    fs.writeFileSync(file, FULL_FILE);
    const before = fs.statSync(file).mtimeMs;
    await addPolicyToYaml("Bash(git status)", file);
    expect(fs.readFileSync(file, "utf8")).toBe(FULL_FILE);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it.each([
    [
      "malformed YAML",
      "floor:\n  - Bash(rm -rf*)\nallow: [Read\nexclude:\n  - Fetch\n",
      /is not valid YAML/,
    ],
    [
      "an unknown top-level key",
      "floor:\n  - Bash(rm -rf*)\nalow:\n  - Read\n",
      /unrecognised top-level key "alow"/,
    ],
    [
      "a list written as a string",
      "floor:\n  - Bash(rm -rf*)\nallow: Read\n",
      /"allow" must be a list/,
    ],
    ["a list at the top level", "- Read\n- Write\n", /wrong structure/],
  ])(
    "refuses to write over a file with %s, and names the file",
    async (_name, text, problem) => {
      fs.writeFileSync(file, text);
      // The loader does not load this file: before, the writer then started
      // again from an empty policy and the floor: rules were gone.
      expect(loadPermissionsYaml(file)).toBeNull();

      const error = await addPolicyToYaml("Read", file).catch((e) => e);
      expect(error).toBeInstanceOf(PolicyFileNotLoadedError);
      expect(error.message).toContain(file);
      expect(error.message).toMatch(problem);
      expect(error.message).toContain("Not saved");
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      expect(fs.readdirSync(dir)).toEqual(["permissions.yaml"]);
    },
  );

  it("the refusal does not quote the file", async () => {
    fs.writeFileSync(file, "floor:\n  - Read(secret-name-xyz)\nallow: [Read\n");
    const error = await addPolicyToYaml("Read", file).catch((e) => e);
    expect(error.message).not.toContain("secret-name-xyz");
    expect(error.message).not.toContain("\n");
    expect(policySaveFailureNotice(error)).toContain(
      "This call was allowed once",
    );
  });

  it("creates the file when there is none", async () => {
    await addPolicyToYaml("Read", file);
    expect(YAML.parse(fs.readFileSync(file, "utf8"))).toEqual({
      allow: ["Read"],
    });
  });

  it.each([
    ["an empty file", ""],
    ["only comments", "# mine\n"],
    ["the default file", "# cn tool permissions\n\nallow: []\n\nask: []\n"],
    ["allow with nothing after it", "allow:\nask:\n  - Write\n"],
    ["no allow key", "# mine\nask:\n  - Write\n"],
  ])("adds the rule to %s", async (_name, text) => {
    fs.writeFileSync(file, text);
    await addPolicyToYaml("Bash(npm run build)", file);
    const after = fs.readFileSync(file, "utf8");
    expect(loadPermissionsYaml(file)?.allow).toEqual(["Bash(npm run build)"]);
    // Comments and the other lists are still there
    for (const line of text.split("\n").filter((l) => l.startsWith("#"))) {
      expect(after).toContain(line);
    }
    if (text.includes("- Write")) {
      expect(loadPermissionsYaml(file)?.ask).toEqual(["Write"]);
    }
  });

  it("keeps the file when the write fails part way", async () => {
    fs.writeFileSync(file, FULL_FILE);
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data) => {
      if (typeof target === "number") {
        const error: NodeJS.ErrnoException = new Error("ENOSPC: no space");
        error.code = "ENOSPC";
        throw error;
      }
      realWrite(target, data as string);
    });
    await expect(addPolicyToYaml("Bash(npm test)", file)).rejects.toThrow(
      /ENOSPC/,
    );
    vi.restoreAllMocks();
    expect(fs.readFileSync(file, "utf8")).toBe(FULL_FILE);
    expect(fs.readdirSync(dir)).toEqual(["permissions.yaml"]);
  });
});
