import { Editor, JSONContent } from "@tiptap/core";
import { ContextProviderDescription, ModelDescription } from "core";
import { modelSupportsImages } from "core/llm/autodetect";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IIdeMessenger } from "../../../../context/IdeMessenger";
import { isJetBrains } from "../../../../util";
import { announce } from "../../../a11y/announcer";
import { Mention } from "../extensions";
import { handleImageFile } from "../utils/imageUtils";
import {
  classifyDrop,
  classifyPaste,
  fileItem,
  isHandledDrag,
} from "./classifyDrop";
import {
  checkImages,
  describeDropOutcome,
  DropHost,
  DropOutcome,
  outcomeNeedsNote,
  Refusal,
  RefusalReason,
  resolveResources,
  sanitizeDroppedText,
} from "./resolveDrop";

/** Shown on the drop target in VS Code, where the page only gets the drop with Shift held. */
export const VSCODE_SHIFT_HINT = "In VS Code, hold Shift while dragging.";

export const NOTHING_TO_ADD = "Nothing in this drop can be added.";
export const JETBRAINS_NOT_SUPPORTED =
  "Drag and drop does not add context in JetBrains yet. Use Add context (@) instead.";

/** How long the drop target stays after the drag leaves without Shift. */
const LINGER_MS = 2000;

function hostFor(ideMessenger: IIdeMessenger): DropHost {
  return {
    async getWorkspaceDirs() {
      const result = await ideMessenger.request("getWorkspaceDirs", undefined);
      return result.status === "success" ? result.content : [];
    },
    async listDir(dir: string) {
      const result = await ideMessenger.request("listDir", { dir });
      return result.status === "success"
        ? (result.content as [string, number][])
        : [];
    },
  };
}

function countImages(doc: JSONContent | undefined): number {
  if (!doc) return 0;
  let n = doc.type === "image" ? 1 : 0;
  for (const child of doc.content ?? []) n += countImages(child);
  return n;
}

function mentionQueries(doc: JSONContent | undefined, out = new Set<string>()) {
  if (!doc) return out;
  if (doc.type === Mention.name && typeof doc.attrs?.query === "string") {
    out.add(`${doc.attrs.itemType}:${doc.attrs.query}`);
  }
  for (const child of doc.content ?? []) mentionQueries(child, out);
  return out;
}

export interface UseChatInputDropArgs {
  editor: Editor | null;
  ideMessenger: IIdeMessenger;
  availableContextProviders: ContextProviderDescription[];
  model: ModelDescription | null | undefined;
}

/**
 * Drag and drop, paste and the image picker for the chat input: the drop
 * target state, the items themselves and the one-line result. Handlers go on
 * the input's outer element; drops and pasted files are taken in the capture
 * phase so ProseMirror does not also paste the drag's or clipboard's text
 * (VS Code puts path labels in `text/plain`, a browser an `<img>` tag).
 */
