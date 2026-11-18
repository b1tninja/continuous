import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { JSONContent } from "@tiptap/core";
import { ContextProviderDescription, ModelDescription } from "core";
import { canarySecrets } from "core/util/secretScan/canary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { Chat } from "../../../../pages/gui/Chat";
import { triggerConfigUpdate } from "../../../../util/test/config";
import { renderWithProviders } from "../../../../util/test/render";
import { getMainEditor } from "../../../../util/test/utils";
import { getAnnouncement, resetAnnouncer } from "../../../a11y/announcer";
import { FileLike } from "./classifyDrop";
import {
  editorTabDrag,
  explorerDrag,
  fakeDataTransfer,
  fakeDirEntry,
  fakeFile,
  osEntryDrag,
  osFileDrag,
  textDrag,
  textFile,
} from "./dropFixtures";
import { SNAPSHOT_DESCRIPTION, SNAPSHOT_PROVIDER } from "./osSnapshot";
import { JETBRAINS_NOT_SUPPORTED, VSCODE_SHIFT_HINT } from "./useChatInputDrop";

// jsdom cannot decode images, so the image step is replaced: a file named
// "broken..." fails to decode, any other becomes a data URL naming it.
vi.mock("../utils/imageUtils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/imageUtils")>();
  return {
    ...actual,
    handleImageFile: vi.fn(async (_messenger: unknown, file: File) =>
      file.name.startsWith("broken")
        ? undefined
        : ([{} as HTMLImageElement, `data:${file.type};name=${file.name}`] as [
            HTMLImageElement,
            string,
          ]),
    ),
  };
});

// The mock IDE's first workspace folder.
const WS = "file:///Users/user/workspace1";

const providers: ContextProviderDescription[] = [
  {
    title: "file",
    displayTitle: "Files",
    description: "Type to search",
    type: "submenu",
  },
  {
    title: "folder",
    displayTitle: "Folder",
    description: "Type to search",
    type: "submenu",
  },
];

const textModel: ModelDescription = {
  model: "mock",
  provider: "mock",
  title: "Mock LLM",
  underlyingProviderName: "mock",
};

const visionModel: ModelDescription = {
  model: "gpt-4o",
  provider: "openai",
  title: "Vision",
  underlyingProviderName: "openai",
  capabilities: { uploadImage: true },
};

const tree: Record<string, [string, number][]> = {
  [WS]: [
    ["src", 2],
    ["README.md", 1],
    [".env", 1],
  ],
  [`${WS}/src`]: [["a.ts", 1]],
};

async function setup(model: ModelDescription = textModel) {
  const mockIdeMessenger = new MockIdeMessenger();
  // Answers for the JetBrains start-up requests, used by the JetBrains test.
  mockIdeMessenger.responses["jetbrains/isOSREnabled"] = true;
  mockIdeMessenger.responses["jetbrains/getColors"] = {};
  mockIdeMessenger.responses["jetbrains/onLoad"] = {
    windowId: "w",
    serverUrl: "",
    workspacePaths: [],
    vscMachineId: "",
    vscMediaUrl: "",
  };
  const rendered = await renderWithProviders(<Chat />, { mockIdeMessenger });
  const { ideMessenger, store } = rendered;
  const requests: [string, unknown][] = [];
  const original = ideMessenger.request.bind(ideMessenger);
  ideMessenger.request = (async (type: any, data: any) => {
    requests.push([type, data]);
    return original(type, data);
  }) as typeof ideMessenger.request;
  ideMessenger.responseHandlers.listDir = async ({ dir }) => tree[dir] ?? [];
  await act(async () => {
    triggerConfigUpdate({
      store,
      ideMessenger,
      editConfig(current) {
        current.contextProviders = providers;
        current.modelsByRole.chat.push(model);
        current.selectedModelByRole.chat = model;
        return current;
      },
    });
  });
  const editor = await getMainEditor();
  const target = await screen.findByTestId("editor-input-main");
  return { ...rendered, editor, target, requests };
}

