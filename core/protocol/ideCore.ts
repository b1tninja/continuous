import { ToCoreFromIdeOrWebviewProtocol } from "./core.js";
import { ToIdeFromWebviewOrCoreProtocol } from "./ide.js";

export type ToIdeFromCoreProtocol = ToIdeFromWebviewOrCoreProtocol & {
  /**
   * `exec` on the host with no policy decision: for core's own callers
   * (IDE.subprocess). The webview renders what models and web pages wrote, so
   * it may not send this; the editors refuse it from the panel.
   */
  subprocess: [{ command: string; cwd?: string }, [string, string]];
};
export type ToCoreFromIdeProtocol = ToCoreFromIdeOrWebviewProtocol;
