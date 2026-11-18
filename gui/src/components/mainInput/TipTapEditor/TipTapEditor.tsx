import { Editor, EditorContent, JSONContent } from "@tiptap/react";
import { ContextProviderDescription, InputModifiers } from "core";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import useIsOSREnabled from "../../../hooks/useIsOSREnabled";
import useUpdatingRef from "../../../hooks/useUpdatingRef";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import InputToolbar, { ToolbarOptions } from "../InputToolbar";
import { AttachMenu } from "../InputToolbar/AttachMenu";
import { ComboBoxItem } from "../types";
import { MAIN_DRAFT_INPUT } from "../../../util/drafts";
import { DragOverlay } from "./components/DragOverlay";
import { DraftRestoredNotice } from "./components/DraftRestoredNotice";
import { InputBoxDiv } from "./components/StyledComponents";
import { DropNotice } from "./drop/DropNotice";
import { useChatInputDrop } from "./drop/useChatInputDrop";
import { useMainEditor } from "./MainEditorProvider";
import "./TipTapEditor.css";
import { useDraftPersistence } from "./useDraftPersistence";
import { useDropSessionLoadOnTyping } from "./useDropSessionLoadOnTyping";
import { createEditorConfig, getPlaceholderText } from "./utils/editorConfig";
import { useEditorEventHandlers } from "./utils/keyHandlers";

export interface TipTapEditorProps {
  availableContextProviders: ContextProviderDescription[];
  availableSlashCommands: ComboBoxItem[];
  isMainInput: boolean;
  onEnter: (
    editorState: JSONContent,
    modifiers: InputModifiers,
    editor: Editor,
  ) => void;
  editorState?: JSONContent;
  toolbarOptions?: ToolbarOptions;
  placeholder?: string;
  historyKey: string;

  // TODO: This isn't actually used anywhere in this component, but it appears
  // to be pulled into some of our TipTap extensions.
  inputId: string;
}

export const TIPPY_DIV_ID = "tippy-js-div";

