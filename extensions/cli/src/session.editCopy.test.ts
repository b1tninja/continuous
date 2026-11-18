import fs from "node:fs";
import path from "node:path";

import type { Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "./env.js";
import {
  BEFORE_EDIT_SUFFIX,
  getCurrentSession,
  keepCopyBeforeEdit,
  loadOrCreateSessionById,
  startNewSession,
} from "./session.js";

// Real files in the test run's own global folder (vitest.global-dir-setup.ts)
const dir = path.join(env.continueHome, "sessions");
const file = (id: string) => path.join(dir, `${id}.json`);

/** Ten messages: five questions, each with its answer. */
function original(): Session {
  const history: Session["history"] = [];
  for (let i = 1; i <= 5; i++) {
    history.push({
      message: { role: "user", content: `question ${i}` },
      contextItems: [],
    });
    history.push({
      message: { role: "assistant", content: `answer ${i}` },
      contextItems: [],
    });
  }
  return {
    sessionId: "original-id",
    title: "Build question",
    workspaceDirectory: "/work/project",
    history,
  };
}

describe("an edit of an earlier message keeps a copy (NI7)", () => {
  const savedTestFlag = process.env.CONTINUE_CLI_TEST;

  beforeEach(() => {
    // session.ts uses another folder when CONTINUE_CLI_TEST and HOME are set
    delete process.env.CONTINUE_CLI_TEST;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file("original-id"), JSON.stringify(original(), null, 2));
    loadOrCreateSessionById("original-id");
  });

  afterEach(() => {
    startNewSession();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  it("editing message 3 of 10 saves all ten as '<title> (before edit)', beside the session", () => {
    const history = original().history;
    const copy = keepCopyBeforeEdit(history);

    expect(copy).toBeDefined();
    expect(copy!.sessionId).not.toBe("original-id");
    expect(copy!.title).toBe(`Build question${BEFORE_EDIT_SUFFIX}`);
    expect(copy!.forkedFrom).toEqual({ sessionId: "original-id" });

    const saved: Session = JSON.parse(
      fs.readFileSync(file(copy!.sessionId), "utf8"),
    );
    expect(saved.title).toBe(`Build question${BEFORE_EDIT_SUFFIX}`);
    expect(saved.history.map((h) => h.message.content)).toEqual(
      history.map((h) => h.message.content),
    );
    // The 7 messages after message 3 are among them
    expect(saved.history.slice(3)).toHaveLength(7);

    // The edit goes on in the session that was open
    expect(getCurrentSession().sessionId).toBe("original-id");
  });

  it("keeps nothing when there is nothing to keep", () => {
    expect(keepCopyBeforeEdit([])).toBeUndefined();
  });
});
