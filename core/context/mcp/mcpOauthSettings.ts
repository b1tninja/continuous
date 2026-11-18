import type { McpOauthSettings } from "../..";
import type { McpOauthOptions } from "./MCPOauth";

/** Map the per-server `oauth` config block to the provider options. */
export function oauthOptionsFromSettings(
  settings: McpOauthSettings | undefined,
): Pick<
  McpOauthOptions,
  "callbackPort" | "clientId" | "clientSecret" | "redirectHost"
> {
  return {
    callbackPort: settings?.callbackPort,
    clientId: settings?.clientId,
    clientSecret: settings?.clientSecret,
    redirectHost: settings?.redirectHost,
  };
}
