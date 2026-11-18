import type { ModelDescription, SessionEnvironment } from "core";
import { readFileTool } from "core/tools/definitions/readFile";
import { runTerminalCommandTool } from "core/tools/definitions/runTerminalCommand";
import { describeExecutionShell } from "core/util/shellDescription";
import { renderEnvironment } from "core/util/environmentPrompt";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { recordDateNotice } from "../thunks/sessionEnvironment";
import { buildChatRequest } from "./buildChatRequest";

const model: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

/** A Windows laptop, Windows PowerShell 5.1, in a repository. */
const SNAPSHOT: SessionEnvironment["snapshot"] = {
  version: 1,
  takenAt: "2026-11-12T08:00:00.000Z",
  localDay: "2026-11-12",
  platform: "win32",
  arch: "x64",
  shell: {
    shell: {
      kind: "powershell",
      source: "spawned",
      label: "Windows PowerShell 5.1",
    },
    executable: "powershell.exe",
    os: { value: "windows", confidence: "known", source: "platform win32" },
  },
  workspace: {
    home: "C:\\Users\\zzcanaryuser",
    user: "zzcanaryuser",
    roots: ["file:///c%3A/Users/zzcanaryuser/code/acme-api"],
  },
  git: { isRepo: true, branch: "feature/login", statusZ: " M src/app.ts\0" },
};

function environmentOf(): SessionEnvironment {
  const d = renderEnvironment(SNAPSHOT, {
    surface: "ide-agent",
    detail: "standard",
  });
  return {
    snapshot: SNAPSHOT,
    detail: "standard",
    strings: {
      systemLine: d.systemLine,
      toolSentence: d.toolSentence,
      firstMessageBlock: d.firstMessageBlock,
    },
  };
}

function stateWith(
  mode: RootState["session"]["mode"],
  environment: SessionEnvironment | null = environmentOf(),
): RootState {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        tools: [readFileTool, runTerminalCommandTool],
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: model,
        },
      },
    },
    session: {
      ...state.session,
      mode,
      environment: environment ?? undefined,
      history: [
        {
          message: { id: "u1", role: "user", content: "fix it" },
          contextItems: [],
        },
        {
          message: { id: "a1", role: "assistant", content: "Looking." },
          contextItems: [],
        },
        {
          message: { id: "u2", role: "user", content: "and the test" },
          contextItems: [],
        },
      ],
    },
  };
}

const env = environmentOf().strings!;

/** A message's text, whether a string or parts. */
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");

describe("the session environment in the IDE request (ENV13, ENV14)", () => {
  it("appends the system line to the system message in every mode, byte for byte the same", () => {
    for (const mode of ["chat", "agent", "plan"] as const) {
      const system = String(
        buildChatRequest(stateWith(mode)).messages[0].content,
      );
      expect(system.endsWith(`\n\n${env.systemLine}`)).toBe(true);
    }
    expect(env.systemLine).toContain("Platform: Windows (win32, x64)");
  });

  it("the terminal tool carries the session's shell sentence and no other", () => {
    const tool = buildChatRequest(stateWith("agent")).activeTools.find(
      (t) => t.function.name === "run_terminal_command",
    )!;
    expect(tool.function.description).toContain(env.toolSentence);
    expect(env.toolSentence).toBe(describeExecutionShell(SNAPSHOT.shell));
    expect(tool.function.description).not.toContain("Choose terminal commands");
    expect(tool.function.description!.split("Runs in ").length).toBe(2);
  });

  it("prepends the first-message block to the first user message only", () => {
    const { messages } = buildChatRequest(stateWith("agent"));
    const users = messages.filter((m) => m.role === "user");
    expect(text(users[0].content)).toBe(`${env.firstMessageBlock}\n\nfix it`);
    expect(text(users[1].content)).toBe("and the test");
  });

  it("the account and the home folder never reach the request", () => {
    const body = JSON.stringify(buildChatRequest(stateWith("agent")));
    expect(body).not.toContain("zzcanaryuser");
    expect(body).toContain("~\\\\code\\\\acme-api");
  });

  it("uses the saved texts, not a new rendering: a resumed session keeps its bytes", () => {
    const saved = environmentOf();
    saved.strings = { ...saved.strings!, firstMessageBlock: "FROZEN BLOCK" };
    const { messages } = buildChatRequest(stateWith("agent", saved));
    expect(text(messages.find((m) => m.role === "user")!.content)).toBe(
      "FROZEN BLOCK\n\nfix it",
    );
  });

  it("without an environment the request is as before", () => {
    const { messages } = buildChatRequest(stateWith("agent", null));
    expect(text(messages.find((m) => m.role === "user")!.content)).toBe(
      "fix it",
    );
    expect(String(messages[0].content)).not.toContain("<env>");
  });
});

describe("the date notice in the IDE request (ENV32)", () => {
  function recordOn(state: RootState, today: string) {
    let current = state;
    const dispatch = ((action: { type: string; payload: unknown }) => {
      if (action.type === "session/setSessionEnvironment") {
        current = {
          ...current,
          session: { ...current.session, environment: action.payload as never },
        };
      }
      return action;
    }) as never;
    const added = recordDateNotice(() => current, dispatch, today);
    return { added, state: current };
  }

  it("is added once on a later day, at the end of the newest user message", () => {
    const { added, state } = recordOn(stateWith("agent"), "2026-11-13");
    expect(added).toBe(true);
    const users = buildChatRequest(state).messages.filter(
      (m) => m.role === "user",
    );
    expect(text(users[1].content)).toBe(
      'and the test\n\n<context name="environment-update">\nToday\'s date is now 2026-11-13 (the session started on 2026-11-12).\n</context>',
    );
    expect(text(users[0].content)).toBe(`${env.firstMessageBlock}\n\nfix it`);
    // The same day again adds nothing, and the notice does not move
    const again = recordOn(state, "2026-11-13");
    expect(again.added).toBe(false);
    expect(again.state.session.environment?.notices).toHaveLength(1);
  });

  it("the same day adds nothing", () => {
    expect(recordOn(stateWith("agent"), "2026-11-12").added).toBe(false);
  });
});
