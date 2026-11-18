import { beforeEach, describe, expect, it } from "vitest";

import { nextWorkerAgent, resetWorkerIdentities } from "./workerIdentity.js";

describe("a Loop worker's identity", () => {
  beforeEach(resetWorkerIdentities);

  it("is worker-<item> in the agent mode, a child of the session's main agent", () => {
    expect(nextWorkerAgent("s1", "3")).toEqual({
      id: "worker-3",
      kind: "loop-worker",
      role: "item 3",
      mode: "agent",
      toolRole: "agent",
      parentId: "main-s1",
    });
  });

  it("gives a second run of the same item its own id, so the map shows it", () => {
    nextWorkerAgent("s1", "3");
    expect(nextWorkerAgent("s1", "3").id).toBe("worker-3~2");
    expect(nextWorkerAgent("s1", "3").id).toBe("worker-3~3");
    expect(nextWorkerAgent("s1", "4").id).toBe("worker-4");
  });
});
