// Where things are in Settings TODAY. A journey (src/walk.mjs) says what a
// person wants in order; this map says how each of those intents is done in
// the current layout. When Settings is rearranged, this is the file to change:
// the journeys stay as they are, so the numbers stay comparable.
//
// An intent maps to
//   a list of actions   done in order; each click, fill, paste, select, check,
//                       press and ide action is one step, see and gone are not;
//   an empty list       nothing to do here (the layout already has it right);
//   null                cannot be done in the page in this layout. A journey
//                       that got here by opening a file ends in that file.
//
// A target is found by what the page already exposes: { testId }, { role,
// name }, { label }, { text }, or { css } as a last resort, optionally
// { within: <target> }. "$name" is replaced by the journey's input of that name.

const SETUP = { testId: "provider-setup-flow" };
const MCP_DIALOG = { testId: "mcp-server-dialog" };
const CHAT_ROLE = { testId: "model-role-chat" };

export const LAYOUT = {
  name: "2026-11: MCP servers is a tab with an Add dialog; Add a model asks what you have, then Use for",
  intents: {
    // The gear in the editor's view title is outside the page. It sends this
    // message (extensions/vscode/src/commands.ts, continuous.openConfigPage).
    "open settings": [
      {
        do: "ide",
        message: "navigateTo",
        data: { path: "/config", toggle: false },
      },
    ],

    "go to where MCP servers are": [
      { do: "click", target: { testId: "tab-mcp" } },
    ],
    "see the MCP server list": [
      { do: "see", target: { role: "heading", name: "MCP servers" } },
    ],
    "start adding a server": [
      { do: "click", target: { role: "button", name: "Add MCP server" } },
    ],
    // A paste into the empty box fills the form by itself. Typing the line
    // instead takes one more click, on "Fill in the form".
    "give the server's command line": [
      {
        do: "paste",
        target: {
          within: MCP_DIALOG,
          label: "Paste a command, a URL, or a JSON snippet",
        },
        value: "$command",
      },
      { do: "see", target: { within: MCP_DIALOG, testId: "mcp-paste-note" } },
    ],
    // "Where to save it" has nothing chosen and Save refuses without it. A
    // server for all projects starts at once, so Save asks before it runs the
    // command. One for the workspace is not asked about, but does not start
    // until the editor's question about the folder is answered, outside the page.
    "save the server": [
      { do: "check", target: { testId: "mcp-scope-user" } },
      { do: "click", target: { testId: "mcp-save" } },
      { do: "click", target: { testId: "mcp-confirm-run-yes" } },
      { do: "gone", target: MCP_DIALOG },
    ],
    "see the server listed": [
      { do: "see", target: { testId: "mcp-server-$serverName" } },
    ],

    // Settings opens on Models the first time, and whenever no chat model is
    // selected. Someone who last used another tab has one click more.
    "go to where models are": [
      { do: "see", target: { role: "heading", name: "Models" } },
    ],
    "start adding a model": [
      { do: "click", target: { role: "button", name: "Manage models" } },
    ],
    // "What do you have?" comes first; an API key leads to the provider
    // list, which opens on Anthropic
    "choose the provider": [
      { do: "click", target: { within: SETUP, testId: "door-api-key" } },
      {
        do: "see",
        target: { within: SETUP, role: "button", name: "$provider" },
      },
    ],
    "enter the API key": [
      {
        do: "paste",
        target: { within: SETUP, label: "API key" },
        value: "$apiKey",
      },
    ],
    // Runs by itself after a paste
    "test the connection": [
      { do: "see", target: { within: SETUP, text: "Connected." } },
    ],
    "choose the model": [
      { do: "click", target: { within: SETUP, role: "button", name: "Next" } },
      {
        do: "check",
        target: { within: SETUP, role: "checkbox", name: "$model" },
      },
    ],
    // "Use for" is on the way to the review, with Chat already ticked. It
    // puts the first ticked model to use, and three are ticked to start with.
    "save the model": [
      { do: "click", target: { within: SETUP, role: "button", name: "Next" } },
      {
        do: "check",
        target: { within: SETUP, role: "checkbox", name: "Chat" },
      },
      {
        do: "click",
        target: { within: SETUP, role: "button", name: "Review" },
      },
      { do: "click", target: { within: SETUP, role: "button", name: "Save" } },
      { do: "gone", target: SETUP },
    ],
    // The save selected the first of the added models (Claude Fable 5.1),
    // not this one. Unticking the two above it before the save costs the same.
    "select the model for chat": [
      { do: "click", target: { within: CHAT_ROLE, role: "button" } },
      { do: "click", target: { role: "option", name: "$model" } },
    ],
    "see the model selected for chat": [
      { do: "see", target: { within: CHAT_ROLE, text: "$model" } },
    ],
  },
};
