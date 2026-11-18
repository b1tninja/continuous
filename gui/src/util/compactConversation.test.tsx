import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setupStore } from "../redux/store";
import { renderWithProviders } from "./test/render";
import { useCompactConversation } from "./compactConversation";

let result: boolean | undefined;

function CompactButton() {
  const compact = useCompactConversation();
  return (
    <button
      onClick={() => {
        void compact(0).then((r) => {
          result = r;
        });
      }}
    >
      compact
    </button>
  );
}

async function setup(
  answer: { status: "success" } | { status: "error"; error: string },
) {
  result = undefined;
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const posts: [string, unknown][] = [];
  const realPost = ideMessenger.post.bind(ideMessenger);
  ideMessenger.post = ((type: string, data: unknown) => {
    posts.push([type, data]);
    return realPost(type as any, data as any);
  }) as typeof ideMessenger.post;
  const realRequest = ideMessenger.request.bind(ideMessenger);
  const compactCalls: unknown[] = [];
  ideMessenger.request = (async (type: any, data: any) => {
    if (type === "conversation/compact") {
      compactCalls.push(data);
      return answer.status === "success"
        ? { status: "success", content: undefined, done: true }
        : { status: "error", error: answer.error, done: true };
    }
    return realRequest(type, data);
  }) as typeof ideMessenger.request;
  const rendered = await renderWithProviders(<CompactButton />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return { ...rendered, posts, compactCalls };
}

describe("useCompactConversation", () => {
  // A failed compaction used to reload the unchanged session and say
  // nothing, so "Compact now" looked like it had no effect
  it("says why when compacting fails, and reports failure", async () => {
    const { user, posts, compactCalls } = await setup({
      status: "error",
      error: "prompt is too long: 1067710 tokens > 1000000 maximum",
    });
    await act(async () => {
      await user.click(screen.getByText("compact"));
    });
    await vi.waitFor(() => expect(result).toBe(false));
    expect(compactCalls).toHaveLength(1);
    const toast = posts.find(([type]) => type === "showToast");
    expect(toast).toBeDefined();
    expect(String((toast![1] as unknown[])[1])).toContain(
      "Compacting failed, so the conversation was not changed",
    );
    expect(String((toast![1] as unknown[])[1])).toContain("prompt is too long");
  });

  it("reports success and shows no error when compacting works", async () => {
    const { user, posts } = await setup({ status: "success" });
    await act(async () => {
      await user.click(screen.getByText("compact"));
    });
    await vi.waitFor(() => expect(result).toBe(true));
    expect(posts.some(([type]) => type === "showToast")).toBe(false);
  });
});
