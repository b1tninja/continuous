## New

- The chat diagnostic log, opened from the button under the input. It keeps the latest 80 events in the webview and does not write them into the session: an empty stop, a context-window refusal, a tool error, a compile failure, and a provider error.

## Fixes

- A turn that finishes with no answer and no tool call says so. Reasoning from that turn stays in the thinking block. The message names the output cap when that is why it stopped.
- A Claude request whose output cap is not above the thinking budget is raised by 4096 tokens, so the provider accepts the call.