function snapshotItems(doc: JSONContent): Record<string, any>[] {
  return (doc.content ?? [])
    .filter(
      (n) =>
        n.type === "code-block" &&
        n.attrs?.item?.id?.providerTitle === SNAPSHOT_PROVIDER,
    )
    .map((n) => n.attrs!.item);
}

function mentions(doc: JSONContent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "mention") out.push(n.attrs ?? {});
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

async function drop(target: HTMLElement, dataTransfer: unknown) {
  await act(async () => {
    fireEvent.drop(target, { dataTransfer });
  });
}

/** A paste event's clipboard, as Chromium hands it over. */
function clipboard(data: Record<string, string>, files: FileLike[] = []) {
  return {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    getData: (format: string) => data[format] ?? "",
    items: files.map((f) => ({
      kind: "file",
      type: f.type,
      getAsFile: () => f,
    })),
    files,
  };
}

async function paste(target: HTMLElement, clipboardData: unknown) {
  await act(async () => {
    fireEvent.paste(target, { clipboardData });
  });
}

function imageSources(doc: JSONContent): string[] {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "image") out.push(String(n.attrs?.src));
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

beforeEach(() => {
  resetAnnouncer();
  localStorage.removeItem("ide");
});

afterEach(() => {
  localStorage.removeItem("ide");
});

