import fs from "fs";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunBudget } from "../budget/runBudget.js";
import { setActiveRunBudget } from "../budget/runLimits.js";
import { resetLoopMemory } from "../loop/loopSession.js";
import {
  getPolicyLevels,
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { services } from "../services/index.js";
import {
  createSession,
  getSessionLoop,
  updateSessionLoop,
} from "../session.js";
import { savePlan } from "../tools/presentPlan.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
  testModel,
  waitUntil,
} from "../ui/__tests__/TUIChat.flowHarness.js";
import { gracefulExit } from "../util/exit.js";

import type { ServerState } from "./serve.helpers.js";
import { registerMessageRoutes } from "./serve.messages.js";

vi.mock("../util/exit.js", () => ({
  gracefulExit: vi.fn(),
}));

/**
 * A run limit ends the serve process. The loop the session holds is not left
 * "running" in the saved session: it is marked stopped, naming the limit.
 */
describe("cn serve: a run limit reached while a loop is held", () => {
  let cwd: string;
  let server: ReturnType<express.Express["listen"]>;
  let state: ServerState;

  async function start(llm: ScriptedLlm) {
    await registerFlowServices({ llm, mode: "normal" });
    // serve runs headless: nobody can be asked, so "ask" calls are refused
    // unless the loop holds them
    await services.toolPermissions.doInitialize({
      mode: "normal",
      isHeadless: true,
    });
    const session = createSession([]);
    await services.chatHistory.initialize(session, false);
    services.chatHistory.addUserMessage("an earlier chat about something else");
    state = {
      session,
      config: {},
      model: testModel,
      isProcessing: false,
      lastActivity: Date.now(),
      currentAbortController: null,
      serverRunning: true,
      pendingPermission: null,
    };
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, {
      state,
      llmApi: llm.api,
      syncSessionHistory: () => {
        state.session.history = services.chatHistory.getHistory();
      },
      onIdle: async () => {},
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  let base: string;

  beforeEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    updateSessionLoop(undefined);
    resetLoopMemory();
    vi.mocked(gracefulExit).mockClear();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-serve-limit-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(async () => {
    state.serverRunning = false;
    setActiveRunBudget(undefined);
    await new Promise((r) => server?.close(r));
    updateSessionLoop(undefined);
    resetLoopMemory();
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("marks the loop stopped with the limit, then exits with the limit's code", async () => {
    setPolicyLevels({ ...getPolicyLevels(), plan: "manual" });
    await start(new ScriptedLlm([]));
    await savePlan(
      { title: "Two things", plan: "Do them.", todos: ["First", "Second"] },
      cwd,
    );
    // --max-turns 1, already used up: the next check finds the run stopped
    const budget = new RunBudget({
      limits: { maxTurns: 1 },
      model: { provider: "openai", model: "gpt-4o" } as never,
      spentUsd: () => 0,
    });
    budget.beforeCall(10);
    budget.beforeCall(10);
    expect(budget.stop?.reason).toBe("turns");
    setActiveRunBudget(budget);

    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loopAction: "start" }),
    });
    expect(res.status).toBe(200);
    await waitUntil(
      () => vi.mocked(gracefulExit).mock.calls.length > 0,
      "the server to exit on the run limit",
      () => undefined,
    );
    expect(vi.mocked(gracefulExit)).toHaveBeenCalledWith(21);
    const loop = getSessionLoop();
    expect(loop?.status).toBe("stopped");
    expect(loop?.stopReason).toBe("stopped");
    expect(loop?.stopDetail).toContain("A run limit was reached");
    expect(loop?.stopDetail).toBe(
      `A run limit was reached: ${budget.stop!.detail}`,
    );
  });
});
