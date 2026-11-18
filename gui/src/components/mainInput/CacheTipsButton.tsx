import { selectCacheSetting } from "../../redux/selectors/selectCacheSetting";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import type { BedrockGlobalProfileStatus } from "core/protocol/core";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { dismissCacheTip } from "../../redux/slices/uiSlice";
import { cacheTipKey, cacheTips } from "../../util/cacheTips";
import { Popover, PopoverButton, PopoverPanel } from "../ui";
import { HoverButton } from "./InputToolbar/HoverItem";
import { useToolbarWidthTier } from "./InputToolbar/widthTier";

/**
 * A small warning icon in the toolbar that appears only when there is advice
 * about the model or cache settings in use, for example that a regional Bedrock
 * endpoint costs 10% more than a global one. Clicking it lists the tips, each
 * with what to change and a way to dismiss it. Dismissals are remembered per
 * model, so a tip the user has decided to live with does not come back.
 */
export function useCacheTips() {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector(selectCacheSetting);
  const dismissed = useAppSelector((s) => s.ui.dismissedCacheTips);
  const ledger = useAppSelector((s) => s.session.promptCache?.ledger);
  const failures = useAppSelector((s) => s.session.promptCache?.failures);
  const ideMessenger = useContext(IdeMessengerContext);
  // Whether the account lists a global profile, asked once per Bedrock model
  // that uses a regional ID. Until it answers, the tip suggests the global ID.
  const [globalProfiles, setGlobalProfiles] = useState<
    Record<string, BedrockGlobalProfileStatus>
  >({});
  const regionalBedrock =
    model?.provider?.toLowerCase() === "bedrock" &&
    /^(us|eu|apac|jp|au|ca)\./i.test(model.model);
  useEffect(() => {
    if (!model || !regionalBedrock || globalProfiles[model.title]) return;
    const title = model.title;
    let live = true;
    ideMessenger
      .request("bedrock/globalProfile", { title })
      .then((res) => {
        const status = res.status === "success" ? res.content : "unknown";
        if (live) setGlobalProfiles((prev) => ({ ...prev, [title]: status }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [model?.title, model?.model, regionalBedrock, ideMessenger]);

  const tips = useMemo(
    () =>
      cacheTips(
        model,
        setting,
        ledger,
        failures,
        model ? globalProfiles[model.title] : undefined,
      ).filter((t) => !dismissed?.[cacheTipKey(model?.title ?? "", t.id)]),
    [model, setting, dismissed, ledger, failures, globalProfiles],
  );

  const hasWarning = tips.some((t) => t.severity === "warning");
  return { dispatch, model, tips, hasWarning };
}

/**
 * The tips, in the row under the prompt: the icon and how many there are,
 * with "tips" spelled out when the row is wide. It takes the place of the
 * old "..." menu, whose other entries are now in the row itself.
 */
export function CacheTipsButton() {
  const { dispatch, model, tips, hasWarning } = useCacheTips();
  const tier = useToolbarWidthTier();
  if (!model || tips.length === 0) return null;
  const count = `${tips.length} tip${tips.length === 1 ? "" : "s"}`;

  return (
    <Popover className="relative flex flex-none">
      <PopoverButton
        as={HoverButton}
        data-testid="cache-tips-button"
        aria-label={`${count} about this model${hasWarning ? " (needs attention)" : ""}`}
        className="flex-none gap-0.5 px-0.5 [font-size:inherit] tabular-nums"
      >
        <ExclamationTriangleIcon
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 ${hasWarning ? "text-warning" : "text-description"}`}
        />
        <span data-testid="cache-tips-count" aria-hidden="true">
          {tier === "wide" ? count : tips.length}
        </span>
      </PopoverButton>
      <PopoverPanel
        anchor="top start"
        data-testid="cache-tips-panel"
        className="z-[200000] max-w-80 rounded border border-solid border-border bg-vsc-input-background p-2 text-xs text-foreground shadow-md"
      >
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {tips.map((tip) => (
            <li key={tip.id} data-testid={`cache-tip-${tip.id}`}>
              <div className="font-semibold">{tip.title}</div>
              <div className="mt-0.5 text-description">{tip.body}</div>
              {tip.suggestion && (
                <code
                  data-testid={`cache-tip-${tip.id}-suggestion`}
                  className="mt-1 block rounded bg-transparent px-1 py-0.5 text-[11px] break-all select-all"
                >
                  {tip.suggestion}
                </code>
              )}
              <button
                type="button"
                data-testid={`cache-tip-${tip.id}-dismiss`}
                onClick={() =>
                  dispatch(
                    dismissCacheTip({ key: cacheTipKey(model.title, tip.id) }),
                  )
                }
                className="mt-1 cursor-pointer border-none bg-transparent p-0 text-xs text-description-muted hover:text-foreground"
              >
                Don't show again for this model
              </button>
            </li>
          ))}
        </ul>
      </PopoverPanel>
    </Popover>
  );
}