describe("dropping on the chat input", () => {
  it("shows the drop target with the Shift hint while dragging, and hides it on drop", async () => {
    const { target } = await setup();
    expect(screen.queryByTestId("chat-drop-target")).toBeNull();
    fireEvent.dragEnter(target, {
      dataTransfer: fakeDataTransfer({ ResourceURLs: "[]" }),
    });
    const overlay = await screen.findByTestId("chat-drop-target");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveTextContent("Drop to add context");
    expect(overlay).toHaveTextContent(VSCODE_SHIFT_HINT);
    await drop(target, explorerDrag([`${WS}/src/a.ts`]));
    expect(screen.queryByTestId("chat-drop-target")).toBeNull();
  });

  it("does not show the drop target for a drag it cannot use", async () => {
    const { target } = await setup();
    fireEvent.dragOver(target, {
      dataTransfer: fakeDataTransfer({ "application/x-custom": "x" }),
    });
    expect(screen.queryByTestId("chat-drop-target")).toBeNull();
  });

  it("inserts @file and @folder chips for Explorer files and folders, announced once", async () => {
    const { target, editor } = await setup();
    await drop(
      target,
      explorerDrag([`${WS}/src/a.ts`, `${WS}/README.md`], [`${WS}/src`]),
    );
    await waitFor(() => expect(mentions(editor.getJSON())).toHaveLength(3));
    expect(mentions(editor.getJSON())).toEqual([
      expect.objectContaining({
        itemType: "folder",
        query: `${WS}/src`,
        label: "src",
      }),
      expect.objectContaining({
        itemType: "file",
        query: `${WS}/src/a.ts`,
        id: `${WS}/src/a.ts`,
        label: "a.ts",
      }),
      expect.objectContaining({ itemType: "file", label: "README.md" }),
    ]);
    // The Explorer's path labels in text/plain were not pasted.
    expect(editor.getText()).not.toContain("README.md\n");
    expect(getAnnouncement("polite")).toEqual({
      text: "Added 2 files, folder src as a search scope.",
      seq: 1,
    });
    // The folder needs a word: it is a search scope, not its contents.
    expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
      "search scope",
    );
  });

  it("does not add the same file twice", async () => {
    const { target, editor } = await setup();
    await drop(target, editorTabDrag(`${WS}/src/a.ts`));
    await waitFor(() => expect(mentions(editor.getJSON())).toHaveLength(1));
    await drop(target, editorTabDrag(`${WS}/src/a.ts#L2`));
    await waitFor(() => expect(getAnnouncement("polite").seq).toBe(2));
    expect(mentions(editor.getJSON())).toHaveLength(1);
  });

  it("refuses a credential file with the reason and never reads it", async () => {
    const { target, editor, requests } = await setup();
    await drop(target, explorerDrag([`${WS}/.env`]));
    await waitFor(() => expect(getAnnouncement("polite").seq).toBe(1));
    expect(mentions(editor.getJSON())).toEqual([]);
    const notice = screen.getByTestId("chat-drop-notice");
    expect(notice).toHaveTextContent(
      "Not added: .env looks like it holds secrets or keys.",
    );
    // No request read the file, listed it by name or fetched it as context.
    const touchedFile = requests.filter(
      ([type, data]) =>
        type === "readFile" ||
        type === "readRangeInFile" ||
        type === "context/getContextItems" ||
        type === "fileExists" ||
        type === "getFileStats" ||
        JSON.stringify(data ?? "").includes(".env"),
    );
    expect(touchedFile).toEqual([]);
  });

  it("refuses files outside the workspace", async () => {
    const { target, editor } = await setup();
    await drop(target, explorerDrag(["file:///tmp/elsewhere/notes.md"]));
    await waitFor(() =>
      expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
        "notes.md is outside the workspace",
      ),
    );
    expect(mentions(editor.getJSON())).toEqual([]);
  });

  it("says when the model does not read images", async () => {
    const { target, editor } = await setup(textModel);
    await drop(target, osFileDrag(fakeFile("shot.png", "image/png")));
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toBe(
        "Not added: shot.png: the selected model does not read images.",
      ),
    );
    expect(editor.getJSON().content?.some((n) => n.type === "image")).toBe(
      false,
    );
  });

  it("accepts an image for a vision model and refuses one over 5 MB", async () => {
    const { target } = await setup(visionModel);
    await drop(
      target,
      osFileDrag(
        fakeFile("small.png", "image/png", 2000),
        fakeFile("huge.png", "image/png", 6 * 1024 * 1024),
      ),
    );
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toBe(
        "Added 1 image. Not added: huge.png is larger than 5 MB.",
      ),
    );
  });

  it("adds a text file from the operating system as a snapshot chip with a badge", async () => {
    const { target, editor } = await setup();
    await drop(
      target,
      osFileDrag(textFile("notes.txt", "first line​\nsecond line\n")),
    );
    await waitFor(() =>
      expect(snapshotItems(editor.getJSON())).toHaveLength(1),
    );
    expect(snapshotItems(editor.getJSON())[0]).toEqual(
      expect.objectContaining({
        name: "notes.txt",
        description: SNAPSHOT_DESCRIPTION,
        content: "first line\nsecond line\n",
      }),
    );
    expect(snapshotItems(editor.getJSON())[0].uri).toBeUndefined();
    const text =
      "Added 1 file from outside the editor as a snapshot (not kept in sync). Removed 1 hidden character.";
    expect(getAnnouncement("polite")).toEqual({ text, seq: 1 });
    expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(text);
    const badge = await screen.findByTestId("snapshot-badge");
    expect(badge).toHaveTextContent("snapshot, not kept in sync with the file");
    expect(badge).toHaveAttribute(
      "title",
      expect.stringContaining("not kept in sync"),
    );
  });

  it("refuses a dropped file that holds a secret, and the secret goes nowhere", async () => {
    const { target, editor, requests } = await setup();
    const { githubToken } = canarySecrets();
    await drop(
      target,
      osFileDrag(textFile("notes.txt", `push with ${githubToken}\n`)),
    );
    await waitFor(() => expect(getAnnouncement("polite").seq).toBe(1));
    expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
      "notes.txt contains what looks like a secret",
    );
    expect(snapshotItems(editor.getJSON())).toEqual([]);
    expect(JSON.stringify(editor.getJSON())).not.toContain(githubToken);
    expect(JSON.stringify(requests)).not.toContain(githubToken);
    expect(getAnnouncement("polite").text).not.toContain(githubToken);
  });

  it("refuses a binary OS file, naming why", async () => {
    const { target, editor } = await setup();
    await drop(
      target,
      osFileDrag(textFile("tool.exe", new Uint8Array([0x4d, 0x5a, 0, 0]))),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
        "tool.exe looks like a binary file",
      ),
    );
    expect(snapshotItems(editor.getJSON())).toEqual([]);
  });

  it("adds a folder from the operating system as a bundle of snapshots with a summary", async () => {
    const { target, editor } = await setup();
    const folder = fakeDirEntry("notes", {
      "a.md": "alpha",
      "b.md": "beta",
      ".env": "KEY=1",
      node_modules: { "x.js": "x" },
    });
    await drop(target, osEntryDrag([[fakeFile("notes", "", 0), folder]]));
    await waitFor(() =>
      expect(snapshotItems(editor.getJSON())).toHaveLength(2),
    );
    expect(snapshotItems(editor.getJSON()).map((i) => i.name)).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(getAnnouncement("polite").text).toBe(
      "Added 2 files from folder notes as snapshots (not kept in sync). " +
        "From notes, left out 1 file that may hold secrets (by name or content), " +
        "1 folder not opened (node_modules, .git, dist or a secrets folder).",
    );
    expect(screen.getAllByTestId("snapshot-badge")).toHaveLength(2);
  });

  it("inserts dropped text without hidden characters", async () => {
    const { target, editor } = await setup();
    await drop(target, textDrag("run‮ this​"));
    await waitFor(() => expect(editor.getText()).toContain("run this"));
    expect(editor.getText()).not.toMatch(/[‮​]/);
    expect(getAnnouncement("polite").text).toBe(
      "Added the dropped text. Removed 2 hidden characters.",
    );
  });

  it("adds a dropped link as text and fetches nothing", async () => {
    const { target, editor, requests } = await setup();
    await drop(
      target,
      fakeDataTransfer({ "text/uri-list": "https://example.com/a" }),
    );
    await waitFor(() =>
      expect(editor.getText()).toContain("https://example.com/a"),
    );
    expect(requests.map(([t]) => t)).not.toContain("context/getContextItems");
  });

  it("says drag and drop is not supported in JetBrains when nothing arrives", async () => {
    localStorage.setItem("ide", JSON.stringify("jetbrains"));
    const { target } = await setup();
    await drop(target, fakeDataTransfer({}));
    await waitFor(() =>
      expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
        JETBRAINS_NOT_SUPPORTED,
      ),
    );
    // And the drop target has no VS Code hint there.
    fireEvent.dragEnter(target, {
      dataTransfer: fakeDataTransfer({ "text/plain": "x" }),
    });
    expect(await screen.findByTestId("chat-drop-target")).not.toHaveTextContent(
      "Shift",
    );
  });

  it("dismisses the note", async () => {
    const { target } = await setup();
    await drop(target, explorerDrag([`${WS}/.env`]));
    const dismiss = await screen.findByRole("button", {
      name: "Dismiss drop result",
    });
    fireEvent.click(dismiss);
    expect(screen.queryByTestId("chat-drop-notice")).toBeNull();
  });

  it("does not create a live region of its own", async () => {
    const { target } = await setup();
    await drop(target, explorerDrag([`${WS}/.env`]));
    const notice = await screen.findByTestId("chat-drop-notice");
    expect(notice.closest("[aria-live],[role=status],[role=alert]")).toBeNull();
  });
});

