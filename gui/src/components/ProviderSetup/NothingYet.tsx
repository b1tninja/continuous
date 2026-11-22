import { LOCAL_ONBOARDING_CHAT_MODEL } from "core/config/onboarding";
import type { DetectedLocalServer } from "core/llm/localServers";
import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { providers } from "../../pages/AddNewModel/configs/providers";
import OllamaModelDownload from "../OnboardingCard/components/OllamaModelDownload";
import { Button } from "../ui";
import {
  foundLine,
  hostPort,
  LocalServerDetection,
} from "./useLocalServerDetection";

/** Where a key is made, for the providers a new person most often starts with. */
const KEY_PROVIDERS = ["anthropic", "openai", "openrouter", "gemini"];

/** The Ollama server among the found ones: its usual port, 11434. */
export function ollamaAmong(
  servers: DetectedLocalServer[],
): DetectedLocalServer | undefined {
  return servers.find((s) => hostPort(s.apiBase).endsWith(":11434"));
}

interface NothingYetProps {
  detection: LocalServerDetection;
  /** Go on with a server that now answers. */
  onUseServer: (server: DetectedLocalServer) => void;
  /** Go on to the connection step for this provider, to paste the key. */
  onHaveKey: (provider: string) => void;
}

/**
 * For someone with no model and no key: two ways to get one. Nothing here
 * downloads or installs by itself; each button says what it does.
 */
export function NothingYet({
  detection,
  onUseServer,
  onHaveKey,
}: NothingYetProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const ollama = ollamaAmong(detection.servers);
  const downloadUrl = providers.ollama!.downloadUrl!;
  const hasModel = !!ollama?.models.some(
    (m) => (m.modelId ?? m.name) === LOCAL_ONBOARDING_CHAT_MODEL,
  );
  const ready = !!ollama && ollama.models.length > 0;

  return (
    <div
      className="flex min-w-0 flex-col gap-4 text-xs"
      data-testid="nothing-yet"
    >
      <section
        className="flex min-w-0 flex-col gap-2"
        aria-labelledby="ny-local"
      >
        <h3 id="ny-local" className="m-0 text-sm font-medium">
          Run a model on this computer
        </h3>
        <span className="break-words text-description-muted">
          Free, and nothing leaves the machine. It needs Ollama and one model.
        </span>

        <div className="font-medium">1. Install Ollama</div>
        {ollama ? (
          <span data-testid="ny-ollama-running">
            Ollama is running at {hostPort(ollama.apiBase)}.
          </span>
        ) : (
          <div>
            <Button
              variant="outline"
              onClick={() => ideMessenger.post("openUrl", downloadUrl)}
            >
              Open {downloadUrl.replace(/^https?:\/\//, "")}
            </Button>
            <span className="block break-words text-description-muted">
              Opens the download page in your browser. You install it there.
            </span>
          </div>
        )}

        <div className="font-medium">2. Download one model</div>
        <OllamaModelDownload
          title=""
          modelName={LOCAL_ONBOARDING_CHAT_MODEL}
          hasDownloaded={hasModel}
        />
        <span className="break-words text-description-muted">
          {hasModel
            ? `${LOCAL_ONBOARDING_CHAT_MODEL} is downloaded.`
            : `Pressing it runs this command in the terminal and copies it. It downloads the model ${LOCAL_ONBOARDING_CHAT_MODEL}; Ollama prints the size when it starts (this screen does not know it). Nothing is downloaded until you press it.`}
        </span>

        <div className="font-medium">3. Use it</div>
        {ready ? (
          <div>
            <Button onClick={() => onUseServer(ollama)}>
              Use Ollama ({ollama.models.length} model
              {ollama.models.length === 1 ? "" : "s"})
            </Button>
            <span className="block break-words text-description-muted">
              {foundLine(ollama)}
            </span>
          </div>
        ) : (
          <div>
            <Button
              variant="outline"
              onClick={detection.look}
              disabled={detection.status === "looking"}
            >
              {detection.status === "looking" ? "Looking…" : "Look for Ollama"}
            </Button>
            <span
              className="block break-words text-description-muted"
              data-testid="ny-ollama-status"
            >
              {detection.status === "looking"
                ? "Looking…"
                : ollama
                  ? "Ollama is running, with no model yet."
                  : "Ollama is not answering yet. Press this after steps 1 and 2."}
            </span>
          </div>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="ny-key">
        <h3 id="ny-key" className="m-0 text-sm font-medium">
          Or get an API key
        </h3>
        <span className="break-words text-description-muted">
          Making a key is free. The provider bills what you use, and your
          prompts go to it.
        </span>
        {KEY_PROVIDERS.map((id) => providers[id]!).map((p) => (
          <div
            key={p.provider}
            className="flex flex-wrap items-center gap-x-2"
            data-testid={`ny-key-${p.provider}`}
          >
            <Button
              variant="outline"
              onClick={() => ideMessenger.post("openUrl", p.apiKeyUrl!)}
            >
              Get a {p.title} key
            </Button>
            <Button variant="ghost" onClick={() => onHaveKey(p.provider)}>
              I have it
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
