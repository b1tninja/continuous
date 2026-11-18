import {
  fetchwithRequestOptions,
  originsOf,
  requestOptionsForUrl,
} from "@continuedev/fetch";
import type { ContinueConfig, FetchFunction } from "..";

/**
 * The `fetch` handed to tools whose URL the model chooses (`fetch_url_content`).
 * The top-level `requestOptions` of a config are merged into every model, so
 * their `headers` (a gateway or proxy token) and `extraBodyProperties` belong
 * to the endpoints the person configured. They are sent only to the origins
 * of the configured models' `apiBase`; any other host gets the transport
 * settings (proxy, CA bundle, certificate, TLS) and nothing else.
 */
export function modelToolFetch(
  config: Partial<Pick<ContinueConfig, "requestOptions" | "modelsByRole">>,
): FetchFunction {
  return (url, init) => {
    const models = Object.values(config.modelsByRole ?? {}).flat();
    const allowed = originsOf(models.map((m) => m?.apiBase));
    return fetchwithRequestOptions(
      url,
      init,
      requestOptionsForUrl(config.requestOptions, url, allowed),
    );
  };
}
