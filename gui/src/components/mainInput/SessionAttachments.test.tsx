import { act, screen } from "@testing-library/react";
import type { ChatHistoryItem, ContextItemWithId } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ATTACHMENTS_VISIBLE, SessionAttachments } from "./SessionAttachments";

const file = (path: string, content: string): ContextItemWithId => ({
  id: { providerTitle: "file", itemId: path },
  name: path.split("/").pop()!,
  description: path,
  content,
  uri: { type: "file", value: `file:///w/${path}` },
});
const user = (text: string, items: ContextItemWithId[]): ChatHistoryItem => ({
  message: { role: "user", content: text },
  contextItems: items,
});

async function render(messages: ChatHistoryItem[]) {
  // Each message gets a reply: loading a session drops a final unanswered one
  const history = messages.flatMap((m) => [
    m,
    {
      message: { role: "assistant" as const, content: "ok" },
      contextItems: [],
    },
  ]);
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  store.dispatch(
    newSession({
      sessionId: "s",
      title: "t",
      workspaceDirectory: "",
      history,
    } as any),
  );
  const opened: string[] = [];
  ideMessenger.ide.openFile = async (uri: string) => {
    opened.push(uri);
  };
  const rendered = await renderWithProviders(<SessionAttachments />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return { ...rendered, opened };
}

describe("SessionAttachments", () => {
  it("lists each attached file once, with how often it was sent", async () => {
    await render([
      user("1", [file("src/a.ts", "x".repeat(400))]),
      user("2", [file("src/a.ts", "x".repeat(400))]),
    ]);
    const rows = screen.getAllByTestId("session-attachment");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("a.ts");
    expect(rows[0].textContent).toContain("attached 2 times");
    expect(rows[0].textContent).toContain(
      "1 sent as a note, not again in full",
    );
    expect(screen.getByTestId("session-attachments").textContent).toContain(
      "Attached in this session (1)",
    );
  });

  it("opens the file when its name is clicked", async () => {
    const { user: u, opened } = await render([
      user("1", [file("src/a.ts", "x")]),
    ]);
    await act(async () => {
      await u.click(screen.getByText("a.ts"));
    });
    expect(opened).toEqual(["file:///w/src/a.ts"]);
  });

  it("shows the newest first, a few at a time", async () => {
    const files = Array.from({ length: ATTACHMENTS_VISIBLE + 2 }, (_, i) =>
      file(`f${i}.ts`, `content ${i}`),
    );
    const { user: u } = await render(files.map((f, i) => user(String(i), [f])));
    expect(screen.getAllByTestId("session-attachment")).toHaveLength(
      ATTACHMENTS_VISIBLE,
    );
    expect(
      screen.getAllByTestId("session-attachment")[0].textContent,
    ).toContain(`f${ATTACHMENTS_VISIBLE + 1}.ts`);
    await act(async () => {
      await u.click(screen.getByTestId("session-attachments-toggle"));
    });
    expect(screen.getAllByTestId("session-attachment")).toHaveLength(
      ATTACHMENTS_VISIBLE + 2,
    );
  });

  it("shows nothing when nothing was attached", async () => {
    await render([user("hi", [])]);
    expect(screen.queryByTestId("session-attachments")).toBeNull();
  });
});
