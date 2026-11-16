import { describe, expect, it } from "vitest";
import { describeAction, runsThrough } from "./actionSummary";

const through = (command: string) =>
  describeAction("run_terminal_command", { command }).fields.find(
    (f) => f.label === "Runs through",
  )?.value;

describe("the approval card names the interpreter a command hands its text to", () => {
  it("adds nothing for an ordinary command", () => {
    for (const command of [
      "npm test",
      "git status && git diff",
      "Get-ChildItem -Recurse | Select-Object Name",
      "python manage.py migrate",
      "echo 'bash -c is only text here'",
    ]) {
      expect(through(command)).toBeUndefined();
    }
  });

  it("names a shell started inside the command", () => {
    expect(through("bash -c 'rm -rf build && make'")).toBe("bash -c");
    expect(through("cmd /c dir")).toBe("cmd /c");
    expect(through("wsl bash -lc 'make test'")).toBe("bash -lc in WSL");
  });

  it("names each level of a nested shell, outermost first", () => {
    expect(through(`bash -c "pwsh -c 'Get-Date'"`)).toBe(
      "bash -c, then pwsh -c",
    );
  });

  it("says when the shell on the other side is not known", () => {
    expect(through("ssh deploy@host uptime")).toBe(
      "the login shell on deploy@host (ssh). Which shell reads it there is not known here.",
    );
  });

  it("says when what runs is not written in the command", () => {
    expect(through("./deploy.sh --prod")).toContain(
      "What that runs is not all written in this command.",
    );
  });

  it("is read from the real command and shown masked", () => {
    const shown = runsThrough("ssh -o ProxyCommand=x API_TOKEN=abc123@host ls");
    expect(shown).toBeDefined();
    expect(shown).not.toContain("abc123");
  });
});
