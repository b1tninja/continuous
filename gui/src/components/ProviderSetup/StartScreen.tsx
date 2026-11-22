import type { DetectedLocalServer } from "core/llm/localServers";
import type { ReactNode } from "react";
import { foundLine, LocalServerDetection } from "./useLocalServerDetection";

interface StartScreenProps {
  detection: LocalServerDetection;
  onApiKey: () => void;
  /** A found server was chosen. */
  onServer: (server: DetectedLocalServer) => void;
  /** "A server on this computer" itself: enter its address. */
  onLocalAddress: () => void;
  onNetwork: () => void;
  onNothing: () => void;
}

const DOOR =
  "box-border w-full min-w-0 cursor-pointer rounded-sm border border-solid border-description bg-transparent px-3 py-2 text-left text-foreground hover:bg-input";
// 24 px high, so each is a target a finger or a shaky pointer can hit
const LINK =
  "inline-flex min-h-6 cursor-pointer items-center border-none bg-transparent p-0 text-left text-xs text-link underline";
const FOUND =
  "box-border w-full min-w-0 cursor-pointer rounded-sm border border-solid border-border bg-transparent px-2 py-1 text-left text-xs [overflow-wrap:anywhere] text-foreground hover:bg-input";

function Door({
  testId,
  title,
  hint,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  hint?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className={DOOR}
        data-testid={testId}
        onClick={onClick}
      >
        <span className="block text-sm font-medium">{title}</span>
        {hint && (
          <span className="block text-xs break-words text-description-muted">
            {hint}
          </span>
        )}
      </button>
      {children}
    </div>
  );
}

/**
 * The first question of "Add a model": what the person has, in their words.
 * All four choices are there at once; the servers found on this computer are
 * filled in under the second when the answer arrives.
 */
export function StartScreen({
  detection,
  onApiKey,
  onServer,
  onLocalAddress,
  onNetwork,
  onNothing,
}: StartScreenProps) {
  const { status, servers, error } = detection;
  return (
    <div
      className="@container flex min-w-0 flex-col gap-3"
      data-testid="start-screen"
    >
      <div className="text-sm font-medium">What do you have?</div>
      <div className="grid min-w-0 grid-cols-1 gap-3 @[30rem]:grid-cols-2">
        <Door
          testId="door-api-key"
          title="An API key"
          hint="Anthropic, OpenAI, OpenRouter, Bedrock and others"
          onClick={onApiKey}
        />

        <Door
          testId="door-this-computer"
          title="A server on this computer"
          hint="Ollama, LM Studio, llama.cpp and others"
          onClick={onLocalAddress}
        >
          <div
            className="flex min-w-0 flex-col gap-1 pl-3 text-xs"
            data-testid="found-servers"
            aria-live="polite"
          >
            {status === "looking" && (
              <span className="text-description-muted">Looking…</span>
            )}
            {status === "done" &&
              servers.map((server) => (
                <button
                  key={server.apiBase}
                  type="button"
                  className={FOUND}
                  data-testid={`found-${new URL(server.apiBase).port}`}
                  onClick={() => onServer(server)}
                >
                  {foundLine(server)}
                </button>
              ))}
            {status === "done" && servers.length === 0 && (
              <>
                <span className="break-words text-description-muted">
                  {error
                    ? `Could not look: ${error}`
                    : "None found. Nothing answered on the usual ports of this computer."}
                </span>
                <span className="flex flex-wrap gap-x-3">
                  <button
                    type="button"
                    className={LINK}
                    onClick={onLocalAddress}
                  >
                    Enter an address
                  </button>
                  <button
                    type="button"
                    className={LINK}
                    onClick={detection.look}
                  >
                    Look again
                  </button>
                  <button type="button" className={LINK} onClick={onNothing}>
                    See "Nothing yet"
                  </button>
                </span>
              </>
            )}
          </div>
        </Door>

        <Door
          testId="door-network"
          title="A server on my network"
          hint="An OpenAI-compatible address on another machine"
          onClick={onNetwork}
        />

        <Door
          testId="door-nothing"
          title="Nothing yet"
          hint="Two ways to start, both free to set up"
          onClick={onNothing}
        />
      </div>
    </div>
  );
}
