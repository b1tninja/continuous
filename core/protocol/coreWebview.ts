import { ToCoreFromIdeOrWebviewProtocol } from "./core.js";
import type { ModelLimitsProtocol } from "./modelLimits.js";
import { ToWebviewFromIdeOrCoreProtocol } from "./webview.js";

export type ToCoreFromWebviewProtocol = ToCoreFromIdeOrWebviewProtocol &
  ModelLimitsProtocol & {
    didChangeSelectedProfile: [{ id: string }, void];
  };
export type ToWebviewFromCoreProtocol = ToWebviewFromIdeOrCoreProtocol;
