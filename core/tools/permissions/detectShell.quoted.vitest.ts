import { describe, expect, it } from "vitest";
import { detectCommandShell, maskQuoted, mismatchedShell } from "./detectShell";

describe("maskQuoted", () => {
  it("blanks the inside of both kinds of quote, keeping length and quotes", () => {
    const out = maskQuoted(`a "b c" 'd' e`);
    expect(out).toBe(`a "   " ' ' e`);
    expect(out).toHaveLength(`a "b c" 'd' e`.length);
  });
  it("lets a backslash escape a quote inside double quotes", () => {
    expect(maskQuoted(`x "a\\"b" y`)).toBe(`x "    " y`);
  });
  it("leaves an unterminated quote masked to the end, and plain text alone", () => {
    expect(maskQuoted(`ls -la`)).toBe(`ls -la`);
    expect(maskQuoted(`echo "abc`)).toBe(`echo "   `);
  });
  it("keeps newlines so line-anchored signals still work", () => {
    expect(maskQuoted(`"a\nb"`)).toBe(`" \n "`);
  });
});

describe("detectCommandShell: text that is not shell syntax", () => {
  const node =
    'cd ~/.continuous/dev_data/0.2.0; node -e "const l=x.filter(x=>{try{return JSON.parse(x)}catch(e){return null}}).map(({a,b})=>a)"';

  it("does not take a node -e script for bash in PowerShell", () => {
    expect(mismatchedShell(detectCommandShell(node), "powershell")).toBe(false);
  });
  it("does not count ~/ as evidence of a Unix shell", () => {
    const d = detectCommandShell("cd ~/projects");
    expect(d.likely).toEqual([]);
    expect(mismatchedShell(d, "powershell")).toBe(false);
  });
  it("does not count a {a,b} inside quotes", () => {
    expect(detectCommandShell(`node -e "f({a,b})"`).likely).toEqual([]);
    expect(detectCommandShell(`echo '{a,b}'`).likely).toEqual([]);
  });
  it("does not count an arrow function body or a call with an object", () => {
    expect(detectCommandShell("x=>{a,b}").likely).toEqual([]);
    expect(detectCommandShell("f({a,b})").likely).toEqual([]);
  });
});

describe("detectCommandShell: real brace expansion and Unix commands still count", () => {
  it("reads echo {a,b}.txt and a range as bash or zsh", () => {
    expect(detectCommandShell("echo {a,b}.txt; arr=(1 2 3)").likely).toEqual([
      "bash",
      "zsh",
    ]);
    expect(detectCommandShell("touch f{1..3}.txt").likely).toContain("bash");
  });
  it("still flags ls -la ~/x and rm -rf {a,b} as POSIX in PowerShell", () => {
    expect(
      mismatchedShell(detectCommandShell("ls -la ~/x"), "powershell"),
    ).toBe(true);
    expect(
      mismatchedShell(detectCommandShell("rm -rf {a,b}"), "powershell"),
    ).toBe(true);
  });
});
