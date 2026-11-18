import historyManager from "core/util/history.js";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import {
  sessionsRestoreCommand,
  sessionsTrashCommand,
} from "./sessionsTrash.js";

let out: string[] = [];
let err: string[] = [];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

afterEach(() => {
  historyManager.emptyTrash();
  out = [];
  err = [];
});

/** A saved session in the per-worker global folder of the test run. */
function saved(title: string): string {
  const sessionId = uuidv4();
  historyManager.save({
    sessionId,
    title,
    workspaceDirectory: "/code/proj",
    history: [
      { message: { role: "user", content: "hello" }, contextItems: [] },
    ],
  });
  return sessionId;
}

describe("continuous sessions trash / restore", () => {
  it("lists what the picker deleted and restores it", async () => {
    const id = saved("Picker deleted this");
    expect((await historyManager.trash(id)).status).toBe("trashed");

    expect(sessionsTrashCommand({}, io())).toBe(0);
    expect(out.join("\n")).toContain(id);
    expect(out.join("\n")).toContain("Picker deleted this");

    out = [];
    expect(sessionsTrashCommand({ json: true }, io())).toBe(0);
    const listed = JSON.parse(out[0]);
    expect(listed.sessions[0]).toMatchObject({
      id,
      title: "Picker deleted this",
    });

    out = [];
    expect(sessionsRestoreCommand(id, io())).toBe(0);
    expect(out[0]).toContain("Restored");
    expect(historyManager.list({}).some((s) => s.sessionId === id)).toBe(true);
    historyManager.delete(id);
  });

  it("fails for an id that is not in the trash", () => {
    expect(sessionsRestoreCommand(uuidv4(), io())).toBe(1);
    expect(err[0]).toContain("not in the trash");
  });

  it("empties the trash only with --yes", async () => {
    await historyManager.trash(saved("one"));
    expect(sessionsTrashCommand({ empty: true }, io())).toBe(0);
    expect(out[0]).toContain("Dry run");
    expect(historyManager.listTrash()).toHaveLength(1);
    expect(sessionsTrashCommand({ empty: true, yes: true }, io())).toBe(0);
    expect(historyManager.listTrash()).toEqual([]);
  });
});
