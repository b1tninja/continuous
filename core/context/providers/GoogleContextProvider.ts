import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../../index.js";
import { decodeBytes } from "../../util/boundedBody.js";
import { guardedWebRequest } from "../../util/guardedFetch.js";
import { modelToolFetch } from "../../util/modelToolFetch.js";
import { readUserFetchLimits } from "../../util/userFetchLimits.js";
import { BaseContextProvider } from "../index.js";

class GoogleContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "google",
    displayTitle: "Google",
    description: "Attach the results of a Google search",
    type: "query",
  };

  private _serperApiKey: string;

  constructor(options: { serperApiKey: string }) {
    super(options);
    this._serperApiKey = options.serperApiKey;
  }

  get deprecationMessage() {
    return "The Google context provider is now deprecated and will be removed in a later version. Please consider using github.com/jae-jae/g-search-mcp instead.";
  }

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const url = new URL("https://google.serper.dev/search");

    const payload = JSON.stringify({ q: query });
    const headers = {
      "X-API-KEY": this._serperApiKey,
      "Content-Type": "application/json",
    };

    // The shared guard, the person's byte cap and deadline, and no global
    // request headers: the key header is the only credential sent, and it is
    // dropped if a redirect leaves the origin
    const limits = readUserFetchLimits();
    const response = await guardedWebRequest(url, {
      purpose: "search",
      origin: "config",
      fetchFn: modelToolFetch(extras.config ?? {}),
      init: { method: "POST", headers, body: payload },
      maxBytes: limits.maxBytes,
      deadlineMs: limits.deadlineMs,
      guard: { originHeaders: ["x-api-key"] },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Google search results (HTTP ${response.status})`,
      );
    }
    if (response.truncated) {
      throw new Error(
        `Failed to fetch Google search results: the response is larger than ${limits.maxBytes} bytes`,
      );
    }
    const results = decodeBytes(response.data, response.contentType, false);
    try {
      const parsed = JSON.parse(results);
      let content = `Google Search: ${query}\n\n`;
      const answerBox = parsed.answerBox;

      if (answerBox) {
        content += `Answer Box (${answerBox.title}): ${answerBox.answer}\n\n`;
      }

      for (const result of parsed.organic) {
        content += `${result.title}\n${result.link}\n${result.snippet}\n\n`;
      }

      return [
        {
          content,
          name: "Google Search",
          description: "Google Search",
        },
      ];
    } catch (e) {
      // Not the body: it is the service's text, not ours to show
      throw new Error("Failed to parse Google search results");
    }
  }
}

export default GoogleContextProvider;
