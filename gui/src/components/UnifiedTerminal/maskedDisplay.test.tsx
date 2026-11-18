import { screen } from "@testing-library/react";
import type { SubagentRunState, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { DecisionChip } from "../../pages/gui/ToolCallDiv/DecisionChip";
import { SubagentCard } from "../../pages/gui/ToolCallDiv/SubagentCard";
import { ToolCallStatusMessage } from "../../pages/gui/ToolCallDiv/ToolCallStatusMessage";
import { renderWithProviders } from "../../util/test/render";
import { UnifiedTerminalCommand } from "./UnifiedTerminal";

vi.mock("../../util/subagents/registry", () => ({
  stopSubagentRun: vi.fn(),
  answerSubagentApproval: vi.fn(),
}));

// Fake values only: shaped like secrets, belonging to nobody
const FAKE = "fake-token-value-for-tests";
const COMMAND = `API_KEY=${FAKE} npm test`;
const PS_COMMAND = `$env:GITHUB_TOKEN='${FAKE}'; git push`;

describe("what an approval card shows of a command", () => {
  test("the terminal card shows the name and hides the value", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand command={COMMAND} status="completed" />,
    );
    expect(container.textContent).toContain("API_KEY=");
    expect(container.textContent).toContain("npm test");
    expect(container.textContent).not.toContain(FAKE);
    expect(container.innerHTML).not.toContain(FAKE);
  });

  test("the PowerShell form is masked too", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand command={PS_COMMAND} status="completed" />,
    );
    expect(container.textContent).toContain("GITHUB_TOKEN");
    expect(container.innerHTML).not.toContain(FAKE);
  });

  test("the output is masked as well", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="env"
        output={`HOME=/home/x\nAPI_KEY=${FAKE}\n`}
        status="completed"
      />,
    );
    expect(container.innerHTML).not.toContain(FAKE);
    expect(container.textContent).toContain("API_KEY");
  });

  test("Run sends the real command to the terminal: display is masked, the action is not", async () => {
    const ideMessenger = new MockIdeMessenger();
    const post = vi.spyOn(ideMessenger, "post");
    const { user, container } = await renderWithProviders(
      <UnifiedTerminalCommand command={COMMAND} status="completed" />,
      { mockIdeMessenger: ideMessenger },
    );
    await user.click(screen.getByText("Run"));
    expect(post).toHaveBeenCalledWith("runCommand", { command: COMMAND });
    expect(container.innerHTML).not.toContain(FAKE);
  });

  test("a command with nothing to hide is shown as it is", async () => {
    await renderWithProviders(
      <UnifiedTerminalCommand command="NODE_ENV=test npm test" />,
    );
    expect(screen.getByText("NODE_ENV=test npm test")).toBeInTheDocument();
  });
});

describe("the title and the chip", () => {
  const tool = {
    displayTitle: "Fetch",
    function: { name: "fetch_url_content" },
    wouldLikeTo: "fetch {{{ url }}}",
    isCurrently: "fetching {{{ url }}}",
    hasAlready: "fetched {{{ url }}}",
  } as any;
  const url = `https://example.com/x?access_token=${FAKE}ABCDEFGHIJ`;

  test("the title is rendered from masked arguments", async () => {
    const call = {
      toolCallId: "t1",
      status: "generated",
      parsedArgs: { url: `https://ghp_${"a".repeat(36)}@example.com/x` },
      toolCall: {
        id: "t1",
        type: "function",
        function: { name: "fetch_url_content", arguments: "{}" },
      },
    } as ToolCallState;
    const { container } = await renderWithProviders(
      <ToolCallStatusMessage tool={tool} toolCallState={call} />,
    );
    expect(container.textContent).toContain("example.com");
    expect(container.textContent).not.toContain("ghp_" + "a".repeat(36));
    // the state the tool is called with is the same object, untouched
    expect(call.parsedArgs.url).toContain("ghp_");
    expect(url).toContain(FAKE);
  });

  test("the chip tooltip is masked", async () => {
    await renderWithProviders(
      <DecisionChip
        decision={{
          outcome: "blocked",
          source: "deny-rule",
          reason: `Refused: ${COMMAND}`,
        }}
      />,
    );
    const title = screen.getByTestId("decision-chip").getAttribute("title");
    expect(title).toContain("API_KEY=");
    expect(title).not.toContain(FAKE);
  });
});

describe("the subagent card", () => {
  test("its call summaries, approval and prompt are masked", async () => {
    const run: SubagentRunState = {
      agent: "Explore",
      prompt: `Run ${COMMAND} please`,
      status: "running",
      toolCalls: [
        {
          name: "run_terminal_command",
          summary: COMMAND,
          status: "calling",
        },
      ],
      text: "",
      pendingApproval: {
        id: "a1",
        toolName: "run_terminal_command",
        summary: COMMAND,
        note: `because ${PS_COMMAND}`,
      },
    } as any;
    const call = {
      toolCallId: "c1",
      status: "calling",
      parsedArgs: { agent: "Explore", prompt: run.prompt },
      toolCall: {
        id: "c1",
        type: "function",
        function: { name: BuiltInToolNames.Subagent, arguments: "{}" },
      },
      subagent: run,
    } as ToolCallState;
    const { container, user } = await renderWithProviders(
      <SubagentCard toolCallState={call} />,
    );
    await user.click(screen.getByTestId("subagent-prompt-toggle-c1"));
    expect(container.innerHTML).not.toContain(FAKE);
    expect(container.textContent).toContain("API_KEY=");
    expect(run.toolCalls[0].summary).toContain(FAKE);
  });
});
