import { useState } from "react";
import { Button } from "../ui";

/**
 * Asks before anything is requested from openrouter.ai. Nothing here sends a
 * request: the buttons call back, and the caller decides what to do.
 */
export function OpenRouterCataloguePrompt({
  onPull,
  onNotNow,
}: {
  onPull: (dontAskAgain: boolean) => void;
  onNotNow: (dontAskAgain: boolean) => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <div
      role="region"
      aria-label="Pull model information"
      className="flex flex-col gap-2 rounded border border-solid border-description-muted p-2 text-xs"
    >
      <span className="font-medium">
        Pull the latest model information from OpenRouter?
      </span>
      <span>
        This contacts openrouter.ai once to get the public model list: names,
        context sizes and prices. No account, key or prompt is sent. Prices are
        estimates and are stored on this computer with the date. To keep it
        current without being asked, set Model information updates to Automatic
        in the Models settings.
      </span>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        <span>Don't ask again</span>
      </label>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => onPull(dontAsk)}>
          Pull now
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() => onNotNow(dontAsk)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
