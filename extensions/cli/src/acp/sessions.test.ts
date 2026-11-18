import fs from "node:fs";
import path from "node:path";

import type { ChatHistoryItem, Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "../env.js";
import {
  isSessionInWorkspace,
  listSavedSessions,
  openSavedSession,
} from "../session.js";
import { resetUserNotices, setUserNoticeSink } from "../util/userNotice.js";

import { AcpAgent, ACP_RESOURCE_NOT_FOUND, type AcpBackend } from "./agent.js";
import { JsonRpcPeer } from "./rpc.js";
import {
  decodeCursor,
  sessionCwd,
  sessionListPage,
  type StoredSession,
} from "./sessions.js";

/** An editor on the other end of a JSON-RPC pipe, collecting updates. */
function connect(backend: AcpBackend) {
  const updates: any[] = [];
  const log: string[] = [];
  const client: JsonRpcPeer = new JsonRpcPeer((line) => agentPeer.feed(line));
  const agentPeer = new JsonRpcPeer((line) => client.feed(line));
  client.onNotification("session/update", (p) => {
    log.push(`update:${p.update.sessionUpdate}`);
    updates.push(p);
  });
  new AcpAgent(agentPeer, backend, {
    name: "continuous",
    title: "Continuous",
    version: "0.0.0",
  });
  const call = async (method: string, params: unknown) => {
    try {
      const result = await client.request(method, params);
      log.push(`answer:${method}`);
      return { result };
    } catch (error: any) {
      log.push(`error:${method}`);
      return { error };
    }
  };
  return { call, updates, log };
}

const abs = (...parts: string[]) => path.resolve("/acp-test", ...parts);

function backendOf(
  stored: StoredSession[],
  histories: Record<string, ChatHistoryItem[]> = {},
): AcpBackend & { opened: Array<[string, string]> } {
  const opened: Array<[string, string]> = [];
  return {
    opened,
    newSession: async () => "fresh",
    listSessions: async () => stored,
    inWorkspace: (dir, cwd) => isSessionInWorkspace(dir, cwd),
    openSession: async (id, cwd) => {
      opened.push([id, cwd]);
      return histories[id];
    },
    runTurn: async (_id, _text, cb) => {
      cb.onContent?.("again");
    },
    resolvePermission: () => {},
  };
}

const stored = (
  sessionId: string,
  workspaceDirectory: string,
  updatedAt: string,
  title = `Title ${sessionId}`,
): StoredSession => ({ sessionId, workspaceDirectory, updatedAt, title });

const history: ChatHistoryItem[] = [
  {
    message: { role: "system", content: "You are an agent" },
    contextItems: [],
  },
  { message: { role: "user", content: "read the file" }, contextItems: [] },
  {
    message: {
      role: "assistant",
      content: "Reading it.",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "c1",
        toolCall: {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
        status: "done",
        parsedArgs: { filepath: abs("p", "a.ts") },
        output: [{ name: "a.ts", description: "", content: "export {}" }],
      },
      {
        toolCallId: "c2",
        toolCall: {
          id: "c2",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        status: "errored",
        parsedArgs: { command: "npm test" },
        output: [{ name: "error", description: "", content: "exit 1" }],
      },
    ],
  },
  {
    message: { role: "tool", content: "export {}", toolCallId: "c1" },
    contextItems: [],
  },
  {
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    contextItems: [],
  },
];

describe("ACP session/list", () => {
  it("advertises list, resume and loadSession, and answers v1 to a v2 client", async () => {
    const { call } = connect(backendOf([]));
    const res = await call("initialize", { protocolVersion: 2 });
    expect(res.result.protocolVersion).toBe(1);
    expect(res.result.agentCapabilities.loadSession).toBe(true);
    expect(res.result.agentCapabilities.sessionCapabilities.list).toEqual({});
    expect(res.result.agentCapabilities.sessionCapabilities.resume).toEqual({});
  });

  it("lists newest first with cwd, title and updatedAt", async () => {
    const { call } = connect(
      backendOf([
        stored("old", abs("work", "p"), "2026-01-01T00:00:00.000Z"),
        stored("new", abs("work", "q"), "2026-03-01T00:00:00.000Z"),
        stored("mid", abs("work", "p"), "2026-02-01T00:00:00.000Z"),
        // No folder: SessionInfo.cwd is required, so it is not listed
        stored("nowhere", "", "2026-04-01T00:00:00.000Z"),
      ]),
    );
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/list", {});
    expect(res.result).toEqual({
      sessions: [
        {
          sessionId: "new",
          cwd: abs("work", "q"),
          title: "Title new",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
        {
          sessionId: "mid",
          cwd: abs("work", "p"),
          title: "Title mid",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          sessionId: "old",
          cwd: abs("work", "p"),
          title: "Title old",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("filters by cwd as this workspace: the folder and folders inside it", async () => {
    const { call } = connect(
      backendOf([
        stored("here", abs("work", "repo", "p"), "2026-01-01T00:00:00.000Z"),
        stored(
          "inside",
          abs("work", "repo", "p", "src"),
          "2026-01-02T00:00:00.000Z",
        ),
        stored("other", abs("work", "repo", "q"), "2026-01-03T00:00:00.000Z"),
      ]),
    );
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/list", {
      cwd: abs("work", "repo", "p"),
    });
    expect(res.result.sessions.map((s: any) => s.sessionId)).toEqual([
      "inside",
      "here",
    ]);
    const none = await call("session/list", { cwd: abs("elsewhere") });
    expect(none.result).toEqual({ sessions: [] });
  });

  it("refuses a relative cwd and a cursor it did not make", async () => {
    const { call } = connect(backendOf([]));
    await call("initialize", { protocolVersion: 1 });
    expect((await call("session/list", { cwd: "rel" })).error.code).toBe(
      -32602,
    );
    expect(
      (await call("session/list", { cursor: "not-a-cursor" })).error.code,
    ).toBe(-32602);
  });

  it("pages with an opaque cursor and no nextCursor on the last page", () => {
    const all = Array.from({ length: 5 }, (_, i) =>
      stored(`s${i}`, abs("w", "p"), `2026-01-0${i + 1}T00:00:00.000Z`),
    );
    const inWorkspace = () => true;
    const first = sessionListPage(all, { pageSize: 2, inWorkspace })!;
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["s4", "s3"]);
    expect(decodeCursor(first.nextCursor!)).toBeDefined();
    const second = sessionListPage(all, {
      pageSize: 2,
      cursor: first.nextCursor,
      inWorkspace,
    })!;
    expect(second.sessions.map((s) => s.sessionId)).toEqual(["s2", "s1"]);
    // A session saved between the two requests does not shift the next page
    const grown = [
      ...all,
      stored("s9", abs("w", "p"), "2026-02-01T00:00:00.000Z"),
    ];
    const last = sessionListPage(grown, {
      pageSize: 2,
      cursor: second.nextCursor,
      inWorkspace,
    })!;
    expect(last.sessions.map((s) => s.sessionId)).toEqual(["s0"]);
    expect(last.nextCursor).toBeUndefined();
  });

  it("gives an IDE session's file URI as a path and skips remote folders", () => {
    expect(sessionCwd("vscode-remote://ssh-remote+box/home/me/p")).toBe(
      undefined,
    );
    expect(sessionCwd("relative/dir")).toBe(undefined);
    if (process.platform === "win32") {
      expect(sessionCwd("file:///c%3A/repo/p")).toBe("c:\\repo\\p");
    } else {
      expect(sessionCwd("file:///home/me/p")).toBe("/home/me/p");
    }
  });
});

describe("ACP session/load and session/resume", () => {
  it("replays messages and tool calls in order, then answers", async () => {
    const backend = backendOf([], { s1: history });
    const { call, updates, log } = connect(backend);
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/load", {
      sessionId: "s1",
      cwd: abs("p"),
      mcpServers: [],
    });
    expect(res.result).toEqual({});
    expect(backend.opened).toEqual([["s1", abs("p")]]);
    expect(updates.every((u) => u.sessionId === "s1")).toBe(true);
    const kinds = updates.map((u) => u.update.sessionUpdate);
    expect(kinds).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call",
      "agent_message_chunk",
    ]);
    // Every update arrived before the answer
    expect(log.slice(log.indexOf("answer:initialize") + 1)).toEqual([
      ...kinds.map((k) => `update:${k}`),
      "answer:session/load",
    ]);
    const [user, reply, read, run, done] = updates.map((u) => u.update);
    expect(user.content).toEqual({ type: "text", text: "read the file" });
    expect(reply.content).toEqual({ type: "text", text: "Reading it." });
    expect(user.messageId).not.toBe(reply.messageId);
    expect(read).toMatchObject({
      toolCallId: "call_1",
      kind: "read",
      status: "completed",
      locations: [{ path: abs("p", "a.ts") }],
      content: [
        { type: "content", content: { type: "text", text: "export {}" } },
      ],
    });
    expect(run).toMatchObject({
      toolCallId: "call_2",
      title: "run_terminal_command: npm test",
      kind: "execute",
      status: "failed",
    });
    expect(done.content).toEqual({ type: "text", text: "Done." });
  });

  it("continues the loaded session with session/prompt", async () => {
    const { call, updates } = connect(backendOf([], { s1: history }));
    await call("initialize", { protocolVersion: 1 });
    await call("session/load", {
      sessionId: "s1",
      cwd: abs("p"),
      mcpServers: [],
    });
    updates.length = 0;
    const res = await call("session/prompt", {
      sessionId: "s1",
      prompt: [{ type: "text", text: "more" }],
    });
    expect(res.result).toEqual({ stopReason: "end_turn" });
    expect(updates.map((u) => u.update.content?.text)).toEqual(["again"]);
  });

  it("resumes without replaying anything", async () => {
    const { call, updates } = connect(backendOf([], { s1: history }));
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/resume", {
      sessionId: "s1",
      cwd: abs("p"),
    });
    expect(res.result).toEqual({});
    expect(updates).toEqual([]);
  });

  it("answers an unknown id with resource not found and holds no session", async () => {
    const { call } = connect(backendOf([]));
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/load", {
      sessionId: "missing",
      cwd: abs("p"),
      mcpServers: [],
    });
    expect(res.error.code).toBe(ACP_RESOURCE_NOT_FOUND);
    // The process is still free for a new conversation
    const fresh = await call("session/new", { cwd: abs("p"), mcpServers: [] });
    expect(fresh.result.sessionId).toBe("fresh");
  });

  it("refuses a second session in the process", async () => {
    const { call } = connect(backendOf([], { s1: history }));
    await call("initialize", { protocolVersion: 1 });
    await call("session/new", { cwd: abs("p"), mcpServers: [] });
    const res = await call("session/load", {
      sessionId: "s1",
      cwd: abs("p"),
      mcpServers: [],
    });
    expect(res.error.code).toBe(-32600);
  });
});