export function useChatInputDrop({
  editor,
  ideMessenger,
  availableContextProviders,
  model,
}: UseChatInputDropArgs) {
  const [dragActive, setDragActive] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLinger = () => {
    if (lingerTimer.current) {
      clearTimeout(lingerTimer.current);
      lingerTimer.current = null;
    }
  };
  useEffect(() => clearLinger, []);

  const onDragEnterOrOver = useCallback(
    (e: React.DragEvent) => {
      if (editor?.view.dragging) return; // a move inside the editor
      if (!isHandledDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      clearLinger();
      setDragActive(true);
    },
    [editor],
  );

  const onDragLeave = useCallback((e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as Node).contains(next)) return;
    clearLinger();
    if (e.shiftKey) {
      setDragActive(false);
    } else {
      // VS Code takes pointer events away from the page mid-drag unless
      // Shift is held; keep the hint up long enough to read.
      lingerTimer.current = setTimeout(() => setDragActive(false), LINGER_MS);
    }
  }, []);

  const finish = useCallback((outcome: DropOutcome | null, empty: boolean) => {
    const text = empty
      ? isJetBrains()
        ? JETBRAINS_NOT_SUPPORTED
        : NOTHING_TO_ADD
      : describeDropOutcome(outcome!);
    announce(text);
    setNote(empty || outcomeNeedsNote(outcome!) ? text : null);
  }, []);

  const handleItems = useCallback(
    async (items: ReturnType<typeof classifyDrop<File>>) => {
      if (!editor || editor.isDestroyed) return;
      if (items.length === 0) {
        finish(null, true);
        return;
      }
      const refusals: Refusal[] = [];
      const outcome: DropOutcome = {
        files: 0,
        folders: [],
        images: 0,
        text: false,
        links: 0,
        hiddenRemoved: 0,
        refusals,
      };

      for (const item of items) {
        if (item.kind === "unsupported") {
          refusals.push({
            name: item.name,
            reason: (item.reason ?? "unknown-type") as RefusalReason,
          });
        }
      }

      // Resources: checked by name and workspace before the host is asked
      // anything about them; never read here.
      const providers = {
        file: availableContextProviders.some((p) => p.title === "file"),
        folder: availableContextProviders.some((p) => p.title === "folder"),
      };
      const resolved = await resolveResources(
        items,
        hostFor(ideMessenger),
        providers,
      );
      refusals.push(...resolved.refusals);

      // Images go through the existing image path, after the caps.
      const visionSupported =
        !!model &&
        modelSupportsImages(
          model.provider,
          model.model,
          model.title,
          model.capabilities,
        );
      const images = checkImages(items, {
        visionSupported,
        imagesAlreadyInMessage: countImages(editor.getJSON()),
      });
      refusals.push(...images.refusals);

      const content: JSONContent[] = [];
      const already = mentionQueries(editor.getJSON());
      for (const m of resolved.mentions) {
        const key = `${m.kind}:${m.uri}`;
        if (!already.has(key)) {
          already.add(key);
          content.push(
            {
              type: Mention.name,
              attrs: {
                id: m.uri,
                label: m.name,
                query: m.uri,
                itemType: m.kind,
              },
            },
            { type: "text", text: " " },
          );
        }
        if (m.kind === "folder") outcome.folders.push(m.name);
        else outcome.files++;
      }

      for (const item of items) {
        if (item.kind === "url" && item.uri) {
          // A link is added as text: nothing is fetched on drop.
          content.push({ type: "text", text: `${item.uri} ` });
          outcome.links++;
        } else if (item.kind === "text" && item.text) {
          const clean = sanitizeDroppedText(item.text);
          outcome.hiddenRemoved += clean.removed;
          if (clean.text) {
            content.push({ type: "text", text: clean.text });
            outcome.text = true;
          }
        }
      }

      if (content.length && !editor.isDestroyed) {
        editor.chain().focus().insertContent(content).run();
      }

      // Decoded together, then inserted at the cursor in one step and in the
      // order given (inserting one by one would put each over the last, which
      // is the selection after an insert). One the browser cannot decode is
      // named instead of vanishing.
      const decoded = await Promise.all(
        images.accepted.map((file) =>
          handleImageFile(ideMessenger, file).catch(() => undefined),
        ),
      );
      const imageNodes: JSONContent[] = [];
      decoded.forEach((result, i) => {
        if (!result) {
          refusals.push({
            name: images.accepted[i].name,
            reason: "unreadable-image",
          });
          return;
        }
        imageNodes.push({ type: "image", attrs: { src: result[1] } });
      });
      if (imageNodes.length && !editor.isDestroyed) {
        editor.chain().focus().insertContent(imageNodes).run();
        outcome.images = imageNodes.length;
      }

      finish(outcome, false);
    },
    [editor, ideMessenger, availableContextProviders, model, finish],
  );

  const onDropCapture = useCallback(
    (e: React.DragEvent) => {
      if (editor?.view.dragging) return; // let ProseMirror move its own nodes
      clearLinger();
      setDragActive(false);
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      // The drag data is readable only during the event, so classify now.
      const items = classifyDrop<File>(e.dataTransfer);
      void handleItems(items);
    },
    [editor, handleItems],
  );

  /**
   * A pasted screenshot or image. Text pastes, and a paste whose text was
   * meant (Office puts a picture of the copy next to it), are left to the
   * editor.
   */
  const onPasteCapture = useCallback(
    (e: React.ClipboardEvent) => {
      if (!e.clipboardData) return;
      // The clipboard is readable only during the event, so classify now.
      const items = classifyPaste<File>(e.clipboardData);
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void handleItems(items);
    },
    [handleItems],
  );

  /** Images chosen with the attach menu: the same checks and result line. */
  const addImageFiles = useCallback(
    (files: File[]) => handleItems(files.map((f) => fileItem(f))),
    [handleItems],
  );

  return {
    dragActive,
    hint: isJetBrains() ? null : VSCODE_SHIFT_HINT,
    note,
    dismissNote: () => setNote(null),
    addImageFiles,
    handlers: {
      onDragEnter: onDragEnterOrOver,
      onDragOver: onDragEnterOrOver,
      onDragLeave,
      onDropCapture,
      onPasteCapture,
    },
  };
}
