import fs from "fs";
import os from "os";
import path from "path";

import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, describe, expect, it } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import {
  approvalExtras,
  getPolicyLevels,
  resetPolicyLevels,
} from "../permissions/policyLevels.js";
import { ToolPermissionService } from "../services/ToolPermissionService.js";

import {
  applyLoopWorkerPolicy,
  loopWorkerPermissionOverrides,
} from "./loopWorker.js";

describe("loop worker permissions", () => {
  afterEach(() => {
    resetPolicyLevels();
  });

  it("does not start in auto mode, and keeps the parent's excludes", () => {
    expect(
      loopWorkerPermissionOverrides({
        mode: "auto",
        exclude: ["Bash"],
        allow: ["Read"],
      }),
    ).toEqual({
      allow: ["Read"],
      ask: undefined,
      exclude: ["Bash"],
      mode: "normal",
    });
    expect(loopWorkerPermissionOverrides({ mode: "plan" }).mode).toBe("plan");
    expect(loopWorkerPermissionOverrides(undefined).mode).toBe("normal");
  });

  it("loads the floor from the settings file and then the parent's levels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-worker-policy-"));
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(
      file,
      "levels:\n  tools: permissive\nfloor:\n  - runTerminalCommand(git push*)\n",
    );
    applyLoopWorkerPolicy(
      {
        levels: { ...DEFAULT_POLICY_LEVELS, tools: "manual" },
      },
      file,
    );
    expect(getPolicyLevels().tools).toBe("manual");
    expect(approvalExtras().floor).toEqual(["runTerminalCommand(git push*)"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("the default lists follow the parent, not the worker's own headless start", () => {
    /** The worker's tool service, started as runLoopItemHere starts it. */
    const workerService = (parentHeadless?: boolean) =>
      new ToolPermissionService().initializeSync({
        ...loopWorkerPermissionOverrides(
          parentHeadless === undefined ? undefined : { parentHeadless },
        ),
        isHeadless: true,
      });
    const decide = (
      state: ReturnType<typeof workerService>,
      name: string,
      args: Record<string, unknown> = {},
    ) =>
      checkToolPermission({ name, arguments: args }, state.permissions)
        .permission;

    it("a terminal-UI parent: Bash and an unlisted tool ask in the worker, as in the parent", () => {
      expect(loopWorkerPermissionOverrides({ parentHeadless: false })).toEqual(
        expect.objectContaining({ interactiveDefaults: true }),
      );
      const worker = workerService(false);
      const parent = new ToolPermissionService().initializeSync({
        isHeadless: false,
      });
      expect(worker.isHeadless).toBe(true);
      for (const [tool, args] of [
        ["Bash", { command: "npm test" }],
        ["some_mcp_tool", {}],
        ["Write", {}],
        ["Read", {}],
      ] as const) {
        expect(decide(worker, tool, args)).toBe(decide(parent, tool, args));
      }
      expect(decide(worker, "Bash", { command: "npm test" })).toBe("ask");
      expect(decide(worker, "some_mcp_tool")).toBe("ask");
    });

    it("a headless parent (-p, serve) keeps the headless lists, unchanged", () => {
      expect(
        loopWorkerPermissionOverrides({ parentHeadless: true }),
      ).not.toHaveProperty("interactiveDefaults");
      const worker = workerService(true);
      const parent = new ToolPermissionService().initializeSync({
        isHeadless: true,
      });
      expect(decide(worker, "Bash", { command: "npm test" })).toBe(
        decide(parent, "Bash", { command: "npm test" }),
      );
    });

    it("an older parent that sends no policy: as before", () => {
      expect(loopWorkerPermissionOverrides(undefined)).not.toHaveProperty(
        "interactiveDefaults",
      );
    });

    it("the parent's own flags still come first", () => {
      const worker = new ToolPermissionService().initializeSync({
        ...loopWorkerPermissionOverrides({
          parentHeadless: false,
          allow: ["Bash"],
        }),
        isHeadless: true,
      });
      expect(
        checkToolPermission(
          { name: "Bash", arguments: { command: "npm test" } },
          worker.permissions,
        ).permission,
      ).toBe("allow");
    });
  });
});
