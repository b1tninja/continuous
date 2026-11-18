import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import {
  classifyFetchTarget,
  urlReviewReason,
} from "../../util/fetchUrlSafety";
import { isPrivateFetchTarget } from "../../util/networkAddress";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const fetchUrlContentTool: Tool = {
  type: "function",
  displayTitle: "Read URL",
  wouldLikeTo: "fetch {{{ url }}}",
  isCurrently: "fetching {{{ url }}}",
  hasAlready: "fetched {{{ url }}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.FetchUrlContent,
    description:
      "Can be used to view the contents of a website using a URL (http or https). Returns HTML pages as markdown and text or JSON as text. Do NOT use this for files, binary downloads or credentials in URLs.",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "The URL to read",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  // Resolve before the policy check so a name that points at a private
  // address asks, and so the later connection can reuse that answer.
  preprocessArgs: async (args) => {
    const raw = args.url;
    if (typeof raw !== "string") return {};
    let hostname: string;
    try {
      hostname = new URL(raw).hostname;
    } catch {
      return {};
    }
    // Also true for a name that resolves to nothing here and has no real
    // top-level domain: behind a proxy it may be an internal host
    const { addresses, nonPublic } = await classifyFetchTarget(hostname);
    return { nonPublic, resolvedAddresses: addresses };
  },
  // A URL on loopback, a private network or a local name always asks, even
  // when fetching is auto-approved: the model may have been steered there.
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    args: Record<string, unknown>,
    processedArgs?: Record<string, unknown>,
  ): ToolPolicy => {
    if (basePolicy === "disabled") return "disabled";
    // Also a URL that carries credentials or a long encoded value: the shape
    // of data being moved out through the address. Ask-only, never loosens.
    return isPrivateFetchTarget(args.url, processedArgs) ||
      urlReviewReason(args.url)
      ? "allowedWithPermission"
      : basePolicy;
  },
  systemMessageDescription: {
    prefix: `To fetch the content of a URL, use the ${BuiltInToolNames.FetchUrlContent} tool. For example, to read the contents of a webpage, you might respond with:`,
    exampleArgs: [["url", "https://example.com"]],
  },
  toolCallIcon: "GlobeAltIcon",
};
