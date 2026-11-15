import { ToolImpl } from ".";
import type { ContextItem } from "../..";
import { createSpotlight, type Spotlight } from "../permissions/spotlight";
import { getUrlContextItems } from "../../context/providers/URLContextProvider";
import { TRUNCATION_ITEM_NAME } from "../../util/fetchedText";
import { getStringArg } from "../parseArgs";

const DEFAULT_FETCH_URL_CHAR_LIMIT = 20000;

export const fetchUrlContentImpl: ToolImpl = async (args, extras) => {
  const url = getStringArg(args, "url");

  // Scheme, userinfo and secret checks, the byte ceiling, the deadline and
  // the content-type rules are in getUrlContextItems
  const contextItems = await getUrlContextItems(url, extras.fetch, {
    guardRedirects: true,
  });

  // Where the page was really read, after any redirects
  const finalUrl =
    contextItems.find((i) => i.uri?.type === "url")?.uri?.value ?? url;

  // Track truncated content
  const truncatedUrls: string[] = [];

  // Check and truncate each context item
  const processedItems = contextItems.map((item) => {
    if (item.content.length > DEFAULT_FETCH_URL_CHAR_LIMIT) {
      truncatedUrls.push(finalUrl);
      return {
        ...item,
        content: item.content.substring(0, DEFAULT_FETCH_URL_CHAR_LIMIT),
      };
    }
    return item;
  });

  // Add truncation warning if needed
  if (truncatedUrls.length > 0) {
    processedItems.push({
      name: TRUNCATION_ITEM_NAME,
      description: "",
      content: `The content from ${truncatedUrls.join(", ")} was truncated because it exceeded the ${DEFAULT_FETCH_URL_CHAR_LIMIT} character limit. If you need more content, consider fetching specific sections or using a more targeted approach.`,
    });
  }

  return spotlightEnabled(extras.config?.experimental?.spotlightUntrusted)
    ? spotlightItems(processedItems, finalUrl)
    : processedItems;
};

/** Off unless the setting or CONTINUOUS_SPOTLIGHT_UNTRUSTED=1 says so. */
export function spotlightEnabled(setting: boolean | undefined): boolean {
  return setting === true || process.env.CONTINUOUS_SPOTLIGHT_UNTRUSTED === "1";
}

/** The item's own name once the title is inside the markers. */
const WRAPPED_ITEM_NAME = "Fetched web page";

let session: Spotlight | undefined;

/**
 * Put each fetched page between the session's boundary markers, with the
 * sentence that explains them ahead of the first. The page's title and URL
 * go inside the markers too: the title is the page's own text, and a URL
 * that came back from a redirect or a search result is not the model's. The
 * item's own name then no longer carries page text. Items that are not page
 * text (the truncation warning) are left as they are.
 */
export function spotlightItems(
  items: ContextItem[],
  source: string,
  spotlight: Spotlight = (session ??= createSpotlight()),
): ContextItem[] {
  let explained = false;
  return items.map((item) => {
    if (item.name === TRUNCATION_ITEM_NAME) return item;
    const header = [
      item.name ? `title: ${item.name}` : "",
      item.description ? `url: ${item.description}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const wrapped = spotlight.wrap(
      header ? `${header}\n\n${item.content}` : item.content,
      { source },
    );
    const content = explained
      ? wrapped
      : `${spotlight.instruction}\n\n${wrapped}`;
    explained = true;
    return { ...item, name: WRAPPED_ITEM_NAME, description: source, content };
  });
}
