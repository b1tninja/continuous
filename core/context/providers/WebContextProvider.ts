import { BaseContextProvider } from "..";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../..";

import { modelToolFetch } from "../../util/modelToolFetch";

import { fetchSearchResults } from "./webSearchBackend";

/**
 * Only offered when the user has configured a search backend
 * (see webSearchBackend.ts); it never contacts a service of ours.
 */
export default class WebContextProvider extends BaseContextProvider {
  private static DEFAULT_N = 6;

  static description: ContextProviderDescription = {
    title: "web",
    displayTitle: "Web",
    description: "Search the web with your own search endpoint",
    type: "normal",
    renderInlineAs: "",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    return await fetchSearchResults(
      extras.fullInput,
      this.options.n ?? WebContextProvider.DEFAULT_N,
      // Not `extras.fetch`: the global request headers are not the search
      // endpoint's to receive
      modelToolFetch(extras.config ?? {}),
    );
  }
}
