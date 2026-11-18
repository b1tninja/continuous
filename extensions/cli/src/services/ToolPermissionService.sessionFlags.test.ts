import { beforeEach, describe, expect, test, vi } from "vitest";

import type { PermissionsYamlConfig } from "../permissions/permissionsYamlLoader.js";

import { ToolPermissionService } from "./ToolPermissionService.js";

// permissions.yaml as the real resolver sees it; the rest of the loader and
// the resolver are the real ones.
const yaml = vi.hoisted(() => ({
  config: null as PermissionsYamlConfig | null,
}));
vi.mock("../permissions/permissionsYamlLoader.js", async () => {
  const actual = await vi.importActual<
    typeof import("../permissions/permissionsYamlLoader.js")
  >("../permissions/permissionsYamlLoader.js");
  return { ...actual, loadPermissionsYaml: () => yaml.config };
});

function firstPolicyFor(service: ToolPermissionService, tool: string) {
  return service.getPermissions().policies.find((p) => p.tool === tool)
    ?.permission;
}

describe('session flags survive an "always allow" reload', () => {
  beforeEach(() => {
    yaml.config = { allow: [] };
  });

  test("--exclude Bash, then always allow Read: Bash is still excluded", async () => {
    const service = new ToolPermissionService();
    service.initializeSync({ exclude: ["Bash"] });
    expect(firstPolicyFor(service, "Bash")).toBe("exclude");

    // "Always allow" adds a line to permissions.yaml and reloads
    yaml.config = { allow: ["Read"] };
    await service.reloadPermissions();

    expect(firstPolicyFor(service, "Read")).toBe("allow");
    expect(firstPolicyFor(service, "Bash")).toBe("exclude");
  });

  test("--ask and --allow keep outranking permissions.yaml", async () => {
    const service = new ToolPermissionService();
    service.initializeSync({ ask: ["Read"], allow: ["Write"] });

    yaml.config = { allow: ["Read"], exclude: ["Write"] };
    await service.reloadPermissions();

    // The first matching policy decides: the flags come first
    expect(firstPolicyFor(service, "Read")).toBe("ask");
    expect(firstPolicyFor(service, "Write")).toBe("allow");
  });

  test("the policies after a reload equal a fresh start with the same flags", async () => {
    const flags = { exclude: ["Bash"], ask: ["Write"], allow: ["Edit"] };
    yaml.config = { allow: ["Read"] };

    const reloaded = new ToolPermissionService();
    reloaded.initializeSync({ ...flags, isHeadless: true });
    await reloaded.reloadPermissions();

    const fresh = new ToolPermissionService();
    fresh.initializeSync({ ...flags, isHeadless: true });

    expect(reloaded.getPermissions().policies).toEqual(
      fresh.getPermissions().policies,
    );
    expect(reloaded.isHeadless()).toBe(true);
  });

  test("a headless Loop worker with the interactive defaults keeps them after a reload", async () => {
    const service = new ToolPermissionService();
    service.initializeSync({ isHeadless: true, interactiveDefaults: true });
    expect(firstPolicyFor(service, "Bash")).toBe("ask");

    yaml.config = { allow: ["Read"] };
    await service.reloadPermissions();

    // The headless default lists would allow Bash; the worker never had them
    expect(firstPolicyFor(service, "Read")).toBe("allow");
    expect(firstPolicyFor(service, "Bash")).toBe("ask");

    const fresh = new ToolPermissionService();
    fresh.initializeSync({ isHeadless: true, interactiveDefaults: true });
    expect(service.getPermissions().policies).toEqual(
      fresh.getPermissions().policies,
    );
  });
});
