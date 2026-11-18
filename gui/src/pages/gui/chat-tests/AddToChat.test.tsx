import { act, waitFor } from "@testing-library/react";
import { JSONContent } from "@tiptap/core";
import { AddToChatPayload } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnnouncement,
  resetAnnouncer,
} from "../../../components/a11y/announcer";
import { updateConfig } from "../../../redux/slices/configSlice";
import { renderWithProviders } from "../../../util/test/render";
import { getMainEditor } from "../../../util/test/utils";
import { Chat } from "../Chat";

function mentions(doc: JSONContent | undefined, out: any[] = []) {
  if (!doc) return out;
  if (doc.type === "mention") out.push(doc.attrs);
  for (const child of doc.content ?? []) mentions(child, out);
  return out;
}

async function setup(providers: string[] = ["file", "folder"]) {
  // Focusing the editor scrolls the selection into view; jsdom has no scrollBy.
  window.scrollBy = vi.fn();
  const rendered = await renderWithProviders(<Chat />);
  const { store } = rendered;
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        contextProviders: providers.map((title) => ({
          title,
          displayTitle: title,
          description: "",
          type: "submenu",
        })),
      }),
    );
  });
  const editor = await getMainEditor();
  const post = vi.spyOn(rendered.ideMessenger, "post");
  return { ...rendered, editor, post };
}

async function send(
  ideMessenger: Awaited<ReturnType<typeof setup>>["ideMessenger"],
  payload: AddToChatPayload,
) {
  await act(async () => {
    ideMessenger.mockMessageToWebview("addToChat", payload);
  });
}

const fileA = {
  type: "file" as const,
  fullPath: "file:///ws/a.ts",
  name: "a.ts",
};
const folderLib = {
  type: "folder" as const,
  fullPath: "file:///ws/lib",
  name: "lib",
};

describe("addToChat from the Explorer and tab menus", () => {
  afterEach(() => resetAnnouncer());

  it("inserts @file and @folder chips, focuses the input and announces once", async () => {
    const { ideMessenger, editor, post } = await setup();
    const seqBefore = getAnnouncement("polite").seq;

    await send(ideMessenger, { data: [fileA, folderLib] });

    await waitFor(() =>
      expect(mentions(editor.getJSON())).toEqual([
        {
          id: "file:///ws/a.ts",
          label: "a.ts",
          query: "file:///ws/a.ts",
          itemType: "file",
          renderInlineAs: null,
        },
        {
          id: "file:///ws/lib",
          label: "lib",
          query: "file:///ws/lib",
          itemType: "folder",
          renderInlineAs: null,
        },
      ]),
    );
    expect(editor.isFocused).toBe(true);
    expect(getAnnouncement("polite")).toEqual({
      text: "Added 1 file and 1 folder to the chat input.",
      seq: seqBefore + 1,
    });
    expect(post).not.toHaveBeenCalledWith("showToast", expect.anything());
  });

  it("does not insert a chip twice", async () => {
    const { ideMessenger, editor } = await setup();
    await send(ideMessenger, { data: [fileA] });
    await send(ideMessenger, { data: [fileA] });
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toBe(
        "1 item was already in the message.",
      ),
    );
    expect(mentions(editor.getJSON())).toHaveLength(1);
  });

  it("shows and announces the host's refusals and inserts nothing for them", async () => {
    const { ideMessenger, editor, post } = await setup();
    await send(ideMessenger, {
      data: [fileA],
      refused: [{ name: ".env", reason: "secret" }],
    });
    const refusal =
      ".env looks like it holds secrets or keys, so it was not added.";
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toBe(
        `Added 1 file to the chat input. ${refusal}`,
      ),
    );
    expect(mentions(editor.getJSON()).map((m) => m.label)).toEqual(["a.ts"]);
    expect(JSON.stringify(editor.getJSON())).not.toContain(".env");
    expect(post).toHaveBeenCalledWith("showToast", ["warning", refusal]);
  });

  it("refuses a folder when the folder provider is not configured", async () => {
    const { ideMessenger, editor, post } = await setup(["file"]);
    await send(ideMessenger, { data: [folderLib] });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("showToast", [
        "warning",
        "lib was not added: its context provider is not available in this configuration.",
      ]),
    );
    expect(mentions(editor.getJSON())).toEqual([]);
  });
});
