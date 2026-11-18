import { getProxy, shouldBypassProxy } from "@continuedev/fetch";

import type { RequestOptions } from "../../..";

/**
 * Chromium launch flags for the user's network settings. Chromium reads the OS
 * certificate store itself, so a TLS-inspecting root installed there already
 * works. What it cannot see is the proxy from `requestOptions` or the
 * environment, and `verifySsl: false`. A CA bundle file cannot be handed to it
 * by flag; such a site needs the root in the OS store.
 *
 * Proxy credentials in the URL are not passed on (Chromium takes none in
 * `--proxy-server`); a proxy that needs a login is not supported here.
 */
export function chromiumNetworkArgs(
  startUrl: URL,
  requestOptions: RequestOptions | undefined,
): string[] {
  const args: string[] = [];
  const proxy = getProxy(startUrl.protocol, requestOptions);
  if (proxy && !shouldBypassProxy(startUrl.hostname, requestOptions)) {
    try {
      const parsed = new URL(proxy);
      args.push(`--proxy-server=${parsed.protocol}//${parsed.host}`);
    } catch {
      // Not a URL: leave Chromium on its own settings rather than guess.
    }
  }
  if (requestOptions?.verifySsl === false) {
    args.push("--ignore-certificate-errors");
  }
  return args;
}
