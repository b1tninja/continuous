import type { ToolDialectSetting } from "@continuedev/config-yaml";
import { connectionTestDefaultBase } from "core/util/anthropicSurfaceTest";
import type { OpenAICompatTestResult } from "core/util/openaiCompatTest";
import {
  recoveryConfirmText,
  recoveryOffer,
  recoverySnippet,
} from "core/util/recoveryOffer";
import {
  suggestSettings,
  type CurrentSettings,
  type Suggestion,
} from "core/util/suggestedSettings";
import { useContext, useEffect, useRef, useState } from "react";
import Alert from "../components/gui/Alert";
import { Button } from "../components/ui/Button";
import { IdeMessengerContext } from "../context/IdeMessenger";

const LINE = String.fromCharCode(10);

interface Props {
  provider: string;
  apiBase?: string;
  /** The key as typed in the form; empty for a keyless local server or a stored key. */
  apiKey?: string;
  /** The model that will be saved; the first listed one is probed when it is not served. */
  model?: string;
  /** The name the model has (or will have) in config.yaml; recovery is set on that entry. */
  modelTitle?: string;
  /** Required fields are filled in. */
  canTest: boolean;
  /** Puts the window the server reported into the model's context length. */
  onUseContextLength?: (tokens: number) => void;
  /** What the model has now, to suggest only what would change it. */
  current?: CurrentSettings;
  /** Puts the suggested settings into the Configure form (reviewed and saved there). */
  onApplySuggestions?: (suggestions: Suggestion[]) => void;
  /**
   * The setup flow's automatic test. Each time the number goes up the model
   * listing runs by itself: one GET, no tokens spent. With it the button
   * also only lists, the tool-call request (which a provider bills) gets a
   * button of its own, and a result is dropped when the provider, the
   * address or the key changes.
   */
  autoRunToken?: number;
  /** "yes", "9 of 14" or "not reported" for the listed model ids: the "Tools:" part of the line. */
  toolsFor?: (models: string[]) => string;
  /** Plain words for a failure, when the caller has better ones than the raw error. */
  describeError?: (error: string) => string;
  /**
   * The address must be typed: a server of the person's own, which has none
   * to fall back on. Without this an empty address means the provider's.
   */
  addressRequired?: boolean;
}

/**
 * "Test connection" for an OpenAI-compatible endpoint: lists the models the
 * server serves, then sends one request with a made-up tool to see how the
 * model answers (the tool is never run). The same result Bedrock's tester shows.
 */
