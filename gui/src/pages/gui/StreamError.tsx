import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ClipboardIcon,
  Cog6ToothIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import { useContext, useEffect, useMemo, useState } from "react";

import { parseContextOverflow } from "core/llm/contextOverflow";
import { parseMissingSecretNames } from "core/util/unresolvedSecrets";
import { GhostButton } from "../../components";
import { MissingSecretsPanel } from "../../components/config/MissingSecretsPanel";
import { useEditModel } from "../../components/mainInput/Lump/useEditBlock";
import { useMainEditor } from "../../components/mainInput/TipTapEditor";
import { OPEN_MODEL_SELECT_EVENT } from "../../components/modelSelection/ModelSelect";
import ToggleDiv from "../../components/ToggleDiv";
import { useAuth } from "../../context/Auth";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { newSession } from "../../redux/slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import {
  inputHasText,
  retryFailedRequest,
  retryPlanFor,
} from "../../redux/thunks/retryFailedRequest";
import { analyzeError } from "../../util/errorAnalysis";
import {
  describeTransientFailure,
  formatWait,
  MAX_AUTO_RETRY_SECONDS,
  transientFailure,
} from "../../util/transientFailure";

interface StreamErrorProps {
  error: unknown;
}

/**
 * Tries again by itself after a visible countdown, unless cancelled; then
 * nothing happens until the person chooses. While the machine is offline
 * (the webview's navigator.onLine; it knows about the network, not about the
 * server) it waits for the network to return and tries again then.
 */
