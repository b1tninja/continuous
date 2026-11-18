import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { addCommonOptions } from "./shared-options.js";

/** The help line(s) for one flag, joined. */
function describeFlag(command: Command, long: string): string {
  const option = command.options.find((o) => o.long === long);
  if (!option) throw new Error(`no option ${long}`);
  return `${option.flags} ${option.description}`;
}

describe("addCommonOptions help text", () => {
  const command = addCommonOptions(new Command());

  // Hub loading was removed (hubLoader.ts), so a slug given to any of these
  // fails. The help must describe what they take today.
  it.each(["--config", "--rule", "--mcp", "--model", "--prompt", "--agent"])(
    "%s does not offer the hub or a slug",
    (long) => {
      expect(describeFlag(command, long)).not.toMatch(/hub|slug|owner\//i);
    },
  );

  it("says what each flag takes", () => {
    expect(describeFlag(command, "--config")).toContain("config.yaml");
    expect(describeFlag(command, "--rule")).toContain("path to a rule file");
    expect(describeFlag(command, "--mcp")).toContain("http(s) URL");
    expect(describeFlag(command, "--model")).toContain("YAML file");
    expect(describeFlag(command, "--prompt")).toContain("path to a file");
    expect(describeFlag(command, "--agent")).toContain(".md file");
  });
});