export function OpenAICompatConnectionTester({
  provider,
  apiBase,
  apiKey,
  model,
  modelTitle,
  canTest,
  onUseContextLength,
  current,
  onApplySuggestions,
  autoRunToken,
  toolsFor,
  describeError,
  addressRequired,
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenAICompatTestResult>();
  const [probedModel, setProbedModel] = useState<string>();
  const [applied, setApplied] = useState(false);
  const [recovery, setRecovery] = useState<
    "on" | "declined" | { snippet: string[] }
  >();
  const inFlow = autoRunToken !== undefined;
  // Counts the runs, so the answer of one that was stopped or overtaken is dropped
  const runSeq = useRef(0);

  async function run(withModel?: string, checkModel?: string) {
    const res = await ideMessenger.request("openaiCompat/testConnection", {
      provider,
      apiBase: apiBase || undefined,
      apiKey: apiKey || undefined,
      model: withModel,
      ...(checkModel ? { checkModel } : {}),
    });
    return res.status === "success"
      ? res.content
      : ({
          ok: false,
          error: String(res.error ?? "Request failed"),
        } as OpenAICompatTestResult);
  }

  /** `listOnly` asks for the model listing and nothing else: no request a provider bills. */
  async function testConnection(listOnly = false) {
    const seq = ++runSeq.current;
    const stillWanted = () => runSeq.current === seq;
    setBusy(true);
    setResult(undefined);
    setApplied(false);
    setProbedModel(undefined);
    setRecovery(undefined);
    try {
      if (listOnly) {
        const listed = await run();
        if (stillWanted()) setResult(listed);
        return;
      }
      if (provider === "anthropic") {
        // Read-only: the listing and the configured id; no tool probe here.
        const read = await run(model || undefined);
        if (stillWanted()) setResult(read);
        return;
      }
      // The listing, and the configured id checked against the server
      const listed = await run(undefined, model || undefined);
      if (!stillWanted()) return;
      if (!listed.ok || listed.models.length === 0) return setResult(listed);
      const pick =
        model && listed.models.includes(model) ? model : listed.models[0];
      setProbedModel(pick);
      const probed = await run(pick);
      if (!stillWanted()) return;
      setResult(
        probed.ok && listed.ok
          ? {
              ...probed,
              ...(listed.modelCheck ? { modelCheck: listed.modelCheck } : {}),
              // From the listing of the configured id, not of the probed pick
              ...(listed.listedLimits
                ? { listedLimits: listed.listedLimits }
                : { listedLimits: undefined }),
            }
          : probed,
      );
    } catch (e) {
      if (!stillWanted()) return;
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (stillWanted()) setBusy(false);
    }
  }

  /** The request already sent cannot be recalled; its answer is not used. */
  function stop() {
    runSeq.current++;
    setBusy(false);
  }

  const probe = result?.ok ? result.probe : undefined;
  const suggestions: Suggestion[] =
    result?.ok && current && onApplySuggestions
      ? suggestSettings(
          {
            listedLimits: result.listedLimits,
            probe: probe?.ok
              ? { kind: probe.kind, recoveryDialect: probe.recoveryDialect }
              : undefined,
          },
          current,
        )
      : [];
  const offer = recoveryOffer(probe?.ok ? probe : undefined, provider, "ide");
  const target = modelTitle ?? probedModel;

  /** Sets `toolDialect` on this model in the person's own config.yaml, after the IDE's own confirmation. */
  async function turnOnRecovery(dialect: string) {
    if (!target) return;
    const res = await ideMessenger.request("config/setToolDialect", {
      title: target,
      toolDialect: dialect as ToolDialectSetting,
      confirm: recoveryConfirmText(target, dialect),
    });
    if (res.status === "success" && res.content.saved) setRecovery("on");
    else if (res.status === "success" && res.content.declined) {
      setRecovery("declined");
    } else {
      setRecovery({ snippet: recoverySnippet(provider, target, dialect) });
    }
  }

  const defaultBase = addressRequired
    ? undefined
    : connectionTestDefaultBase(provider);
  const needsBase = !defaultBase && !apiBase?.trim();
  const testable = canTest && !needsBase;

  // The setup flow says when (useAutoTest holds the rule); 0 is "not yet".
  useEffect(() => {
    if (autoRunToken && testable) void testConnection(true);
  }, [autoRunToken]);

  // In the flow a result is about one provider, address and key: a change to
  // any of them takes it off the screen and drops a test that is on its way.
  useEffect(() => {
    if (!inFlow) return;
    runSeq.current++;
    setBusy(false);
    setResult(undefined);
  }, [inFlow, provider, apiBase, apiKey]);

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="flex flex-wrap items-center gap-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void testConnection(inFlow)}
            disabled={!testable || busy}
          >
            {busy
              ? "Connecting…"
              : inFlow && result
                ? "Test again"
                : "Test connection"}
          </Button>
          {inFlow && busy && (
            <Button type="button" variant="ghost" onClick={stop}>
              Stop
            </Button>
          )}
          {inFlow &&
            // Anthropic's test only reads; it has no tool-call request
            provider !== "anthropic" &&
            result?.ok &&
            !probe &&
            result.models.length > 0 && (
              <Button
                type="button"
                variant="outline"
                data-testid="check-tool-calls"
                title="Sends one short request with a made-up tool, to see how the model answers. The tool is never run. A provider bills the few tokens it uses."
                onClick={() => void testConnection(false)}
                disabled={!testable || busy}
              >
                Check tool calls
              </Button>
            )}
        </div>
        {(needsBase || (defaultBase && !apiBase?.trim())) && (
          <span
            className="mt-1 block text-xs text-description-muted"
            data-testid="test-connection-base-help"
          >
            {needsBase
              ? "This provider has no default address. Enter its API base (it usually ends in /v1) to test it."
              : `With no API base, this tests ${defaultBase}.`}
          </span>
        )}
      </div>

      {result && !result.ok && (
        <Alert type="error" size="sm" role="alert">
          <span className="block text-xs font-medium">Could not connect</span>
          {describeError ? (
            <span
              className="block text-xs break-words"
              data-testid="test-connection-error"
            >
              {describeError(result.error)}
            </span>
          ) : (
            <code className="block text-xs break-all whitespace-pre-wrap">
              {result.error}
            </code>
          )}
        </Alert>
      )}

      {result?.ok && (
        <Alert type="success" size="sm" role="status">
          <span
            className="block text-xs font-medium"
            data-testid="test-connection-line"
          >
            Connected. {result.models.length} model
            {result.models.length === 1 ? "" : "s"}
            {toolsFor ? `. Tools: ${toolsFor(result.models)}.` : " listed."}
          </span>
        </Alert>
      )}

      {result?.ok && result.modelCheck && (
        <Alert
          type={result.modelCheck.status === "not-found" ? "warning" : "info"}
          size="sm"
          role="status"
          data-testid="model-check"
        >
          <span className="block text-xs">
            {result.modelCheck.status === "found"
              ? result.modelCheck.summary
              : result.modelCheck.message}
          </span>
          {result.modelCheck.status === "unverified" && (
            <span className="block text-xs opacity-80">
              Chat requests are not affected.
            </span>
          )}
        </Alert>
      )}

      {result?.ok && result.listedLimits?.note && (
        <Alert type="info" size="sm" role="status" data-testid="listed-limits">
          <span className="block text-xs">{result.listedLimits.note}</span>
          {onUseContextLength &&
            result.listedLimits.contextLength !== undefined && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1"
                data-testid="use-listed-context"
                onClick={() =>
                  onUseContextLength(result.listedLimits!.contextLength!)
                }
              >
                Use {result.listedLimits.contextLength.toLocaleString()} tokens
              </Button>
            )}
        </Alert>
      )}

      {suggestions.length > 0 && onApplySuggestions && (
        <Alert type="info" size="sm" role="status" data-testid="suggestions">
          <span className="block text-xs font-medium">
            This test suggests{" "}
            {suggestions.length === 1 ? "a setting" : "settings"}:
          </span>
          <ul className="m-0 my-1 list-disc pl-4 text-xs">
            {suggestions.map((s) => (
              <li key={s.key}>
                {s.label}. <span className="opacity-80">{s.reason}</span>
              </li>
            ))}
          </ul>
          {applied ? (
            <span className="block text-xs" data-testid="suggestions-applied">
              Put in the form. Review the change and save it there.
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="apply-all-suggestions"
              onClick={() => {
                onApplySuggestions(suggestions);
                setApplied(true);
              }}
            >
              Apply all
            </Button>
          )}
        </Alert>
      )}

      {result?.ok &&
        result.retirement?.map((n) => (
          <Alert
            key={n.key}
            type="warning"
            size="sm"
            role="status"
            data-testid="retirement-notice"
          >
            <span className="block text-xs">{n.message}</span>
            <span className="block text-xs opacity-80">
              {n.from === "live"
                ? "From your key's model list."
                : `Checked-in table, read ${n.fetchedOn}.`}
            </span>
          </Alert>
        ))}

      {probe && (
        <Alert
          type={probe.ok && probe.kind !== "none" ? "info" : "warning"}
          size="sm"
          role="status"
        >
          <span className="text-xs" data-testid="tool-calls-result">
            {probe.ok
              ? `${probe.label}${probedModel ? ` (${probedModel})` : ""}`
              : `Tool use: could not tell (${probe.error})`}
          </span>
          {probe.ok && probe.serverParses && (
            <span className="block text-xs opacity-80">
              The server parses this model's tool calls itself.
            </span>
          )}
          {probe.ok && probe.preset && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-preset"
            >
              Known format for this model family: {probe.preset}
            </span>
          )}
          {result?.ok && result.template && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-template"
            >
              {result.template}
            </span>
          )}
          {probe.ok && probe.facts && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-facts"
            >
              {probe.facts}
            </span>
          )}
          {probe.ok && probe.recorded && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-recorded"
            >
              Recorded on this computer: host name and counts only, no key. One
              probe is not enough to change any default. To stop recording, set
              probes.record: false in config.yaml.
            </span>
          )}
          {offer && target && !recovery && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              data-testid="turn-on-recovery"
              title={`Sets toolDialect: ${offer.dialect} on ${target} in your config.yaml, after you confirm`}
              onClick={() => void turnOnRecovery(offer.dialect)}
            >
              Turn on recovery
            </Button>
          )}
          {recovery === "on" && (
            <span className="block text-xs" data-testid="recovery-on">
              Recovery is on for this model.
            </span>
          )}
          {recovery === "declined" && (
            <span className="block text-xs">Not changed.</span>
          )}
          {recovery && typeof recovery === "object" && (
            <span className="block text-xs" data-testid="recovery-snippet">
              Could not edit config.yaml (the model may not be saved yet, or
              comes from a shared block). Add this by hand:
              <code className="block whitespace-pre-wrap">
                {recovery.snippet.join(LINE)}
              </code>
            </span>
          )}
        </Alert>
      )}
    </div>
  );
}
