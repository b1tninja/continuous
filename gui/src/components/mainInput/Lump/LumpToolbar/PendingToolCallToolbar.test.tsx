import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import {
  EMPTY_CONFIG,
  updateConfig,
} from "../../../../redux/slices/configSlice";
import { newSession } from "../../../../redux/slices/sessionSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";

const call = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    },
    parsedArgs: { filepath: ".env" },
    status: "generated",
    ...extra,
  }) as any;

async function setup(calls: any[]) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<PendingToolCallToolbar />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG }));
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: calls,
          },
        ],
      } as any),
    );
  });
  return view;
}

describe("PendingToolCallToolbar: why it is asking", () => {
  it("shows the reason a protected path or ask rule made the call wait", async () => {
    await setup([
      call("a", {
        policyNote:
          "This touches .env, which can hold credentials, so it always asks first.",
      }),
    ]);
    expect(screen.getByTestId("policy-note-a").textContent).toContain(".env");
  });

  it("shows nothing when there is no note", async () => {
    await setup([call("a")]);
    expect(screen.queryByTestId("policy-note-a")).toBeNull();
  });

  it("shows each call's own note", async () => {
    await setup([
      call("a", { policyNote: "note for a" }),
      call("b"),
      call("c", { policyNote: "note for c" }),
    ]);
    expect(screen.getByTestId("policy-note-a").textContent).toBe("note for a");
    expect(screen.queryByTestId("policy-note-b")).toBeNull();
    expect(screen.getByTestId("policy-note-c").textContent).toBe("note for c");
  });

  it("writes a long note out in full, wrapped, with no cut or hover-only text", async () => {
    const long = "This touches a very long path ".repeat(8).trim();
    await setup([call("a", { policyNote: long })]);
    const note = screen.getByTestId("policy-note-a");
    expect(note.textContent).toBe(long);
    expect(note.getAttribute("title")).toBeNull();
    expect(note.className).not.toContain("truncate");
  });

  it("names the rule next to the note", async () => {
    await setup([
      call("a", { policyNote: "Asks first.", policyRule: "ls(D:/**)" }),
    ]);
    expect(screen.getByTestId("policy-note-a").textContent).toContain(
      "Rule: ls(D:/**)",
    );
  });

  it("says what the call will do, with the exact command", async () => {
    const command = "git log --oneline -n 5 && echo done";
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        parsedArgs: { command, cwd: "D:/work/app" },
      }),
    ]);
    expect(screen.getByTestId("pending-action-kind-a").textContent).toBe(
      "Run terminal command",
    );
    expect(screen.getByTestId("pending-action-block-a").textContent).toBe(
      command,
    );
    expect(screen.getByTestId("pending-action-a").textContent).toContain(
      "D:/work/app",
    );
  });

  it("never shows a secret in a command", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        parsedArgs: {
          command:
            "API_TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 npm run deploy",
        },
      }),
    ]);
    const text = screen.getByTestId("pending-action-block-a").textContent;
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("API_TOKEN");
    expect(text).toContain("npm run deploy");
  });

  it("keeps a long command whole and lets it be opened", async () => {
    const command = Array.from({ length: 30 }, (_, i) => `echo line-${i}`).join(
      " \\\n",
    );
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        parsedArgs: { command },
      }),
    ]);
    expect(screen.getByTestId("pending-action-block-a").textContent).toBe(
      command,
    );
    const toggle = screen.getByTestId("pending-action-toggle-a");
    expect(toggle.textContent).toBe("Show full command");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.textContent).toBe("Show less command");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows no toggle for a short command", async () => {
    await setup([call("a")]);
    expect(screen.queryByTestId("pending-action-toggle-a")).toBeNull();
  });

  it("shows the file an edit targets and its change", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "single_find_and_replace", arguments: "{}" },
        },
        parsedArgs: {
          filepath: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
      }),
    ]);
    expect(screen.getByTestId("pending-action-kind-a").textContent).toBe(
      "Edit file",
    );
    expect(screen.getByTestId("pending-action-a").textContent).toContain(
      "src/app.ts",
    );
    expect(screen.getByTestId("pending-action-block-a").textContent).toBe(
      "- const a = 1;\n+ const a = 2;",
    );
  });

  it("shows a URL in full without its credentials", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "fetch_url_content", arguments: "{}" },
        },
        parsedArgs: { url: "https://user:hunter2@example.com/a/b?x=1" },
      }),
    ]);
    const text = screen.getByTestId("pending-action-a").textContent;
    expect(text).toContain("https://***@example.com/a/b?x=1");
    expect(text).not.toContain("hunter2");
  });

  it("shows the server, tool and arguments of an MCP call", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "github_create_issue", arguments: "{}" },
        },
        tool: {
          group: "github",
          originalFunctionName: "create_issue",
          displayTitle: "create_issue",
        },
        parsedArgs: { repo: "b1tninja/continuous", title: "Hello" },
      }),
    ]);
    expect(screen.getByTestId("pending-action-kind-a").textContent).toBe(
      "Call MCP tool github/create_issue",
    );
    const args = screen.getByTestId("pending-action-block-a").textContent!;
    expect(JSON.parse(args)).toEqual({
      repo: "b1tninja/continuous",
      title: "Hello",
    });
  });

  it("lists the paths a call names", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "grep_search", arguments: "{}" },
        },
        parsedArgs: { query: "TODO", path: "D:/" },
      }),
    ]);
    const paths = screen.getByTestId("pending-action-paths-a");
    expect(paths.textContent).toBe("D:/");
  });

  it("shows each pending call its own action", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        parsedArgs: { command: "npm test" },
      }),
      call("b", {
        toolCall: {
          id: "b",
          type: "function",
          function: { name: "ls", arguments: "{}" },
        },
        parsedArgs: { dirPath: "D:/" },
      }),
    ]);
    expect(screen.getByTestId("pending-action-block-a").textContent).toBe(
      "npm test",
    );
    expect(screen.getByTestId("pending-action-kind-b").textContent).toBe(
      "List directory",
    );
    expect(screen.getByTestId("pending-action-b").textContent).toContain("D:/");
  });

  it("points Accept, Reject and Always allow at the action they apply to", async () => {
    await setup([call("a"), call("b")]);
    for (const id of ["a", "b"]) {
      const target = `pending-action-${id}`;
      expect(document.getElementById(target)).not.toBeNull();
      expect(
        screen
          .getByTestId(`accept-tool-call-button-${id}`)
          .getAttribute("aria-describedby"),
      ).toBe(target);
      expect(
        screen
          .getByTestId(`reject-tool-call-button-${id}`)
          .getAttribute("aria-describedby"),
      ).toBe(target);
    }
  });
  it("offers Accept all only when several calls wait", async () => {
    await setup([call("a")]);
    expect(screen.queryByTestId("accept-all-tool-calls")).toBeNull();
    await setup([call("a"), call("b")]);
    expect(screen.getByTestId("accept-all-tool-calls").textContent).toContain(
      "Accept all (2)",
    );
  });

  it("says that sending a new message cancels what is waiting", async () => {
    await setup([call("a")]);
    expect(
      screen.getByText(/Sending a new message cancels this action/),
    ).toBeTruthy();
  });

  const terminal = (id: string) =>
    call(id, {
      toolCall: {
        id,
        type: "function",
        function: { name: "run_terminal_command", arguments: "{}" },
      },
      parsedArgs: { command: "npm test" },
    });

  it("says command only when every waiting call is a terminal command", async () => {
    await setup([terminal("a"), terminal("b")]);
    expect(
      screen.getByText(/Sending a new message cancels these commands/),
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Approval needed for 2 commands" }),
    ).toBeTruthy();
  });

  it("says action when a file read or an MCP tool waits with a command", async () => {
    await setup([terminal("a"), call("b")]);
    expect(
      screen.getByText(/Sending a new message cancels these actions/),
    ).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Approval needed for 2 actions" }),
    ).toBeTruthy();
    // each pair of buttons names its own call
    expect(screen.getByTestId("accept-tool-call-button-a").title).toBe(
      "Run this command once",
    );
    expect(screen.getByTestId("reject-tool-call-button-a").title).toBe(
      "Reject this command",
    );
    expect(screen.getByTestId("accept-tool-call-button-b").title).toBe(
      "Run this action once",
    );
    expect(screen.getByTestId("reject-tool-call-button-b").title).toBe(
      "Reject this action",
    );
  });

  it("writes out a hidden character in the command and says there is one", async () => {
    await setup([
      call("a", {
        toolCall: {
          id: "a",
          type: "function",
          function: { name: "run_terminal_command", arguments: "{}" },
        },
        parsedArgs: { command: "rm notes‮txt.sh" },
      }),
    ]);
    expect(screen.getByTestId("pending-action-block-a").textContent).toBe(
      "rm notes⟦U+202E⟧txt.sh",
    );
    expect(screen.getByTestId("hidden-characters-a").textContent).toContain(
      "1 hidden character is in this call",
    );
  });

  it("has no hidden-character line for an ordinary call", async () => {
    await setup([terminal("a")]);
    expect(screen.queryByTestId("hidden-characters-a")).toBeNull();
  });

  it("Accept all says how many calls it runs and asks to check each one", async () => {
    await setup([terminal("a"), call("b"), call("c")]);
    expect(screen.getByTestId("accept-all-tool-calls").title).toBe(
      "Run all 3 waiting actions once. Scroll the list to check each one first",
    );
  });
});
