import { useContext, useState } from "react";
import type { ToolDialectSetting } from "@continuedev/config-yaml";
import { connectionTestDefaultBase } from "core/util/anthropicSurfaceTest";
import type { OpenAICompatTestResult } from "core/util/openaiCompatTest";
import {
  recoveryConfirmText,
  recoveryOffer,
  recoverySnippet,
} from "core/util/recoveryOffer";
import { Button } from "../components/ui/Button";
import Alert from "../components/gui/Alert";
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
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenAICompatTestResult>();
  const [probedModel, setProbedModel] = useState<string>();
  const [recovery, setRecovery] = useState<
    "on" | "declined" | { snippet: string[] }
  >();

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

  async function testConnection() {
    setBusy(true);
    setResult(undefined);
    setProbedModel(undefined);
    setRecovery(undefined);
    try {
      if (provider === "anthropic") {
        // Read-only: the listing and the configured id; no tool probe here.
        return setResult(await run(model || undefined));
      }
      // The listing, and the configured id checked against the server
      const listed = await run(undefined, model || undefined);
      if (!listed.ok || listed.models.length === 0) return setResult(listed);
      const pick =
        model && listed.models.includes(model) ? model : listed.models[0];
      setProbedModel(pick);
      const probed = await run(pick);
      setResult(
        probed.ok && listed.ok && listed.modelCheck
          ? { ...probed, modelCheck: listed.modelCheck }
          : probed,
      );
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  const probe = result?.ok ? result.probe : undefined;
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

  const defaultBase = connectionTestDefaultBase(provider);
  const needsBase = !defaultBase && !apiBase?.trim();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={testConnection}
          disabled={!canTest || busy || needsBase}
        >
          {busy ? "Connecting…" : "Test connection"}
        </Button>
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
          <code className="block text-xs break-all whitespace-pre-wrap">
            {result.error}
          </code>
        </Alert>
      )}

      {result?.ok && (
        <Alert type="success" size="sm" role="status">
          <span className="block text-xs font-medium">
            Connected. {result.models.length} model
            {result.models.length === 1 ? "" : "s"} listed.
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
