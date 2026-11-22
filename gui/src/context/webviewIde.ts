import type { IDE } from "core";
import type { FromWebviewProtocol } from "core/protocol";
import { MessageIde } from "core/protocol/messenger/messageIde";

type Reply =
  { status: "success"; content: any } | { status: "error"; error: string };

/**
 * The IDE as the webview reaches it. `subprocess` starts a process on the
 * host and is core's alone: the editors refuse it from the panel, so it is
 * not sent.
 */
export function webviewIde(
  request: (
    messageType: keyof FromWebviewProtocol,
    data: any,
  ) => Promise<Reply>,
): IDE {
  return new MessageIde(
    async (messageType, data) => {
      if (messageType === "subprocess") {
        throw new Error("The panel cannot start a process on the host.");
      }
      const result = await request(
        messageType as keyof FromWebviewProtocol,
        data,
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }
      return result.content;
    },
    () => {},
  );
}