function TipTapEditorInner(props: TipTapEditorProps) {
  const dispatch = useAppDispatch();
  const mainEditorContext = useMainEditor();

  const ideMessenger = useContext(IdeMessengerContext);
  const isOSREnabled = useIsOSREnabled();

  const defaultModel = useAppSelector(selectSelectedChatModel);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const historyLength = useAppSelector((store) => store.session.history.length);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const sessionId = useAppSelector((store) => store.session.id);
  const onSubmittedRef = useRef<(() => void) | undefined>(undefined);

  const { editor, onEnter, placeholderTextRef } = createEditorConfig({
    props,
    ideMessenger,
    dispatch,
    onSubmittedRef,
  });

  // Register the main editor with the provider
  useEffect(() => {
    if (props.isMainInput && editor) {
      mainEditorContext.setMainEditor(editor);
      mainEditorContext.setInputId(props.inputId);
      mainEditorContext.onEnterRef.current = onEnter;
    }
  }, [
    editor,
    props.isMainInput,
    props.inputId,
    mainEditorContext,
    onEnter,
    isStreaming,
  ]);

  const [shouldHideToolbar, setShouldHideToolbar] = useState(true);

  useEffect(() => {
    if (!editor) {
      return;
    }
    placeholderTextRef.current = getPlaceholderText(
      props.placeholder,
      historyLength,
    );
    // Dispatch an empty transaction so the placeholder decoration redraws
    editor.view.dispatch(editor.state.tr);
  }, [editor, props.placeholder, historyLength]);

  useEffect(() => {
    if (props.isMainInput) {
      editor?.commands.clearContent(true);
    }
  }, [editor, props.isMainInput]);

  // After the clear above: the session's unsent draft comes back (NI5)
  const draft = useDraftPersistence({
    editor,
    sessionId,
    inputId: props.isMainInput ? MAIN_DRAFT_INPUT : props.inputId,
    // Edit mode's input is about the selected code, not this session
    enabled: !(props.isMainInput && isInEdit),
    isSessionEmpty: historyLength === 0,
  });
  onSubmittedRef.current = draft.clearNow;
  // After the draft's own listener: the text typed is saved, then carried
  useDropSessionLoadOnTyping(editor, props.isMainInput && !isInEdit);

  useEffect(() => {
    if (isInEdit) {
      setShouldHideToolbar(false);
    }
  }, [isInEdit]);

  const editorFocusedRef = useUpdatingRef(editor?.isFocused, [editor]);

  useEffect(() => {
    if (props.isMainInput) {
      /**
       * I have a strong suspicion that many of the other focus
       * commands are redundant, especially the ones inside
       * useTimeout.
       */
      editor?.commands.focus();
    }
  }, [props.isMainInput, editor]);

  // Re-focus main input after done generating
  useEffect(() => {
    if (editor && !isStreaming && props.isMainInput && document.hasFocus()) {
      editor.commands.focus(undefined, { scrollIntoView: false });
    }
  }, [props.isMainInput, isStreaming, editor]);

  // Recovery mechanism: ensure historical inputs regain editability when streaming ends
  useEffect(() => {
    if (!isStreaming && !props.isMainInput && editor) {
      // Small delay to ensure editor state has settled after streaming transition
      const timeoutId = setTimeout(() => {
        if (editor && !editor.isDestroyed) {
          // Force re-enable the editor
          editor.setOptions({ editable: true });
          // Trigger view update to refresh editor state
          editor.view.dispatch(editor.state.tr);
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [isStreaming, props.isMainInput]);

  const drop = useChatInputDrop({
    editor,
    ideMessenger,
    availableContextProviders: props.availableContextProviders,
    model: defaultModel,
    inputId: props.inputId,
  });

  const [activeKey, setActiveKey] = useState<string | null>(null);

  const insertCharacterWithWhitespace = useCallback(
    (char: string) => {
      if (!editor) {
        return;
      }
      const text = editor.getText();
      if (!text.endsWith(char)) {
        if (text.length > 0 && !text.endsWith(" ")) {
          editor.commands.insertContent(` ${char}`);
        } else {
          editor.commands.insertContent(char);
        }
      }
    },
    [editor],
  );

  const { handleKeyUp, handleKeyDown } = useEditorEventHandlers({
    editor,
    isOSREnabled: isOSREnabled,
    editorFocusedRef,
    setActiveKey,
  });

  const blurTimeout = useRef<NodeJS.Timeout | null>(null);
  const cancelBlurTimeout = useCallback(() => {
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current);
      blurTimeout.current = null;
    }
  }, [blurTimeout]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (isInEdit) {
        return;
      }
      // Check if the new focus target is within our InputBoxDiv
      const currentTarget = e.currentTarget;
      const relatedTarget = e.relatedTarget as Node | null;

      if (relatedTarget && currentTarget?.contains(relatedTarget)) {
        return;
      }
      // Otherwise give e.g. listboxes a chance to cancel the hiding
      blurTimeout.current = setTimeout(() => {
        setShouldHideToolbar(true);
      }, 100);
    },
    [isInEdit, blurTimeout],
  );

  const handleFocus = useCallback(() => {
    cancelBlurTimeout();
    setShouldHideToolbar(false);
  }, [cancelBlurTimeout]);

  const onImageFilesSelected = (files: File[]) => {
    void drop.addImageFiles(files);
  };

  return (
    <InputBoxDiv
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className={
        !props.isMainInput && shouldHideToolbar
          ? "cursor-pointer"
          : "cursor-text"
      }
      onClick={() => {
        editor?.commands.focus();
      }}
      {...drop.handlers}
    >
      <div className="px-2.5 pt-2 pb-1">
        <div className="flex items-start gap-1">
          {!(shouldHideToolbar && !props.isMainInput) && (
            <div className="-ml-1.5 flex-none">
              <AttachMenu
                hideImageUpload={props.toolbarOptions?.hideImageUpload}
                hideAddContext={props.toolbarOptions?.hideAddContext}
                onAddContextItem={() => insertCharacterWithWhitespace("@")}
                onImageFilesSelected={onImageFilesSelected}
              />
            </div>
          )}
          <EditorContent
            // In a short panel (VS Code's bottom panel) 70vh would push the
            // toolbar and Enter button below the edge, so leave room for them
            className={`scroll-container min-w-0 flex-1 overflow-y-scroll ${props.isMainInput ? "max-h-[max(3em,min(70vh,calc(100vh_-_140px)))]" : ""}`}
            spellCheck={false}
            editor={editor}
            onClick={(event) => {
              event.stopPropagation();
            }}
          />
        </div>
        {drop.note && (
          <DropNotice text={drop.note} onDismiss={drop.dismissNote} />
        )}
        {draft.notice && (
          <DraftRestoredNotice
            text={draft.notice}
            onDismiss={draft.dismissNotice}
          />
        )}
        <InputToolbar
          isMainInput={props.isMainInput}
          toolbarOptions={props.toolbarOptions}
          activeKey={activeKey}
          hidden={shouldHideToolbar && !props.isMainInput}
          onEnter={onEnter}
          disabled={isStreaming}
        />
      </div>

      <DragOverlay show={drop.dragActive} hint={drop.hint} />
      <div id={TIPPY_DIV_ID} className="fixed z-50" />
    </InputBoxDiv>
  );
}

function toolbarOptionsEqual(a?: ToolbarOptions, b?: ToolbarOptions) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.hideAddContext === b.hideAddContext &&
    a.hideImageUpload === b.hideImageUpload &&
    a.hideUseCodebase === b.hideUseCodebase &&
    a.hideSelectModel === b.hideSelectModel &&
    a.enterText === b.enterText
  );
}

const MemoInner = memo(
  TipTapEditorInner,
  (prev, next) =>
    prev.isMainInput === next.isMainInput &&
    prev.placeholder === next.placeholder &&
    prev.historyKey === next.historyKey &&
    prev.inputId === next.inputId &&
    toolbarOptionsEqual(prev.toolbarOptions, next.toolbarOptions) &&
    (prev.availableContextProviders?.length || 0) ===
      (next.availableContextProviders?.length || 0) &&
    (prev.availableSlashCommands?.length || 0) ===
      (next.availableSlashCommands?.length || 0),
);

export function TipTapEditor(props: TipTapEditorProps) {
  return (
    <div className="relative w-full">
      <MemoInner {...props} />
    </div>
  );
}
