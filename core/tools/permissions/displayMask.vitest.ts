import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { maskArgsForDisplay, maskCommandForDisplay } from "./displayMask";
import { evaluateToolPolicyWithRules } from "./evaluate";

// Fake values only: shaped like credentials, belonging to nobody
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";
const FAKE_TOKEN = "fake-token-value-for-tests";

describe("maskCommandForDisplay", () => {
  it("keeps the name and hides the value of a secret-named assignment", () => {
    const out = maskCommandForDisplay(`API_KEY=${FAKE_TOKEN} npm test`);
    expect(out).toContain("API_KEY=");
    expect(out).toContain("npm test");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  it("masks PowerShell and cmd forms", () => {
    for (const cmd of [
      `$env:GITHUB_TOKEN='${FAKE_TOKEN}'; git push`,
      `$env:GITHUB_TOKEN = "${FAKE_TOKEN}"; git push`,
      `set GITHUB_TOKEN=${FAKE_TOKEN}&& git push`,
      `export GITHUB_TOKEN=${FAKE_TOKEN}; git push`,
      `env GITHUB_TOKEN=${FAKE_TOKEN} git push`,
    ]) {
      const out = maskCommandForDisplay(cmd);
      expect(out, cmd).toContain("GITHUB_TOKEN");
      expect(out, cmd).not.toContain(FAKE_TOKEN);
      expect(out, cmd).toContain("git push");
    }
  });

  it("masks a credential-shaped value under an innocent name", () => {
    const out = maskCommandForDisplay(`FOO=${FAKE_KEY} run`);
    expect(out).toContain("FOO=");
    expect(out).not.toContain(FAKE_KEY);
  });

  it("leaves a command with nothing to hide as it was", () => {
    for (const cmd of ["ls -la", "NODE_ENV=test npm test", "FOO=bar make"]) {
      expect(maskCommandForDisplay(cmd)).toBe(cmd);
    }
  });

  it("is idempotent", () => {
    const once = maskCommandForDisplay(`API_KEY=${FAKE_TOKEN} x`);
    expect(maskCommandForDisplay(once)).toBe(once);
  });
});

describe("maskArgsForDisplay", () => {
  it("masks every string in a copy and leaves the input alone", () => {
    const args = Object.freeze({
      command: `API_KEY=${FAKE_TOKEN} npm test`,
      nested: Object.freeze({ list: [`TOKEN=${FAKE_TOKEN}`, 3, null] }),
      timeout: 5,
    });
    const shown = maskArgsForDisplay(args);
    expect(JSON.stringify(shown)).not.toContain(FAKE_TOKEN);
    expect(shown.timeout).toBe(5);
    expect(args.command).toContain(FAKE_TOKEN);
    expect(args.nested.list[0]).toContain(FAKE_TOKEN);
  });
});

describe("display masking never reaches what runs", () => {
  const tool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, a: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, a.command as string),
  };

  it("the decision shows the masked command while the arguments the tool gets are untouched", () => {
    const command = `API_KEY=${FAKE_TOKEN} npm test`;
    const parsedArgs = { command };
    const result = evaluateToolPolicyWithRules({
      tool: tool as any,
      toolName: "run_terminal_command",
      basePolicy: "allowedWithPermission",
      parsedArgs,
      permissions: undefined,
      shell: "bash",
    });
    expect(result.displayValue).toContain("API_KEY=");
    expect(result.displayValue).not.toContain(FAKE_TOKEN);
    // the same object, the same text: this is what the tool is called with
    expect(parsedArgs.command).toBe(command);
    expect(command).toContain(FAKE_TOKEN);
  });
});
