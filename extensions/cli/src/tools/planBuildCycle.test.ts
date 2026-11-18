import { describe, expect, it, vi } from "vitest";

// A static import of plans/planBuild from tools/taskList once made the
// built-in tool lists evaluate with taskListTool undefined, which broke every
// model-backed run ("Cannot read properties of undefined (reading 'name')").
describe("tools/index and plans/planBuild import order", () => {
  const check = async () => {
    const { ALL_BUILT_IN_TOOLS } = await import("./allBuiltIns.js");
    const { getToolDisplayName } = await import("./index.js");
    expect(ALL_BUILT_IN_TOOLS.length).toBeGreaterThan(0);
    for (const t of ALL_BUILT_IN_TOOLS) {
      expect(t).toBeDefined();
      expect(typeof t.name).toBe("string");
    }
    expect(getToolDisplayName("Read")).toBe("Read");
  };

  it("tools first, then planBuild", async () => {
    vi.resetModules();
    await import("./index.js");
    await import("../plans/planBuild.js");
    await check();
  });

  it("planBuild first, then tools", async () => {
    vi.resetModules();
    await import("../plans/planBuild.js");
    await check();
  });

  it("taskList first", async () => {
    vi.resetModules();
    const { taskListTool } = await import("./taskList.js");
    expect(taskListTool.name).toBeDefined();
    await check();
  });

  it("streamChatResponse.helpers first", async () => {
    vi.resetModules();
    await import("../stream/streamChatResponse.helpers.js");
    await check();
  });
});
