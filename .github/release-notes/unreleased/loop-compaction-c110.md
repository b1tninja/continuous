## Behaviour changes

- A long agent loop on a local server now compacts when the conversation reaches the context limit, instead of dropping the oldest messages between two tool rounds. A summary already prepared is used at once; otherwise one is made from the conversation the server still holds ("Generating conversation summary" shows while it runs, and Stop stops it). Loop items and resumed turns do the same. Nothing asks, and the oldest-messages drop is still the fallback when planned compaction is off (`contextManagement.plannedCompaction: false`), after Continue anyway at the compaction hold, or when the summary fails. On cloud providers only a summary that is already prepared is used.
- Planned compaction can now cut inside one long turn, at a tool round, so a loop that started from a single message can be compacted.
- The compaction hold now comes before the oldest messages are dropped on a local server: it compared the prompt with 85% of the window, while the drop starts at 85% of the window less the 5% headroom of the token calibration.

## Fixes

- On a local server, once a conversation no longer fit the window, the point where the oldest messages were cut moved by one message every few requests, so the whole conversation was read again (about 70 s at 330k tokens) with "Likely cause: message 2 changed: an answer; the oldest messages were dropped to fit". The token calibration moved the budget on every request; it now changes the budget only when the measured ratio moves more than 2.5%.
- The prompt cache miss notice now says when a miss came from dropping the oldest messages, and when that happened between an agent's tool rounds, and offers Compact now.
