import { Editor, JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEditor } from "@tiptap/react";
import { InputModifiers } from "core";
import { MutableRefObject, useRef } from "react";
import { IIdeMessenger } from "../../../../context/IdeMessenger";
import { useSubmenuContextProviders } from "../../../../context/SubmenuContextProviders";
import { useInputHistory } from "../../../../hooks/useInputHistory";
import useUpdatingRef from "../../../../hooks/useUpdatingRef";
import { useAppSelector } from "../../../../redux/hooks";
import { selectUseActiveFile } from "../../../../redux/selectors";
import { AppDispatch } from "../../../../redux/store";
import { exitEdit } from "../../../../redux/thunks/edit";
import { askToStopResponse } from "../../../../redux/thunks/interruptConfirm";
import { getFontSize, isJetBrains } from "../../../../util";
import { CodeBlock, Mention, PromptBlock, SlashCommand } from "../extensions";
import { TipTapEditorProps } from "../TipTapEditor";
import {
  getContextProviderDropdownOptions,
  getSlashCommandDropdownOptions,
} from "./getSuggestion";

export function getPlaceholderText(
  placeholder: TipTapEditorProps["placeholder"],
  historyLength: number,
) {
  if (placeholder) {
    return placeholder;
  }

  return historyLength === 0
    ? "Ask anything, '@' to add context"
    : "Ask a follow-up";
}

/** True when the document holds an image anywhere. */
function containsImage(node: JSONContent): boolean {
  return node.type === Image.name || (node.content ?? []).some(containsImage);
}

/**
 * Checks if the editor content is valid for submission.
 * A valid submission can contain text, prompt or code blocks, or an image
 * (a pasted screenshot with no question is a message too).
 *
 * @param json The editor JSON content
 * @returns true if the content is valid for submission, false otherwise
 */
export function hasValidEditorContent(json: JSONContent): boolean {
  // Check for prompt or code blocks
  const hasPromptOrCodeBlock = json.content?.some(
    (c) => c.type === PromptBlock.name || c.type === CodeBlock.name,
  );

  // Check for non-whitespace text content
  const hasNonWhitespaceText = json.content?.some((c) =>
    c.content?.some((child) => {
      if (child.type === "text" && child.text) {
        return child.text.trim().length > 0;
      }
      // Mentions and other non-text nodes are valid content
      if (child.type === "mention") {
        return true;
      }
      return false;
    }),
  );

  // Content is valid if it has non-whitespace text, special blocks or images
  return hasNonWhitespaceText || hasPromptOrCodeBlock || containsImage(json);
}

/**
 * This function is called only once, so we need to use refs to pass in the latest values
 */
