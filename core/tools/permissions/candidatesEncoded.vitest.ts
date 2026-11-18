import { describe, expect, it } from "vitest";
import { commandCandidateSet } from "./candidates";
import { matchTerminalCommand, parseToolPermissions } from "./rules";

const encode = (text: string) =>
  Buffer.from(text, "utf16le").toString("base64");

const rules = parseToolPermissions({
  deny: ["runTerminalCommand(Remove-Item *)"],
  ask: ["runTerminalCommand(git push*)"],
  allow: ["runTerminalCommand(echo *)"],
});

describe("powershell -EncodedCommand is read decoded by deny and ask rules", () => {
  const hidden = encode("Remove-Item -Recurse canary");

  it.each([
    `powershell -EncodedCommand ${hidden}`,
    `powershell -enc ${hidden}`,
    `powershell -e ${hidden}`,
    `pwsh -NoProfile -ec ${hidden}`,
    `powershell.exe -NoP -NonI -W Hidden -Enc ${hidden}`,
    `powershell /e ${hidden}`,
    `powershell \u2013enc ${hidden}`,
    `cmd /c powershell -enc ${hidden}`,
    `bash -c "pwsh -e ${hidden}"`,
  ])("deny sees inside: %s", (command) => {
    for (const shell of ["powershell", "cmd", "bash", "unknown"] as const) {
      expect(matchTerminalCommand(rules, command, shell)?.decision).toBe(
        "deny",
      );
    }
  });

  it("ask sees inside, and an alias is read as its cmdlet", () => {
    expect(
      matchTerminalCommand(
        rules,
        `powershell -enc ${encode("git push origin main")}`,
        "powershell",
      )?.decision,
    ).toBe("ask");
    expect(
      matchTerminalCommand(
        rules,
        `powershell -enc ${encode("rm -Recurse canary")}`,
        "powershell",
      )?.decision,
    ).toBe("deny");
  });

  it("fails closed when the word cannot be decoded", () => {
    const set = commandCandidateSet("powershell -enc ###", "powershell");
    expect(set.truncated).toBe(true);
    expect(
      matchTerminalCommand(rules, "powershell -enc ###", "powershell")
        ?.decision,
    ).toBe("deny");
  });

  it("does not take -ExecutionPolicy or another program's -e for it", () => {
    for (const command of [
      "powershell -ex Bypass -File build.ps1",
      "powershell -ep Bypass -Command Get-Date",
      'node -e "console.log(1)"',
      "grep -e pattern file.txt",
    ]) {
      expect(commandCandidateSet(command, "powershell").truncated).toBe(false);
    }
  });

  it("an innocent encoded command matches no deny rule", () => {
    expect(
      matchTerminalCommand(
        rules,
        `powershell -enc ${encode("Get-Date")}`,
        "powershell",
      ),
    ).toBeUndefined();
  });
});