describe("saved sessions on disk", () => {
  // Real files in the test run's own global folder (vitest.global-dir-setup.ts)
  const dir = path.join(env.continueHome, "sessions");
  const savedTestFlag = process.env.CONTINUE_CLI_TEST;
  const project = abs("disk", "project");

  beforeEach(() => {
    // session.ts uses another folder when CONTINUE_CLI_TEST and HOME are set
    delete process.env.CONTINUE_CLI_TEST;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    resetUserNotices();
    setUserNoticeSink(() => {});
  });

  afterEach(() => {
    resetUserNotices();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  function writeJson(id: string, mtime: Date) {
    const session: Session = {
      sessionId: id,
      title: "From the CLI",
      workspaceDirectory: project,
      history: history.filter((item) => item.message.role !== "system"),
    };
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(session));
    fs.utimesSync(file, mtime, mtime);
  }

  function writeJsonl(id: string, mtime: Date) {
    const lines = [
      { t: "header", format: "continuous-session", v: 1, sessionId: id },
      { t: "meta", k: "title", v: "From the IDE" },
      { t: "meta", k: "workspaceDirectory", v: project },
      {
        t: "item",
        i: 0,
        v: { message: { role: "user", content: "hello" }, contextItems: [] },
      },
      {
        t: "item",
        i: 1,
        v: { message: { role: "assistant", content: "hi" }, contextItems: [] },
      },
    ];
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    fs.utimesSync(file, mtime, mtime);
  }

  /** The real file reading, without the services a turn needs. */
  const diskBackend = (): AcpBackend => ({
    ...backendOf([]),
    listSessions: async () => listSavedSessions(),
    openSession: async (id) => openSavedSession(id)?.history,
  });

  it("lists and loads a .json and a .jsonl session", async () => {
    writeJson("cli-session", new Date("2026-01-01T00:00:00.000Z"));
    writeJsonl("ide-session", new Date("2026-01-02T00:00:00.000Z"));
    const { call, updates } = connect(diskBackend());
    await call("initialize", { protocolVersion: 1 });

    const list = await call("session/list", { cwd: project });
    expect(list.result.sessions).toEqual([
      {
        sessionId: "ide-session",
        cwd: project,
        title: "From the IDE",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        sessionId: "cli-session",
        cwd: project,
        title: "From the CLI",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const ide = await call("session/load", {
      sessionId: "ide-session",
      cwd: project,
      mcpServers: [],
    });
    expect(ide.result).toEqual({});
    expect(updates.map((u) => u.update.content?.text)).toEqual(["hello", "hi"]);
  });

  it("loads a .json session with its tool calls", async () => {
    writeJson("cli-session", new Date("2026-01-01T00:00:00.000Z"));
    const { call, updates } = connect(diskBackend());
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/load", {
      sessionId: "cli-session",
      cwd: project,
      mcpServers: [],
    });
    expect(res.result).toEqual({});
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call",
      "agent_message_chunk",
    ]);
  });

  it("does not take an id with a path in it for a session", async () => {
    writeJson("cli-session", new Date("2026-01-01T00:00:00.000Z"));
    const { call } = connect(diskBackend());
    await call("initialize", { protocolVersion: 1 });
    const res = await call("session/load", {
      sessionId: `../sessions/cli-session`,
      cwd: project,
      mcpServers: [],
    });
    expect(res.error.code).toBe(ACP_RESOURCE_NOT_FOUND);
  });
});
