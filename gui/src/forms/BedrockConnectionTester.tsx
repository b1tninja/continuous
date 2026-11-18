import { useContext, useState } from "react";
import type {
  BedrockConnectionParams,
  BedrockProbeToolCallsResult,
  BedrockTestModelResult,
} from "core/protocol/core";
import { Button } from "../components/ui/Button";
import Alert from "../components/gui/Alert";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { BedrockAllModelsResult, listBedrockModelsFor } from "./bedrockModels";
import type { BedrockEndpointModel } from "./modelListUtils";

/** "text: https://..." as the text and the link, for a link button. */
function splitTrailingUrl(text: string): { text: string; url?: string } {
  const m = /^(.*?):?\s+(https:\/\/\S+)$/.exec(text);
  return m ? { text: m[1], url: m[2] } : { text };
}

const ANTHROPIC_USE_CASE_NOTICE =
  "Anthropic models on this account need the Anthropic use-case form completed before they will work (Bedrock console, Model access).";

interface Props {
  /** Connection settings built from the current form values. */
  connection: Record<string, string>;
  /** Model that will be saved right now (picked, typed, or the package default). */
  model: string;
  /** Required fields are filled in. */
  canTest: boolean;
  /** Send the test message through Mantle (the selected model is Mantle-only). */
  testEndpoint?: "mantle";
  /**
   * Called with the models available to these credentials (from every endpoint
   * that could be queried) once the connection works, and with `undefined`
   * when a new test starts or it fails. `notes` explains anything left out.
   */
  onModelsLoaded: (
    models: BedrockEndpointModel[] | undefined,
    notes: string[],
  ) => void;
}

/**
 * A failure: one headline, then the error itself (it can hold an ARN or a
 * long request id, so it breaks anywhere) with a Copy button for a bug report.
 */
