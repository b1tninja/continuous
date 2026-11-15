import type { ContextItem, FetchFunction } from "core/index.js";
import { fetchUrlContentTool } from "core/tools/definitions/fetchUrlContent.js";
import { fetchUrlContentImpl } from "core/tools/implementations/fetchUrlContent.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { modelToolFetch } from "core/util/modelToolFetch.js";

import { getServiceSync, SERVICE_NAMES } from "../services/index.js";
import type { ConfigServiceState } from "../services/types.js";
import {
  parseEnvNumber,
  truncateOutputFromEnd,
} from "../util/truncateOutput.js";

import { Tool } from "./types.js";

// Output truncation defaults
const DEFAULT_FETCH_MAX_CHARS = 20000;

function getFetchMaxChars(): number {
  return parseEnvNumber(
    process.env.CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH,
    DEFAULT_FETCH_MAX_CHARS,
  );
}

/**
 * The fetch the IDE gives this tool (`modelToolFetch`): the pinned `lookup`
 * of a checked address is honoured, and proxy, CA bundle, certificate and
 * TLS settings from the person's `requestOptions` apply. Their `headers` go
 * only to the origins of the configured models. Without a loaded config the
 * transport defaults (HTTPS_PROXY, the system CA store) still apply.
 */
export function guardedToolFetch(): FetchFunction {
  let config: ConfigServiceState["config"] = null;
  try {
    config =
      getServiceSync<ConfigServiceState>(SERVICE_NAMES.CONFIG).value?.config ??
      null;
  } catch {
    // no config service in this process
  }
  return modelToolFetch({
    requestOptions: config?.requestOptions,
    modelsByRole: { chat: (config?.models ?? []) as never[] },
  });
}

export const fetchTool: Tool = {
  name: "Fetch",
  displayName: "Fetch",
  description:
    "Fetches content from a URL, converts to markdown, and handles long content with truncation",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  evaluateToolCallPolicy: (basePolicy, args) =>
    fetchUrlContentTool.evaluateToolCallPolicy?.(basePolicy, args) ??
    basePolicy,
  preprocess: async (args) => {
    // Resolve before the permission check so a private address asks.
    await fetchUrlContentTool.preprocessArgs?.(args, { ide: {} as never });
    return {
      preview: [
        {
          type: "text",
          content: `Will fetch: ${args.url}`,
        },
      ],
      args,
    };
  },
  run: async (args: { url: string }): Promise<string> => {
    const { url } = args;

    try {
      // Suppress console errors from JSDOM CSS parsing
      const originalConsoleError = console.error;
      console.error = () => {};

      // Use the core fetchUrlContent implementation
      const contextItems = await fetchUrlContentImpl(
        { url },
        { fetch: guardedToolFetch() },
      );

      // Restore console.error
      console.error = originalConsoleError;

      if (contextItems.length === 0) {
        throw new ContinueError(
          ContinueErrorReason.Unspecified,
          `Could not fetch content from ${url}`,
        );
      }

      // Format the results for CLI display
      const combinedContent = contextItems
        .filter((item: ContextItem) => item.name !== "Truncation warning")
        .map((item: ContextItem) => item.content)
        .join("\n\n");

      // Apply CLI-level truncation
      const maxChars = getFetchMaxChars();
      const { output: truncatedOutput } = truncateOutputFromEnd(
        combinedContent,
        maxChars,
        "fetched content",
      );

      return truncatedOutput;
    } catch (error) {
      if (error instanceof ContinueError) {
        throw error;
      }
      throw new Error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};
