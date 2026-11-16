## New

- **Planned compaction on local servers.** Once a conversation passes 70% of the model's context window, the point where a compaction would cut is fixed and stays put as the conversation grows. After 10 seconds with nothing streaming and no typing, the summary of everything before that point is made in the background as a separate request; nothing in the chat changes. **Compact now** then applies it at once, with no wait and no second summary request, and the newest turns stay word for word. A short first request is quoted word for word above the summary. Typing, sending a message or a running tool stops the background summary, and it is tried again at the next pause. Editing an earlier message throws the prepared summary away.
- **`contextManagement.plannedCompaction`** in a model's config turns this on or off. It is on by default for a server on this machine or network, and off for cloud providers, where the background request costs money. Set it to `false` to turn it off, or `true` to use it with a cloud provider.

## Behaviour changes

- Compacted turns are still kept in the saved session and shown above the summary, as before. With a prepared summary, **Compact now** summarises up to the planned point and keeps the newest turns (up to 15% of the window, at most 64,000 tokens) instead of summarising the whole conversation.
