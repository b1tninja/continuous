// Where things are in Settings TODAY. A journey (src/walk.mjs) says what a
// person wants in order; this map says how each of those intents is done in
// the current layout. When Settings is rearranged, this is the file to change:
// the journeys stay as they are, so the numbers stay comparable.
//
// An intent maps to
//   a list of actions   done in order; each click, fill, select, check, press
//                       and ide action is one step, see and gone are not;
//   an empty list       nothing to do here (the layout already has it right);
//   null                cannot be done in the page in this layout. A journey
//                       that got here by opening a file ends in that file.
//
// A target is found by what the page already exposes: { testId }, { role,
// name }, { label }, { text }, or { css } as a last resort, optionally
// { within: <target> }. "$name" is replaced by the journey's input of that name.

const SETUP = { testId: "provider-setup-flow" };
const CHAT_ROLE = { testId: "model-role-chat" };

export const LAYOUT = {
  name: "2026-11: MCP servers at the end of the Tools tab; Models and Providers are two tabs",
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
      { do: "click", target: { testId: "tab-tools" } },
    ],
    "see the MCP server list": [
      { do: "see", target: { role: "heading", name: "MCP Servers" } },
    ],
    "start adding a server": [
      { do: "click", target: { role: "button", name: "Add MCP server" } },
    ],
    // "+" writes a template file and opens it; the rest is done in the editor
    "give the server's command line": null,
    "save the server": null,
    "see the server listed": null,

    "go to where models are": [
      { do: "click", target: { testId: "tab-models" } },
    ],
    "start adding a model": [
      { do: "click", target: { role: "button", name: "Manage models" } },
    ],
    // Anthropic is the provider the form opens on
    "choose the provider": [
      {
        do: "see",
        target: { within: SETUP, role: "button", name: "$provider" },
      },
    ],
    "enter the API key": [
      {
        do: "fill",
        target: { within: SETUP, label: "API key" },
        value: "$apiKey",
      },
    ],
    "test the connection": [
      {
        do: "click",
        target: { within: SETUP, role: "button", name: "Test connection" },
      },
      { do: "see", target: { within: SETUP, text: "Connected." } },
    ],
    "choose the model": [
      { do: "click", target: { within: SETUP, role: "button", name: "Next" } },
      {
        do: "check",
        target: { within: SETUP, role: "checkbox", name: "$model" },
      },
    ],
    "save the model": [
      {
        do: "click",
        target: { within: SETUP, role: "button", name: "Review" },
      },
      { do: "click", target: { within: SETUP, role: "button", name: "Save" } },
      { do: "gone", target: SETUP },
    ],
    "select the model for chat": [
      { do: "click", target: { within: CHAT_ROLE, role: "button" } },
      { do: "click", target: { role: "option", name: "$model" } },
    ],
    "see the model selected for chat": [
      { do: "see", target: { within: CHAT_ROLE, text: "$model" } },
    ],
  },
};