describe("pasting into the chat input", () => {
  it("adds a pasted screenshot for a vision model", async () => {
    const { target, editor } = await setup(visionModel);
    await paste(target, clipboard({}, [fakeFile("image.png", "image/png")]));
    await waitFor(() =>
      expect(imageSources(editor.getJSON())).toEqual([
        "data:image/png;name=image.png",
      ]),
    );
    expect(getAnnouncement("polite").text).toBe("Added 1 image.");
    // A plain success needs no note: the image itself shows it.
    expect(screen.queryByTestId("chat-drop-notice")).toBeNull();
  });

  it("keeps several pasted images in order", async () => {
    const { target, editor } = await setup(visionModel);
    await paste(
      target,
      clipboard({}, [
        fakeFile("first.png", "image/png"),
        fakeFile("second.jpg", "image/jpeg"),
      ]),
    );
    await waitFor(() =>
      expect(imageSources(editor.getJSON())).toEqual([
        "data:image/png;name=first.png",
        "data:image/jpeg;name=second.jpg",
      ]),
    );
  });

  it("inserts the image where the cursor is, not at the start", async () => {
    const { target, editor } = await setup(visionModel);
    await act(async () => {
      editor.commands.setContent("before");
      editor.commands.focus("end");
    });
    await paste(target, clipboard({}, [fakeFile("image.png", "image/png")]));
    await waitFor(() => expect(imageSources(editor.getJSON())).toHaveLength(1));
    const types = (editor.getJSON().content ?? []).map((n) => n.type);
    expect(types.indexOf("paragraph")).toBeLessThan(types.indexOf("image"));
    expect(editor.getText()).toContain("before");
  });

  it("says when the model does not read images, and adds nothing", async () => {
    const { target, editor } = await setup(textModel);
    await paste(target, clipboard({}, [fakeFile("image.png", "image/png")]));
    await waitFor(() =>
      expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
        "image.png: the selected model does not read images",
      ),
    );
    expect(imageSources(editor.getJSON())).toEqual([]);
  });

  it("names an image that cannot be decoded instead of dropping it silently", async () => {
    const { target, editor } = await setup(visionModel);
    await paste(
      target,
      clipboard({}, [
        fakeFile("broken.png", "image/png"),
        fakeFile("fine.png", "image/png"),
      ]),
    );
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toBe(
        "Added 1 image. Not added: broken.png could not be read as an image.",
      ),
    );
    expect(imageSources(editor.getJSON())).toEqual([
      "data:image/png;name=fine.png",
    ]);
  });

  it("refuses an image over 5 MB with the reason", async () => {
    const { target, editor } = await setup(visionModel);
    await paste(
      target,
      clipboard({}, [fakeFile("huge.png", "image/png", 6 * 1024 * 1024)]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-drop-notice")).toHaveTextContent(
        "huge.png is larger than 5 MB",
      ),
    );
    expect(imageSources(editor.getJSON())).toEqual([]);
  });

  it("leaves a text paste with a picture of it (Office) to the editor", async () => {
    const { target, editor } = await setup(visionModel);
    await paste(
      target,
      clipboard({ "text/plain": "Q3 revenue" }, [
        fakeFile("image.png", "image/png"),
      ]),
    );
    expect(imageSources(editor.getJSON())).toEqual([]);
    expect(getAnnouncement("polite").seq).toBe(0);
  });

  it("adds an image chosen with the attach menu at the cursor, with the same checks", async () => {
    const { editor } = await setup(visionModel);
    await act(async () => {
      editor.commands.setContent("look at this");
      editor.commands.focus("end");
    });
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await act(async () => {
      fireEvent.change(input!, {
        target: {
          files: [
            fakeFile("pick.png", "image/png"),
            fakeFile("logo.svg", "image/svg+xml"),
          ],
        },
      });
    });
    await waitFor(() =>
      expect(imageSources(editor.getJSON())).toEqual([
        "data:image/png;name=pick.png",
      ]),
    );
    // It went after the text, where the cursor was
    const types = (editor.getJSON().content ?? []).map((n) => n.type);
    expect(types.indexOf("paragraph")).toBeLessThan(types.indexOf("image"));
    // The SVG was refused with the drop's reason rather than vanishing
    await waitFor(() =>
      expect(getAnnouncement("polite").text).toContain("logo.svg is an SVG"),
    );
  });
});

vi.setConfig({ testTimeout: 20000 });
