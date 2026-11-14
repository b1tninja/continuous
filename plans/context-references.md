# Context references: attached files and selections, tracked once per session

Written 2026-11-14. Related: [`context-policy.md`](./context-policy.md)
(compaction, hold), [`context-visibility.md`](./context-visibility.md) (the
breakdown).

## 1. Problem

- An attached file is resent in full with every message that attaches it, and
  every later request carries each copy again. Nothing compares attachments
  across messages (`constructMessages` prepends each message's
  `contextItems`; dedupe exists only within one message, in
  `resolveEditorContent.ts`).
- A selection sent with Ctrl/Cmd+L becomes a chip in the input (the
  `code-block` node), but at send time it is written into the message text, so
  it is not tracked as context: the breakdown counts it as "your message", and
  Choose what to keep cannot offer it.
- There is no list of what the session has attached, how big each item is,
  how many times it was sent, or whether the file changed since.

## 2. Do providers have context pointers?

| Provider            | Pointer                                                              | What it saves                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Files API | upload once, `document` block with `source: {type: "file", file_id}` | the upload, not tokens: "File content used in Messages requests is priced as input tokens". Workspace-wide (any key in the workspace can read it). Not on Bedrock runtime. |
| Bedrock Converse    | `DocumentBlock` with `source` bytes, text or an S3 location          | delivery only; billed as input                                                                                                                                             |
| OpenAI              | `input_file` with a `file_id`                                        | delivery only                                                                                                                                                              |

A provider pointer never makes the context smaller; only prompt caching
lowers the cost of carrying it, and caching needs the prompt to stay the same
from the start. So references are ours: a request expands them to plain text,
the same on every provider. Provider files can come later as a transport (for
PDFs and images), behind the same reference.

## 3. Concept

### 3.1 A reference

Each attachment is a reference with a stable identity: its source (file URI,
plus a line range for a selection) and a hash of its content.

- **Same source, same content**: the same reference.
- **Same source, new content** (the file was edited): a new version of it.

### 3.2 Sent once

A request carries each version of a reference in full **once, at the first
message that attached it**. A later message that attaches the same version
sends one line instead:

`[README.md: the same content as attached earlier]`

The earlier copy is unchanged and still in place, so the prompt cache is not
disturbed: the stub is in the newer message, which is new to the request
anyway. A new version is sent in full where it is attached.

Exceptions, where the full content is sent again:

- the earlier copy is gone from the request: removed with Choose what to keep,
  or before the newest compaction summary;
- an attachment the person marked to always resend (later; see hold in
  `context-policy.md`).

### 3.3 Chips for selections

A selection attached with Ctrl/Cmd+L, or the new "Attach selection as
context", is a reference chip with its file and range. Its content goes with
the message's attachments (so it is tracked, deduplicated and removable), and
the message text keeps a short pointer at the chip's place:
`(see src/a.ts lines 10-40, attached)`, so "explain this" still points at it.

### 3.4 The session's attachments

A panel lists every reference: name, range, versions, size, times attached
and sent, and whether the file changed on disk since. From it: open, attach
again, remove from what is sent (all copies), hold.

## 4. Build order

1. **Sent once** (§3.2): a pure function over the history, applied in
   `constructMessages`; the breakdown counts the stubs. Tests.
2. The session attachment list as a selector, and the panel (§3.4).
3. Selection references (§3.3): the code-block chip becomes a reference, with
   the pointer text.
4. Remove and hold per reference, across all its copies.
5. Provider files as a transport for PDFs and images (Anthropic API only).