function RetryCountdown({
  seconds,
  onRetry,
}: {
  seconds: number;
  onRetry: () => void;
}) {
  const [left, setLeft] = useState(seconds);
  const [cancelled, setCancelled] = useState(false);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  // Back online: try again straight away
  const [wasOffline, setWasOffline] = useState(!online);
  useEffect(() => {
    if (!online) setWasOffline(true);
    else if (wasOffline && !cancelled) onRetry();
  }, [online]);
  useEffect(() => {
    if (cancelled || !online) return;
    if (left <= 0) {
      onRetry();
      return;
    }
    const timer = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, cancelled, online]);
  if (cancelled) {
    return (
      <span className="text-description-muted" data-testid="retry-cancelled">
        Not trying again automatically.
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2" data-testid="retry-countdown">
      <span>
        {online
          ? `Trying again in ${formatWait(left)}.`
          : "This computer is offline. Trying again when the network is back."}
      </span>
      <GhostButton onClick={() => setCancelled(true)}>Cancel</GhostButton>
    </span>
  );
}

const StreamErrorDialog = ({ error }: StreamErrorProps) => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const { refreshProfiles } = useAuth();
  const { mainEditor } = useMainEditor();

  const {
    parsedError,
    statusCode,
    message,
    modelTitle,
    providerName,
    apiKeyUrl,
    helpUrl,
    customErrorMessage,
  } = useMemo(() => analyzeError(error, selectedModel), [error, selectedModel]);

  const handleRefreshProfiles = () => {
    void refreshProfiles("Clicked reload config from stream error dialog");
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  const copyErrorToClipboard = () => {
    void navigator.clipboard.writeText(parsedError);
  };

  const history = useAppSelector((store) => store.session.history);

  const checkKeysButton = apiKeyUrl ? (
    <GhostButton
      className="flex items-center"
      onClick={() => ideMessenger.ide.openUrl(apiKeyUrl)}
    >
      <KeyIcon className="mr-1.5 h-3.5 w-3.5" />
      <span>Check API key</span>
    </GhostButton>
  ) : null;

  const handleEditModel = useEditModel();

  const configButton = (
    <GhostButton
      className="flex items-center"
      onClick={() => handleEditModel(selectedModel)}
    >
      <Cog6ToothIcon className="mr-1.5 h-3.5 w-3.5" />
      <span>View config</span>
    </GhostButton>
  );

  const closeDialog = () => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  // Sends what failed again without rewriting the conversation
  // (retryFailedRequest): a failed new message is back in the input
  const resubmit = () => {
    const input = mainEditor?.getJSON();
    const plan = retryPlanFor(history, inputHasText(input));
    void dispatch(retryFailedRequest({ input }));
    if (plan.kind === "send-input") mainEditor?.commands.clearContent(false);
    closeDialog();
  };

  const resubmitButton = (
    <GhostButton className="flex items-center" onClick={resubmit}>
      <ArrowPathIcon className="mr-1.5 h-3.5 w-3.5" />
      <span>Resubmit last message</span>
    </GhostButton>
  );

  let errorContent = (
    <div className="mt-3 mb-1">
      <div className="m-0 p-0">
        <p className="m-0 mb-2 p-0">
          There was an error handling the response from{" "}
          {selectedModel?.title || "the model"}.
        </p>
        <p className="m-0 p-0">Please try to submit your message again.</p>
        <div className="mt-3">{resubmitButton}</div>
      </div>
    </div>
  );

  // The request was refused before it was sent because the key is a
  // `${{ secrets.* }}` reference with no value on this machine.
  const missingSecretNames = parseMissingSecretNames(message);
  if (missingSecretNames.length > 0) {
    errorContent = (
      <div className="flex flex-col gap-2" data-testid="missing-secret-error">
        <span>
          {`The key for ${selectedModel?.title ?? "this model"} is not set on this machine. Nothing was sent to ${providerName}.`}
        </span>
        <MissingSecretsPanel
          missing={missingSecretNames.map((secretName) => ({
            secretName,
            providers: selectedModel?.underlyingProviderName
              ? [selectedModel.underlyingProviderName]
              : [],
            modelNames: selectedModel?.title ? [selectedModel.title] : [],
          }))}
          onDone={() => {
            dispatch(setShowDialog(false));
            dispatch(setDialogMessage(undefined));
          }}
        />
      </div>
    );
  }

  // Display components for specific errors
  if (statusCode === 429) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>
          {`This might mean your ${modelTitle} usage has been rate limited
                by ${providerName}.`}
        </span>
        <div className="flex flex-row flex-wrap justify-start gap-3 py-4">
          {checkKeysButton}
          {configButton}
        </div>
      </div>
    );
  }

  if (statusCode === 404) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>Likely causes:</span>
        <ul className="m-0">
          <li>
            <span>Invalid</span>
            <code>apiBase</code>
            {selectedModel && (
              <>
                <span>{`: `}</span>
                <code>{selectedModel.apiBase}</code>
              </>
            )}
          </li>
          <li>
            <span>Model/deployment not found</span>
            {selectedModel && (
              <>
                <span>{` for: `}</span>
                <code>{selectedModel.model}</code>
              </>
            )}
          </li>
        </ul>
        <div>{configButton}</div>
      </div>
    );
  }

  if (statusCode === 401) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>{`It's possible that your API key is invalid.`}</span>
        <div className="flex flex-row flex-wrap gap-2">
          {checkKeysButton}
          {configButton}
        </div>
      </div>
    );
  }

  if (statusCode === 403) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>{`Likely cause: not authorized to access the model deployment.`}</span>
        <div className="flex flex-row flex-wrap gap-2">
          {checkKeysButton}
          {configButton}
        </div>
      </div>
    );
  }

  if (
    message &&
    (message.toLowerCase().includes("overloaded") ||
      message.toLowerCase().includes("malformed json"))
  ) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>{`Most likely, the provider's server(s) are overloaded and streaming was interrupted. Try again later`}</span>
        {selectedModel ? (
          <span>
            {`Provider: `}
            <code>{selectedModel.underlyingProviderName}</code>
          </span>
        ) : null}
      </div>
    );
  }

  // The prompt was longer than the model takes. Our count is an estimate;
  // core has now learned how far off it was (contextOverflow.ts), so trying
  // again drops more of the oldest history and fits. Compacting would send
  // the same too-long conversation to be summarised, so it is not offered.
  const overflow = message ? parseContextOverflow(message) : undefined;
  if (overflow && !customErrorMessage) {
    const fmt = (n?: number) => (n ? n.toLocaleString() : undefined);
    const sizes =
      overflow.actualTokens && overflow.maxTokens
        ? ` (${fmt(overflow.actualTokens)} tokens; the limit is ${fmt(overflow.maxTokens)})`
        : "";
    errorContent = (
      <div className="flex flex-col gap-2" data-testid="context-overflow">
        <span>
          {`The conversation is too long for ${selectedModel?.title ?? "this model"}${sizes}.`}
        </span>
        <span className="text-description-muted">
          Trying again leaves out more of the oldest messages so it fits. A new
          session starts with an empty context. Your message is kept.
        </span>
        <div className="flex flex-row flex-wrap justify-start gap-3 py-2">
          <GhostButton className="flex items-center" onClick={resubmit}>
            <ArrowPathIcon className="mr-1.5 h-3.5 w-3.5" />
            <span>Try again</span>
          </GhostButton>
          <GhostButton
            className="flex items-center"
            onClick={() => {
              closeDialog();
              dispatch(newSession());
            }}
          >
            <span>New session</span>
          </GhostButton>
        </div>
      </div>
    );
  }

  // A rate limit, an overloaded server or a lost connection: core already
  // retried it (and tried a model's other routes), so the person decides:
  // now, after a wait, or another model. The message is kept either way.
  const transient = transientFailure(statusCode, message);
  if (transient && !customErrorMessage) {
    const autoRetry = transient.waitSeconds <= MAX_AUTO_RETRY_SECONDS;
    errorContent = (
      <div className="flex flex-col gap-2" data-testid="transient-failure">
        <span>
          {describeTransientFailure(
            transient,
            selectedModel?.title ?? "The model",
          )}
        </span>
        <span className="text-description-muted">
          {transient.waitFromServer
            ? `The server asked to wait ${formatWait(transient.waitSeconds)}. `
            : ""}
          Your message is kept; nothing was lost.
        </span>
        {autoRetry && (
          <RetryCountdown seconds={transient.waitSeconds} onRetry={resubmit} />
        )}
        <div className="flex flex-row flex-wrap justify-start gap-3 py-2">
          <GhostButton className="flex items-center" onClick={resubmit}>
            <ArrowPathIcon className="mr-1.5 h-3.5 w-3.5" />
            <span>Try again now</span>
          </GhostButton>
          <GhostButton
            className="flex items-center"
            onClick={() => {
              closeDialog();
              // The picker in the input toolbar, after the dialog has gone
              setTimeout(
                () => window.dispatchEvent(new Event(OPEN_MODEL_SELECT_EVENT)),
                0,
              );
            }}
          >
            <Cog6ToothIcon className="mr-1.5 h-3.5 w-3.5" />
            <span>Change model</span>
          </GhostButton>
          {transient.kind === "rate-limit" && checkKeysButton}
        </div>
      </div>
    );
  }

  // Custom error message from error analysis (e.g. invalid API key, insufficient balance)
  if (customErrorMessage) {
    errorContent = (
      <div className="flex flex-col gap-2">
        <span>{customErrorMessage}</span>
        <div className="flex flex-row flex-wrap justify-start gap-3 py-2">
          {helpUrl && (
            <GhostButton
              className="flex items-center"
              onClick={() => ideMessenger.ide.openUrl(helpUrl)}
            >
              <ArrowTopRightOnSquareIcon className="mr-1.5 h-3.5 w-3.5" />
              <span>View help documentation</span>
            </GhostButton>
          )}
          {apiKeyUrl && (
            <GhostButton
              className="flex items-center"
              onClick={() => ideMessenger.ide.openUrl(apiKeyUrl)}
            >
              <KeyIcon className="mr-1.5 h-3.5 w-3.5" />
              <span>Check API key</span>
            </GhostButton>
          )}
          {configButton}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-3 pt-3 pb-3">
      {/* Concise error title */}
      <h3 className="m-0 p-0 text-lg font-medium text-error">
        Error handling model response
      </h3>

      {errorContent}

      {/* Expandable technical details using ToggleDiv */}
      {message && (
        <div className="mb-2">
          <ToggleDiv
            title="View error output"
            testId="error-output-toggle"
            defaultOpen
          >
            <div className="flex flex-col gap-0 rounded-xs">
              <code className="block max-h-48 overflow-y-auto p-3 font-mono text-xs text-editor-foreground">
                {parsedError}
              </code>

              <div className="flex flex-row items-center justify-end gap-2 p-2">
                <GhostButton
                  onClick={copyErrorToClipboard}
                  className="flex items-center"
                >
                  <ClipboardIcon className="mr-1.5 h-3.5 w-3.5" />
                  <span>Copy output</span>
                </GhostButton>

                <GhostButton
                  onClick={() => {
                    ideMessenger.post("toggleDevTools", undefined);
                  }}
                  className="flex items-center"
                >
                  <ArrowTopRightOnSquareIcon className="mr-1.5 h-4 w-4" />
                  <span className="text-xs">View Logs</span>
                </GhostButton>
              </div>
            </div>
          </ToggleDiv>
        </div>
      )}
    </div>
  );
};

export default StreamErrorDialog;
