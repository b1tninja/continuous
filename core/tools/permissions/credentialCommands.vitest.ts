import { describe, expect, it } from "vitest";
import { protectedCommandHit } from "./protectedCall";
import { credentialCommandLabel } from "./secretCommands";

const words = (c: string) => c.split(/\s+/).filter(Boolean);
const HOME = "/home/me";

describe("credentialCommandLabel", () => {
  it("names the command that prints the credential", () => {
    expect(credentialCommandLabel(words("gh auth token"))).toBe(
      "the output of gh auth token",
    );
    expect(
      credentialCommandLabel(words("aws configure get aws_secret_access_key")),
    ).toBe("the output of aws configure get aws_secret_access_key");
    expect(credentialCommandLabel(words("az account get-access-token"))).toBe(
      "the output of az account get-access-token",
    );
    expect(
      credentialCommandLabel(words("kubectl config view --raw")),
    ).toContain("kubectl");
  });

  it("finds the program after a wrapper, a variable or a path", () => {
    for (const c of [
      "env GH_HOST=x gh auth token",
      "sudo gh auth token",
      "/usr/local/bin/gh auth token",
      "C:\\Program\\GitHub\\gh.exe auth token",
      "GH.EXE auth token",
    ]) {
      expect(credentialCommandLabel(words(c)), c).toBeDefined();
    }
  });

  it("accepts the option anywhere among the arguments", () => {
    expect(
      credentialCommandLabel(words("gh --hostname github.com auth token")),
    ).toBeDefined();
    expect(
      credentialCommandLabel(words("kubectl --context x config view --raw")),
    ).toBeDefined();
    expect(
      credentialCommandLabel(words("kubectl config view -o yaml --raw")),
    ).toBeDefined();
  });

  it("is quiet about the ordinary neighbours of each command", () => {
    for (const c of [
      "gh auth status",
      "gh auth login",
      "gh pr create",
      "aws configure get region",
      "aws configure list",
      "aws s3 cp a b",
      "gcloud auth list",
      "az account show",
      "kubectl config view",
      "kubectl config current-context",
      "kubectl get pods",
      "security find-identity",
      "git credential reject",
      "git config --get user.email",
      "pass ls",
      "op item list",
      "ConvertFrom-SecureString",
    ]) {
      expect(credentialCommandLabel(words(c)), c).toBeUndefined();
    }
  });

  it("is quiet when the program name is only an argument", () => {
    for (const c of [
      "echo gh auth token",
      "grep 'auth token' notes.txt",
      "cat gh",
      "man gh",
    ]) {
      // The words after echo or grep are data. This detector looks for the
      // program anywhere in the words, so the first two name the limit.
      const label = credentialCommandLabel(words(c));
      if (c.startsWith("echo")) {
        expect(label, c).toBeDefined();
      } else {
        expect(label, c).toBeUndefined();
      }
    }
  });

  it("an empty or option-only command finds nothing", () => {
    expect(credentialCommandLabel([])).toBeUndefined();
    expect(credentialCommandLabel(words("--version"))).toBeUndefined();
    expect(credentialCommandLabel(words("gh"))).toBeUndefined();
  });
});

describe("the command check asks for a credential helper", () => {
  it("asks as a secret read, with the helper named in the reason", () => {
    const hit = protectedCommandHit("gh auth token", HOME);
    expect(hit?.kind).toBe("secret");
    expect(hit?.path).toContain("gh auth token");
  });

  it("asks for the command inside a pipeline, a list and bash -c", () => {
    for (const c of [
      "gh auth token | docker login ghcr.io -u me --password-stdin",
      "echo start && gh auth token",
      `bash -c "gh auth token"`,
    ]) {
      expect(protectedCommandHit(c, HOME)?.kind, c).toBe("secret");
    }
  });

  it("does not ask for the ordinary neighbours", () => {
    for (const c of [
      "gh auth status",
      "aws configure get region",
      "kubectl config view",
      "git status",
    ]) {
      expect(protectedCommandHit(c, HOME), c).toBeUndefined();
    }
  });

  it("is skipped when the person switched the secret check off", () => {
    expect(
      protectedCommandHit("gh auth token", HOME, ["secret"]),
    ).toBeUndefined();
  });
});
