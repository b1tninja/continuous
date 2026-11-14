import { describe, expect, it } from "vitest";
import { classifyReadOnly } from "./readOnlyCommand";
import { matchTerminalCommand, parseToolPermissions } from "./rules";
import { scanCommand } from "./shellScan";

/**
 * Windows PowerShell 5.1 reads curly quotes as quotes, en and em dashes as a
 * parameter's dash and any Unicode space as a space (checked with
 * `powershell.exe -Command` and a harmless `Write-Output`). The scanner knows
 * the ASCII ones only, so a command holding one is not understood: it is
 * never vouched as only reading and no allow rule covers it.
 */
const LDQ = "“";
const RDQ = "”";
const LSQ = "‘";
const RSQ = "’";

const HIDDEN = [
  // PowerShell: three statements. An ASCII-only reader: one quoted word.
  `Get-Content ${LDQ} ' ${RDQ} ; Remove-Item x ; ${LDQ} ' ${RDQ}`,
  `Get-Content ${LSQ} " ${RSQ} ; Remove-Item x ; ${LSQ} " ${RSQ}`,
  // An en dash starts a parameter; the reader took it for a file name
  "Get-Process –ComputerName example.invalid",
  "Get-Process —ComputerName example.invalid",
  // A no-break space, a vertical tab and a line separator split words
  "Get-Content a b",
  "Get-Content a\u000bb",
  "Get-Content a b",
];

describe("PowerShell look-alike characters are not understood", () => {
  it.each(HIDDEN)("%j is not scanned", (command) => {
    expect(scanCommand(command, "powershell").ok).toBe(false);
  });

  it.each(HIDDEN)("%j is not vouched as only reading", (command) => {
    expect(classifyReadOnly(command, { shell: "powershell" }).vouched).toBe(
      false,
    );
  });

  it("an allow rule does not cover them", () => {
    const allow = parseToolPermissions({
      allow: ["runTerminalCommand(Get-Content *)"],
    });
    expect(
      matchTerminalCommand(allow, HIDDEN[0], "powershell")?.decision,
    ).toBeUndefined();
  });

  it("the ASCII spellings are still understood", () => {
    expect(scanCommand("Get-Content 'a b'", "powershell").ok).toBe(true);
    expect(
      classifyReadOnly("Get-Content 'a b'", { shell: "powershell" }).vouched,
    ).toBe(true);
  });

  it("other shells keep these as ordinary characters", () => {
    expect(scanCommand(`cat ${LDQ}a${RDQ}`, "bash").ok).toBe(true);
  });
});
