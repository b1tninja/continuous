import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";

export type InlineErrorMessageType =
  "out-of-context" | { kind: "out-of-context"; detail: string };

function outOfContextDetail(
  message: InlineErrorMessageType | undefined,
): string | undefined {
  if (message === "out-of-context") {
    return "This prompt does not fit the context window. Change the context length under Models → Configure → Context & cost. When no window is published for the model, 32,768 is used until you set one.";
  }
  if (
    message !== undefined &&
    typeof message === "object" &&
    message.kind === "out-of-context"
  ) {
    return message.detail;
  }
  return undefined;
}

export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector(
    (state) => state.session.inlineErrorMessage,
  );
  const detail = outOfContextDetail(inlineErrorMessage);
  // Buttons that look like the links they replace
  const linkButton =
    "cursor-pointer border-none bg-transparent p-0 [font-family:inherit] text-xs text-inherit hover:underline";
  if (detail) {
    return (
      <div
        className={`relative m-2 flex flex-col rounded-md border border-solid border-border bg-transparent p-4`}
        data-testid="context-window-error"
      >
        <p
          className={`thread-message m-0 text-left text-sm whitespace-pre-wrap text-error`}
        >
          {detail}
        </p>
        <div className="flex flex-row items-center justify-center gap-1.5 px-3 text-description">
          <button
            type="button"
            aria-label="Open config"
            className={linkButton}
            onClick={() => {
              ideMessenger.post("config/openProfile", {
                profileId: undefined,
              });
            }}
          >
            <span className="hidden xs:flex">Open config</span>
            <span className="xs:hidden">Config</span>
          </button>
          |
          <button
            type="button"
            className={linkButton}
            onClick={() => {
              dispatch(setInlineErrorMessage(undefined));
            }}
          >
            Hide
          </button>
        </div>
      </div>
    );
  }
  return null;
}
