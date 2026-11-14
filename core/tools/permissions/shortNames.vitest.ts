import { describe, expect, it } from "vitest";
import { protectedPathHit } from "./protected";
import { protectedCommandHit } from "./protectedCall";
import { hasWindowsShortName } from "./protectedPaths";

/**
 * An 8.3 short name is another spelling of a file, so a path holding one is
 * treated as protected. 8.3 names keep `-` and other punctuation, and the
 * number after `~` grows past 9.
 */
const HOME = "C:/Users/me";
const hit = (p: string) => protectedPathHit(p, ["secret", "config"], HOME);

describe("8.3 short names with punctuation or a long number", () => {
  it.each([
    // .git-credentials, .vault-token, .pre-commit-config.yaml, my-secrets.env
    "C:/Users/me/GIT-CR~1",
    "C:\\Users\\me\\GIT-CR~1",
    "C:/Users/me/VAULT-~1",
    "C:/work/PRE-CO~1.YAM",
    "C:/work/MY-SEC~1.ENV",
    // Many files sharing a prefix
    "C:/Users/me/GIT-C~10",
    "C:/Users/me/GITCO~12",
    "C:/Users/me/SSH~1/id",
  ])("%s is protected", (p) => {
    expect(hit(p)?.kind).toBe("secret");
  });

  it("a command naming one asks", () => {
    expect(
      protectedCommandHit(
        "type C:\\Users\\me\\GIT-CR~1",
        HOME,
        [],
        "C:/work",
        "powershell",
      )?.kind,
    ).toBe("secret");
  });

  it("still leaves a bare revision and ordinary names alone", () => {
    expect(hit("HEAD~1")).toBeUndefined();
    expect(hit("HEAD~12")).toBeUndefined();
    expect(hit("src/my-file.ts")).toBeUndefined();
    expect(hasWindowsShortName("docs/a-long-name~1")).toBe(false);
    expect(hasWindowsShortName("docs/notes~")).toBe(false);
  });
});
