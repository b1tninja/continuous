import { describe, expect, it } from "vitest";
import { classifyReadOnly } from "./readOnlyCommand";

/**
 * A command vouched as only reading runs under the Context level, and nothing
 * that contacts the network is vouched (readOnlyCommand.ts). `Get-Process
 * -ComputerName` asks another machine for its processes, and Windows signs in
 * to that machine to do it, the same reason a `\\host\share` path asks.
 */
const vouched = (command: string) =>
  classifyReadOnly(command, { shell: "powershell" }).vouched;

describe("Get-Process on another computer is not a local read", () => {
  it.each([
    "Get-Process -ComputerName example.invalid",
    "Get-Process -Name node -ComputerName example.invalid",
    "Get-Process -ComputerName:example.invalid",
    // PowerShell takes any unambiguous prefix of a parameter name
    "Get-Process -Computer example.invalid",
    "Get-Process -cn example.invalid",
    "ps -ComputerName example.invalid",
    "gps -ComputerName example.invalid",
  ])("%s is not vouched", (command) => {
    expect(vouched(command)).toBe(false);
  });

  it("a local Get-Process is still vouched", () => {
    expect(vouched("Get-Process")).toBe(true);
    expect(vouched("Get-Process -Name node")).toBe(true);
    expect(vouched("Get-Process -Id 4")).toBe(true);
  });
});
