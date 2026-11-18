import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECURITY_IGNORE_DIRS as fromIgnoreDirs,
  DEFAULT_SECURITY_IGNORE_FILETYPES as fromIgnoreFiles,
  isSecurityConcern,
} from "./ignore";
import {
  DEFAULT_SECURITY_IGNORE_DIRS,
  DEFAULT_SECURITY_IGNORE_FILETYPES,
  securityPatternHit,
} from "./securityPatterns";

describe("securityPatternHit", () => {
  it.each([
    ".env",
    ".env.local",
    "app/.env.production",
    "server.pem",
    "deploy/tls.key",
    "id_rsa",
    "id_ed25519",
    ".ssh/config",
    "home/.aws/credentials",
    "secrets/token.txt",
    "putty.ppk",
  ])("flags %s", (p) => {
    expect(securityPatternHit(p)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "docs/env-setup.md", "id_rsa.pub"])(
    "does not flag %s",
    (p) => {
      expect(securityPatternHit(p)).toBe(false);
    },
  );

  it("accepts backslashes and a leading ./", () => {
    expect(securityPatternHit(".\config\.env")).toBe(true);
    expect(securityPatternHit("./src/.env")).toBe(true);
  });

  it("does not judge absolute or climbing paths", () => {
    expect(securityPatternHit("/home/me/.env")).toBe(false);
    expect(securityPatternHit("C:/Users/me/.env")).toBe(false);
    expect(securityPatternHit("../.env")).toBe(false);
    expect(securityPatternHit("")).toBe(false);
  });

  it("agrees with isSecurityConcern on relative paths", () => {
    for (const p of [".env", "src/app.ts", "keys/a.txt", "x/id_rsa"]) {
      expect(securityPatternHit(p)).toBe(isSecurityConcern(p));
    }
  });
});

describe("ignore.ts re-exports", () => {
  it("re-exports the same arrays", () => {
    expect(fromIgnoreFiles).toBe(DEFAULT_SECURITY_IGNORE_FILETYPES);
    expect(fromIgnoreDirs).toBe(DEFAULT_SECURITY_IGNORE_DIRS);
  });
});
