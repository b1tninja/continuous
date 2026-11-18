import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { mergeParentOptions } from "./shared-options.js";

describe("mergeParentOptions", () => {
  it("passes --beta-subagent-tool down to a subcommand such as serve", () => {
    const parent = new Command().option(
      "--beta-subagent-tool",
      "Enable the Subagent tool",
    );
    parent.parse(["--beta-subagent-tool"], { from: "user" });

    expect(mergeParentOptions(parent, {}).betaSubagentTool).toBe(true);
  });

  it("passes --policy and --trust-project-hooks down, so `--policy careful serve` runs at careful", () => {
    const parent = new Command()
      .option("--policy <spec>")
      .option("--trust-project-hooks");
    parent.parse(["--policy", "careful", "--trust-project-hooks"], {
      from: "user",
    });

    const merged = mergeParentOptions(parent, {});
    expect(merged.policy).toBe("careful");
    expect(merged.trustProjectHooks).toBe(true);
  });

  it("keeps a value the subcommand was given itself", () => {
    const parent = new Command().option("--policy <spec>");
    parent.parse(["--policy", "idgaf"], { from: "user" });
    expect(mergeParentOptions(parent, { policy: "careful" }).policy).toBe(
      "careful",
    );
  });
});