function ErrorResult({ headline, error }: { headline: string; error: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert type="error" size="sm" role="alert">
      <span className="block text-xs font-medium">{headline}</span>
      <code className="block text-xs break-all whitespace-pre-wrap">
        {error}
      </code>
      <button
        type="button"
        className="mt-1 min-h-6 cursor-pointer rounded border border-solid border-border bg-transparent px-2 text-xs text-foreground hover:brightness-125"
        onClick={() => {
          void navigator.clipboard?.writeText(error);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy error"}
      </button>
    </Alert>
  );
}

/**
 * "Test connection" for the Bedrock add-model form: lists the models available
 * to the entered credentials/region on both Bedrock endpoints (which then
 * populate the Model picker), and can send a one-word test message.
 */
export function BedrockConnectionTester({
  connection,
  model,
  canTest,
  testEndpoint,
  onModelsLoaded,
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [listing, setListing] = useState(false);
  const [listResult, setListResult] = useState<BedrockAllModelsResult>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<BedrockTestModelResult>();
  const [toolCalls, setToolCalls] = useState<BedrockProbeToolCallsResult>();

  async function testConnection() {
    setListing(true);
    setListResult(undefined);
    setTestResult(undefined);
    setToolCalls(undefined);
    onModelsLoaded(undefined, []);
    try {
      const result = await listBedrockModelsFor(ideMessenger, connection);
      setListResult(result);
      if (result.ok) {
        onModelsLoaded(result.models, result.notes);
        if (model && !testEndpoint) await probeToolCalls();
      }
    } finally {
      setListing(false);
    }
  }

  /**
   * One request with a made-up tool (a few hundred tokens, temperature 0); the
   * tool is never run. Only here, on "Test connection", never in the background.
   */
  async function probeToolCalls() {
    try {
      const res = await ideMessenger.request("bedrock/probeToolCalls", {
        ...(connection as BedrockConnectionParams),
        model,
      });
      setToolCalls(
        res.status === "success"
          ? res.content
          : { ok: false, error: String(res.error ?? "Request failed") },
      );
    } catch (e) {
      setToolCalls({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function sendTestMessage() {
    setTesting(true);
    setTestResult(undefined);
    try {
      const res = await ideMessenger.request("bedrock/testModel", {
        ...(connection as BedrockConnectionParams),
        ...(testEndpoint ? { endpoint: testEndpoint } : {}),
        model,
      });
      setTestResult(
        res.status === "success"
          ? res.content
          : { ok: false, error: String(res.error ?? "Request failed") },
      );
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  const models = listResult?.ok ? listResult.models : [];
  const mantleOnly = models.filter((m) => m.endpoint === "mantle").length;
  const needAccess = models.filter(
    (m) => m.access === "needs-access" || m.access === "pending",
  ).length;
  const quota = listResult?.ok ? listResult.quota : undefined;
  const selectedQuotaWarning = models.find((m) => m.id === model)?.quotaWarning;
  const quotaWarning = selectedQuotaWarning
    ? splitTrailingUrl(selectedQuotaWarning)
    : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={testConnection}
          disabled={!canTest || listing}
        >
          {listing ? "Connecting…" : "Test connection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={sendTestMessage}
          disabled={!canTest || testing || !model}
          title={`Send a tiny test message to ${model}`}
        >
          {testing ? "Sending…" : "Send test message"}
        </Button>
      </div>

      {listResult && !listResult.ok && (
        <ErrorResult headline="Could not connect" error={listResult.error} />
      )}

      {listResult?.ok && (
        <Alert type="success" size="sm" role="status">
          <span className="block text-xs font-medium">
            Connected. {models.length} model{models.length === 1 ? "" : "s"}{" "}
            available
            {connection.region ? ` in ${connection.region}` : ""}
            {mantleOnly > 0
              ? ` (${mantleOnly} only on Bedrock Mantle, AWS's newer endpoint)`
              : ""}
            .
          </span>
          <span className="block text-xs text-description">
            The Model list above now shows them
            {needAccess > 0
              ? `; ${needAccess} need${needAccess === 1 ? "s" : ""} access (Bedrock console, Model access) and ${needAccess === 1 ? "is" : "are"} marked`
              : ""}
            .
          </span>
        </Alert>
      )}

      {toolCalls && (
        <Alert
          type={toolCalls.ok && toolCalls.kind !== "none" ? "info" : "warning"}
          size="sm"
          role="status"
        >
          <span className="text-xs" data-testid="tool-calls-result">
            {toolCalls.ok
              ? toolCalls.label
              : `Tool use: could not tell (${toolCalls.error})`}
          </span>
          {toolCalls.ok && toolCalls.preset && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-preset"
            >
              Known format for this model family: {toolCalls.preset}
            </span>
          )}
          {toolCalls.ok && toolCalls.facts && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-facts"
            >
              {toolCalls.facts}
            </span>
          )}
        </Alert>
      )}

      {quotaWarning && (
        <Alert type="warning" size="sm" role="status">
          <span className="text-xs" data-testid="quota-warning">
            {quotaWarning.text}
          </span>
          {quotaWarning.url && (
            <button
              type="button"
              className="mt-1 block min-h-6 cursor-pointer rounded border border-solid border-border bg-transparent px-2 text-xs text-foreground hover:brightness-125"
              onClick={() => ideMessenger.post("openUrl", quotaWarning.url!)}
            >
              Open Service Quotas
            </button>
          )}
        </Alert>
      )}

      {quota?.note && (
        <span
          className="text-xs text-description"
          data-testid="quota-check-note"
        >
          {quota.note}
          {quota.docsUrl && (
            <>
              {" "}
              <a
                href={quota.docsUrl}
                className="cursor-pointer text-link underline"
                onClick={(e) => {
                  e.preventDefault();
                  ideMessenger.post("openUrl", quota.docsUrl!);
                }}
              >
                (why)
              </a>
            </>
          )}
        </span>
      )}

      {models.some((m) => m.needsAnthropicUseCase) && (
        <Alert type="warning" size="sm" role="status">
          <span className="text-xs">{ANTHROPIC_USE_CASE_NOTICE}</span>
        </Alert>
      )}

      {testResult &&
        (testResult.ok ? (
          <Alert type="success" size="sm" role="status">
            <span className="text-xs">
              {testResult.modelId} replied
              {testResult.reply ? ` "${testResult.reply}"` : ""} in{" "}
              {testResult.latencyMs} ms.
            </span>
          </Alert>
        ) : (
          <ErrorResult
            headline="Test message failed"
            error={testResult.error}
          />
        ))}
    </div>
  );
}