export function createEditorConfig(options: {
  props: TipTapEditorProps;
  ideMessenger: IIdeMessenger;
  dispatch: AppDispatch;
  /** Called after a message is submitted, so its saved draft can go */
  onSubmittedRef?: MutableRefObject<(() => void) | undefined>;
}) {
  const { props, ideMessenger, dispatch, onSubmittedRef } = options;

  const { getSubmenuContextItems } = useSubmenuContextProviders();
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const useActiveFile = useAppSelector(selectUseActiveFile);
  const historyLength = useAppSelector((store) => store.session.history.length);
  const codeToEdit = useAppSelector((store) => store.editModeState.codeToEdit);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const isInEditRef = useUpdatingRef(isInEdit);

  const inSubmenuRef = useRef<string | undefined>(undefined);
  const inDropdownRef = useRef(false);
  const isStreamingRef = useUpdatingRef(isStreaming);
  const getSubmenuContextItemsRef = useUpdatingRef(getSubmenuContextItems);
  const availableContextProvidersRef = useUpdatingRef(
    props.availableContextProviders,
  );
  const historyLengthRef = useUpdatingRef(historyLength);
  const availableSlashCommandsRef = useUpdatingRef(
    props.availableSlashCommands,
  );
  const { prevRef, nextRef, addRef } = useInputHistory(props.historyKey);
  const placeholderTextRef = useRef(
    getPlaceholderText(props.placeholder, historyLengthRef.current),
  );

  const enterSubmenu = async (editor: Editor, providerId: string) => {
    const contents = editor.getText();
    const indexOfAt = contents.lastIndexOf("@");
    if (indexOfAt === -1) {
      return;
    }

    // Find the position of the last @ character
    // We do this because editor.getText() isn't a correct representation including node views
    let startPos = editor.state.selection.anchor;
    while (
      startPos > 0 &&
      editor.state.doc.textBetween(startPos, startPos + 1) !== "@"
    ) {
      startPos--;
    }
    startPos++;

    editor.commands.deleteRange({
      from: startPos,
      to: editor.state.selection.anchor,
    });
    inSubmenuRef.current = providerId;

    // to trigger refresh of suggestions
    editor.commands.insertContent(":");
    editor.commands.deleteRange({
      from: editor.state.selection.anchor - 1,
      to: editor.state.selection.anchor,
    });
  };

  const onClose = () => {
    inSubmenuRef.current = undefined;
    inDropdownRef.current = false;
  };

  const onOpen = () => {
    inDropdownRef.current = true;
  };

  const editor: Editor | null = useEditor({
    extensions: [
      Document,
      UndoRedo,
      Image.extend({
        addProseMirrorPlugins() {
          // Pasted images are taken by useChatInputDrop (the same checks and
          // result line as a drop), before ProseMirror sees the paste.
          const selectionPlugin = new Plugin({
            props: {
              decorations(state) {
                const { selection, doc } = state;
                const decorations: Decoration[] = [];

                if (selection.empty) {
                  return DecorationSet.empty;
                }

                // create custom highlighting for image when selected
                doc.nodesBetween(selection.from, selection.to, (node, pos) => {
                  if (node.type.name === "image") {
                    decorations.push(
                      Decoration.node(pos, pos + node.nodeSize, {
                        class: "selected-image",
                      }),
                    );
                  }
                });

                return DecorationSet.create(doc, decorations);
              },
            },
          });

          return [selectionPlugin];
        },
      }).configure({
        HTMLAttributes: {
          class: "object-contain max-h-[210px] max-w-full mx-1",
        },
      }),
      Placeholder.configure({
        // Read lazily so TipTapEditor can change the text after creation.
        // Tiptap 3 returns a fresh `options` object from extensions, so
        // mutating the extension's options no longer reaches the plugin.
        placeholder: () => placeholderTextRef.current,
      }),
      Paragraph.extend({
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              if (inDropdownRef.current) {
                return false;
              }

              onEnter({
                useCodebase: false,
                noContext: !useActiveFile,
              });
              return true;
            },

            "Mod-Enter": () => {
              onEnter({
                useCodebase: false,
                noContext: !!useActiveFile,
              });

              return true;
            },
            "Alt-Enter": () => {
              onEnter({
                useCodebase: false,
                noContext: !!useActiveFile,
              });

              return true;
            },
            "Shift-Enter": () =>
              this.editor.commands.first(({ commands }) => [
                () => commands.newlineInCode(),
                () => commands.createParagraphNear(),
                () => commands.liftEmptyBlock(),
                () => commands.splitBlock(),
              ]),

            "Mod-a": () => {
              // override cmd/ctrl+a to include all text and images selection
              this.editor.commands.setTextSelection({
                from: 0,
                to: this.editor.state.doc.content.size,
              });
              return true;
            },

            ArrowUp: () => {
              if (this.editor.state.selection.anchor > 1) {
                return false;
              }

              const previousInput = prevRef.current(
                this.editor.state.toJSON().doc,
              );
              if (previousInput) {
                this.editor.commands.setContent(previousInput, {
                  emitUpdate: false,
                });
                setTimeout(() => {
                  this.editor.commands.blur();
                  this.editor.commands.focus("start");
                }, 0);
                return true;
              }
              return false;
            },
            Escape: () => {
              if (inDropdownRef.current) {
                return false;
              }
              // The stop key (NI8): Esc on an empty main input while the
              // reply streams asks "Stop the response?" (Enter stops, Esc
              // keeps going); it never stops on its own. With text typed,
              // Esc does what it always did.
              if (
                props.isMainInput &&
                isStreamingRef.current &&
                this.editor.isEmpty
              ) {
                void dispatch(askToStopResponse());
                return true;
              }
              // In JetBrains, this is how we close the sidebar when the input box is focused
              if (isJetBrains()) {
                ideMessenger.post("closeSidebar", undefined);
                return true;
              }

              if (isInEditRef.current) {
                void dispatch(
                  exitEdit({
                    openNewSession: false,
                  }),
                );
              }
              ideMessenger.post("focusEditor", undefined);

              return true;
            },
            ArrowDown: () => {
              if (
                this.editor.state.selection.anchor <
                this.editor.state.doc.content.size - 1
              ) {
                return false;
              }
              const nextInput = nextRef.current();
              if (nextInput) {
                this.editor.commands.setContent(nextInput, {
                  emitUpdate: false,
                });
                setTimeout(() => {
                  this.editor.commands.blur();
                  this.editor.commands.focus("end");
                }, 0);
                return true;
              }
              return false;
            },
          };
        },
      }).configure({
        HTMLAttributes: {
          class: "my-1",
        },
      }),
      Text,
      Mention.configure({
        suggestion: getContextProviderDropdownOptions(
          availableContextProvidersRef,
          getSubmenuContextItemsRef,
          enterSubmenu,
          onClose,
          onOpen,
          inSubmenuRef,
          ideMessenger,
        ),
      }),
      SlashCommand.configure({
        suggestion: getSlashCommandDropdownOptions(
          availableSlashCommandsRef,
          onClose,
          onOpen,
          ideMessenger,
          dispatch,
          props.inputId,
        ),
      }),
      PromptBlock,
      CodeBlock,
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message",
        "data-testid": props.isMainInput
          ? "editor-input-main"
          : `editor-input-${props.inputId}`,
        class: "ProseMirror outline-none overflow-hidden wrap-anywhere",
        style: `font-size: ${getFontSize()}px;`,
      },
    },
    content: props.editorState,
    editable: !isStreaming || props.isMainInput,
    // Tiptap 3 stopped re-rendering on every transaction by default. Keep the
    // tiptap 2 behaviour: components read editor state during render.
    shouldRerenderOnTransaction: true,
    immediatelyRender: true,
  });

  const onEnter = (modifiers: InputModifiers) => {
    if (!editor) {
      return;
    }
    // While the agent works, the main input queues its message (see
    // Chat.sendInput); inputs of earlier messages cannot be resubmitted
    if (
      (isStreamingRef.current && !props.isMainInput) ||
      (codeToEdit.length === 0 && isInEdit)
    ) {
      return;
    }

    const json = editor.getJSON();

    // Don't do anything if input box doesn't have valid content
    if (!hasValidEditorContent(json)) {
      return;
    }

    if (props.isMainInput) {
      addRef.current(json);
    }

    props.onEnter(json, modifiers, editor);
    onSubmittedRef?.current?.();
  };

  return { editor, onEnter, placeholderTextRef };
}
