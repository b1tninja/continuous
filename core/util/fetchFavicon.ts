import { JSDOM } from "jsdom";

import type { RequestOptions } from "..";

import { decodeBytes } from "./boundedBody";
import { FetchRefusedError, type FetchOrigin } from "./fetchRecord";
import { guardedWebRequest } from "./guardedFetch";
import { networkFetchWith } from "./networkFetch";
import { readUserFetchLimits } from "./userFetchLimits";

/**
 * The favicon shown beside an `@url` item or a docs site. Both requests go
 * through the shared guard (`guardedWebRequest`) with the transport settings
 * only, never the global request headers, and with small limits of their own
 * (plans/research/web-fetch-deep-dive.md, section 7.2).
 */

/** An icon larger than this is not used. */
export const FAVICON_MAX_BYTES = 256 * 1024;
/** Deadline for each of the two requests (page, icon). */
export const FAVICON_DEADLINE_MS = 5_000;

/**
 * Image types an icon may have. SVG is not one: it can carry script, and the
 * data URI is rendered in the chat webview.
 */
const ICON_TYPES = new Set([
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

/** An image type from the first bytes, for a server that sends none. */
function sniffImage(data: Uint8Array): string | undefined {
  const at = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (at(0, 0, 1, 0)) return "image/x-icon";
  if (at(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    at(0x52, 0x49, 0x46, 0x46) &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function iconType(contentType: string | null): string | undefined {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ICON_TYPES.has(type) ? type : undefined;
}

export async function findFaviconPath(
  url: URL,
  requestOptions?: RequestOptions,
  origin: FetchOrigin = "person",
): Promise<string | undefined> {
  const baseUrl = `${url.protocol}//${url.hostname}`;

  try {
    const response = await guardedWebRequest(new URL(baseUrl), {
      purpose: "favicon",
      origin,
      fetchFn: networkFetchWith(requestOptions),
      // Only the page's <head> matters; the person's cap bounds it
      maxBytes: readUserFetchLimits().maxBytes,
      deadlineMs: FAVICON_DEADLINE_MS,
      guard: { stayOnStartHost: true },
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = decodeBytes(
      response.data,
      response.contentType,
      response.truncated,
    );
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Look for favicon in <link> tags
    const linkTags = document.querySelectorAll('link[rel*="icon"]');

    for (const link of linkTags) {
      const href = link.getAttribute("href");
      if (href) {
        return new URL(href, baseUrl).toString();
      }
    }
  } catch (error) {
    console.debug(`Failed to fetch favicon for ${baseUrl}: ${error}`);
  }

  console.debug(`Failed to find favicon for ${baseUrl}`);
  return undefined;
}

export async function getFaviconBase64(
  faviconUrl: string,
  requestOptions?: RequestOptions,
  /** Host of the page that linked the icon: only it may be non-public. */
  pageHost?: string,
): Promise<string | undefined> {
  try {
    const target = new URL(faviconUrl);
    const response = await guardedWebRequest(target, {
      purpose: "favicon",
      origin: "page",
      fetchFn: networkFetchWith(requestOptions),
      maxBytes: FAVICON_MAX_BYTES,
      deadlineMs: FAVICON_DEADLINE_MS,
      guard: {
        stayOnStartHost: true,
        refuseNonPublicStart: target.hostname !== pageHost,
      },
      accept: ({ headers }) => {
        const type = headers.get("content-type");
        // No type: decided from the bytes below
        if (type && !iconType(type)) {
          throw new FetchRefusedError(
            `Refused: the icon is ${type.split(";")[0]}, not a raster image`,
          );
        }
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    if (response.truncated) {
      throw new Error(`the icon is larger than ${FAVICON_MAX_BYTES} bytes`);
    }
    const mimeType =
      iconType(response.contentType) ?? sniffImage(response.data);
    if (!mimeType) {
      throw new Error("the icon has no image type and is not a known image");
    }
    const base64 = Buffer.from(response.data).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.debug(`Failed to fetch favicon from ${faviconUrl}: ${error}`);
    return undefined;
  }
}

export async function fetchFavicon(
  url: URL,
  requestOptions?: RequestOptions,
): Promise<string | undefined> {
  const faviconPath = await findFaviconPath(url, requestOptions);
  if (faviconPath) {
    return getFaviconBase64(faviconPath, requestOptions, url.hostname);
  }
  return undefined;
}
