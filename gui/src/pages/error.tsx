import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useDispatch } from "react-redux";
import { useNavigate, useRouteError } from "react-router-dom";
import { Button } from "../components";
import { newSession } from "../redux/slices/sessionSlice";

/** The one line worth showing: a route error's status text, else its message. */
function errorLine(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { statusText?: unknown; message?: unknown };
    if (typeof e.statusText === "string" && e.statusText) return e.statusText;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return typeof error === "string" && error ? error : "Unknown error";
}

/**
 * Shown when a page fails to render. The button starts a new chat and clears
 * what this window saved (its stored state and the input history), so its label
 * and the line above it say so. The stack goes to the console, not the page.
 */
const ErrorPage: React.FC = () => {
  const error = useRouteError();
  console.error(error);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  return (
    <div
      role="alert"
      data-testid="error-page"
      className="flex flex-col items-center justify-center px-2 py-4 text-center sm:px-8"
    >
      <h1 className="mb-2 text-xl font-bold">This page could not be shown</h1>

      <code className="mx-2 mb-3 max-w-full py-2 break-words whitespace-pre-wrap">
        {errorLine(error)}
      </code>

      <p className="mt-0 mb-3 max-w-md text-xs text-description">
        Starting a new chat closes the chat that was open in this window and
        clears the input history. Earlier chats stay in History.
      </p>

      <Button
        className="flex flex-row items-center gap-2"
        data-testid="error-page-new-chat"
        onClick={() => {
          dispatch(newSession());
          localStorage.removeItem("persist:root");
          localStorage.removeItem("inputHistory_chat");
          void navigate("/");
        }}
      >
        <ArrowPathIcon className="h-5 w-5" aria-hidden="true" />
        Start a new chat
      </Button>
    </div>
  );
};

export default ErrorPage;
