import { ToolImpl } from ".";
import type { ContextItem } from "../..";
import { createSpotlight, type Spotlight } from "../permissions/spotlight";
import { getUrlContextItems } from "../../context/providers/URLContextProvider";
import { TRUNCATION_ITEM_NAME } from "../../util/fetchedText";
import {
  browserToolCandidate,
  findBrowserTool,
} from "../../util/web/browserTools";
import {
  OUTCOME_ITEM_NAME,
  outcomeItem,
  WebOutcomeError,
} from "../../util/web/fetchOutcome";
import type { BrowserTail } from "../../util/web/outcomes";
import { getStringArg } from "../parseArgs";
import { hostTrusted } from "../permissions/askProtections";
import { readUserTrustedDomains } from "../permissions/userTrustedDomains";

const DEFAULT_FETCH_URL_CHAR_LIMIT = 20000;

export const fetchUrlContentImpl: ToolImpl = async (args, extras) => {
  const url = getStringArg(args, "url");

  // TODO(WB42): the repeat guard answers a repeated call from the session's
  // record (and refuses the third with `repeat`) before anything is fetched.

  // A host the person trusts may be fetched without a review (B56), so it
  // cannot hand the request to a host they do not trust.
  const trusted = readUserTrustedDomains();
  let startHost = "";
  try {
    startHost = new URL(url).hostname;
  } catch {
    // the fetch below reports a bad URL
  }
  const confined = trusted.length > 0 && hostTrusted(startHost, trusted);

  // Scheme, userinfo and secret checks, the byte ceiling, the deadline and
  // the content-type rules are in getUrlContextItems
  // and the item starts with the fetch's provenance line
  let contextItems: ContextItem[];
  try {
    contextItems = await getUrlContextItems(url, extras.fetch, {
      guardRedirects: true,
      callId: extras.toolCallId,
      browser: browserTail(extras.config?.tools),
      ...(confined
        ? { allowRedirectHost: (h: string) => hostTrusted(h, trusted) }
        : {}),
    });
  } catch (e) {
    // A typed outcome is a normal result, never a thrown error, so the model
    // reads whether a retry can help (section 6.1); `status` carries the code
    if (e instanceof WebOutcomeError) {
      return [outcomeItem(e.outcome, e.record, url)];
    }
    throw e;
  }

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
  // TODO(WB39): a page larger than the window becomes the `partial` outcome
  // (`partialOutcome`: first window, outline and a content-store id), replacing
  // this cut and its warning.
  if (truncatedUrls.length > 0) {
    processedItems.push({
      name: TRUNCATION_ITEM_NAME,
      description: "",
      content: `The content from ${truncatedUrls.join(", ")} was truncated because it exceeded the ${DEFAULT_FETCH_URL_CHAR_LIMIT} character limit. If you need more content, consider fetching specific sections or using a more targeted approach.`,
    });
  }

  const withStatus = processedItems.map((item) =>
    item.name === TRUNCATION_ITEM_NAME ? item : { ...item, status: "ok" },
  );
  return spotlightEnabled(extras.config?.experimental?.spotlightUntrusted)
    ? spotlightItems(withStatus, finalUrl)
    : withStatus;
};

/**
 * The `needs-js` tail from the tools this config offers: a Playwright-style
 * server's registered names (tail A), else none (tail C).
 */
// TODO(WB44): tail B (configured but not offered) needs the configured MCP
// servers, and the tool list of the session's mode rather than the config's.
export function browserTail(
  tools: Parameters<typeof browserToolCandidate>[0][] | undefined,
): BrowserTail {
  if (!tools?.length) return { kind: "none" };
  const found = findBrowserTool(tools.map(browserToolCandidate));
  if (found.kind === "offered") {
    return {
      kind: "offered",
      navigate: found.navigate,
      ...(found.snapshot && { snapshot: found.snapshot }),
    };
  }
  return found.kind === "configured"
    ? { kind: "configured", server: found.server }
    : { kind: "none" };
}

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
    if (item.name === TRUNCATION_ITEM_NAME || item.name === OUTCOME_ITEM_NAME) {
      return item;
    }
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
