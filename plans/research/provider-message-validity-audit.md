# Provider message validity audit

Trigger: a user hit `Bedrock: no content in assistant message before conversational turn change`. That error is our own `throw` in `_convertMessages` (`core/llm/llms/Bedrock.ts:1461`). It fires when a turn has no content blocks left after conversion. The Bedrock fix is a separate piece of work, and `core/llm/llms/Bedrock.ts` and `packages/openai-adapters/src/apis/Bedrock.ts` are out of scope here.

This document asks whether every other provider has the same class of bug. That class covers a history the GUI or CLI can produce which converts to an empty turn, an orphaned tool block, or a malformed part. It also proposes one shared normalisation pass, so the fix is made once rather than once per provider.

Method: the code was read at `main` 62277ea7. No request was sent to any provider, and every provider key was unset. "Unverified" means the provider's answer to that payload was not observed. Each one needs a single live probe before a fix depends on it.

## How a message reaches a provider

Three paths run from history to the wire. The normalisation has to sit where all three pass through.

1. **GUI to core.** `gui/src/redux/util/constructMessages.ts` builds a `ChatMessage[]`. `streamNormalInput.ts:186` sends it to `llm/compileChat`, which runs `compileChatMessages` (`core/llm/countTokens.ts:427`). The result is then sent with `precompiled: true` (`streamNormalInput.ts:234`). Native core providers that are called without precompilation compile in `streamChatOnRoute` (`core/llm/index.ts:1398`).
2. **Core to the adapters.** When `shouldUseOpenAIAdapter("streamChat")` is true (`core/llm/index.ts:1454`), `toChatBody` (`core/llm/openaiTypeConverters.ts`) turns `ChatMessage[]` into an OpenAI body, and `packages/openai-adapters` converts that body to the native format. This path covers OpenAI, Gemini, VertexAI, Mistral, Deepseek, OpenRouter, Groq, LMStudio, Vllm, xAI, Together, Fireworks, DeepInfra, Cerebras, Nvidia, Nebius, Novita, SambaNova, Scaleway, OVH, Kindo, MiniMax, Moonshot, Inception, CometAPI, Relace, LlamaStack, TextGenWebUI, FunctionNetwork, Tensorix, NCompass, ClawRouter and BedrockMantle. Their native `_convertArgs` and `_streamChat` methods are not used for chat.
3. **CLI to the adapters.** The CLI does **not** run `compileChatMessages`. `extensions/cli/src/stream/requestBody.ts:60` calls `convertFromUnifiedHistoryWithSystemMessage` (`core/util/messageConversion.ts`), and the resulting OpenAI messages go straight to an adapter.

Two other groups have their own converters, which run after compile:

- **Native core converters:** Anthropic, Cohere, WatsonX, Ollama (and Msty), SageMaker, Cloudflare, Asksage and Replicate.
- **OpenAI-format providers outside the adapter list.** Azure sets `useOpenAIAdapterFor = []` (`Azure.ts:13`). The same group includes docker, lemonade, mimo, nous, siliconflow, tars and venice. These go through `toChatBody` inside `OpenAI._streamChat`.
- **Text-template providers** (LlamaCpp, Llamafile, HuggingFaceTGI/InferenceAPI, BedrockImport) flatten everything to a prompt string, so they cannot produce this class of error.

### What compile already repairs, and what it creates

`compileChatMessages` (`core/llm/countTokens.ts:427`) does two things to empty messages:

- **Drops some.** `chatMessageIsEmpty` (`core/llm/messages.ts:56`) drops user and system messages whose string content is blank. It also drops assistant messages whose string content is blank and that have no `toolCalls`.
  - It never drops `thinking` or `tool` messages.
  - It never drops a message whose content is an array.
  - It keeps an assistant message with `toolCalls: []`, because the test is `!message.toolCalls`.
- **Pads the rest.** `addSpaceToAnyEmptyMessages` (`messages.ts:20`) then sets the content of every remaining empty message to `" "`. That covers every assistant turn that carries tool calls but no text, and every all-blank or empty content array (`[].every(...)` is true).

`extractToolSequence` (`countTokens.ts:230`) checks only the trailing tool results. It throws `no tool call found to match tool output` when they do not match. Pruning (`removeAt`, `countTokens.ts:575`) removes tool messages that follow a pruned message, but it can leave the history starting with an assistant turn.

**The `" "` placeholder is how an empty turn reaches the converters.** Converters that test truthiness send it as a whitespace text block (Anthropic native and the Anthropic adapter). Converters that `trim()` and then skip it are left with an empty turn (the Bedrock throw). The placeholder was added for LM Studio (`openaiTypeConverters.ts:151` gives that reason). It belongs in the OpenAI-format serialiser, not in the shared `ChatMessage` stage.

## Where the empty or partial turn comes from (upstream trigger)

### GUI

- **Placeholder assistant.** `submitEditorAndInitAtIndex` (`gui/src/redux/slices/sessionSlice.ts:483`, `:503`, `:528`) pushes an assistant `""` before streaming starts. `streamUpdate` (`:826`) creates a new history item whenever the role changes, so a reply with reasoning becomes `[user, assistant "", thinking, assistant …]`.
- **Stop and error both end in `clearDanglingMessages`.**
  - Stop runs `cancelStream` (`gui/src/redux/thunks/cancelStream.ts:55`). A failed request runs `streamThunkWrapper.tsx:83`, and the overload retry runs `:76`/`:79`.
  - `clearDanglingMessages` (`sessionSlice.ts:380-428`) keeps everything up to the last item where `message.content` is truthy, or which has a tool call whose status is not `generating` (`:398`, `:400`).
  - **A `thinking` item with text counts as valid.** If Stop or an error lands after reasoning but before any answer text, history ends `[…, user, assistant "", thinking]`. Sending again gives `[…, user, assistant "", thinking, user]`.
  - The placeholder assistant is dropped later, but the orphan `thinking` survives `constructMessages` (`constructMessages.ts:103`) and `compileChatMessages`. It ends up as an assistant turn holding only reasoning.
  - **One path to the reported Bedrock error:** on a Bedrock model that does not replay redacted reasoning (Nova; `replaysRedactedThinking` at `Bedrock.ts:1453`, `continue` at `:1581`), the redacted placeholder `"internal reasoning is hidden due to safety reasons"` (`sessionSlice.ts:771`) is truthy, so it is kept. On the next request it converts to no block. The assistant turn is empty, and `pushCurrentMessage` throws. This has been passed on to the Bedrock fix.
- **Content that is an array is always "valid".** `[]` is truthy in `clearDanglingMessages`, and compile never drops array content (see above).
- **Partial tool calls.**
  - A tool call still in `generating` is not kept on its own. It is kept when the same item has text, in which case `clearDanglingMessages` marks it `canceled` (`:404-412`). `message.toolCalls` keeps the truncated `arguments` string.
  - `constructMessages` (`:134-163`) emits one tool result per `toolCallState`. It uses `CANCELLED_TOOL_CALL_MESSAGE` when the state is `canceled`, and `toolCallId: toolCall.id!`, so a missing id becomes `undefined`.
  - A `message.toolCalls` entry that has no `toolCallState` gets no result. `constructMessages.ts:164` only logs the opposite mismatch (states but no calls).
- **`<think>` replies.** `streamUpdate` (`sessionSlice.ts:786-820`) can push an assistant with `content: ""` and reasoning stored only on the item. With no tool calls it is dropped by `chatMessageIsEmpty`, which leaves two user turns in a row on the next request.

### CLI

- **Abort.** `streamChatResponse.ts:573` returns the partial text. At `:772` the turn ends before `handleToolCalls`, so **nothing is written to history**. The next message makes two user turns in a row.
- **Content-only reply.** `handleToolCalls.ts:209` writes an assistant only when `content` is truthy, so an empty reply is never stored.
- **Tool calls.** The stored assistant has `content: content || ""` (`handleToolCalls.ts:247`). `messageConversion.ts:342-349` adds `"Tool cancelled"` for every tool state that has no output. This is the only upstream pairing repair in the code base.
- **Incomplete tool calls.** Calls with no name are filtered out before they are stored (`streamChatResponse.ts:595`).
- **Thinking.** A `thinking` history item is turned into an **assistant text** message (`messageConversion.ts:123-129`). This produces two assistant turns in a row, and the reasoning becomes visible answer text.
- **Empty arguments.** These serialise as `arguments: ""` (`messageConversion.ts:106`), whereas `toChatBody` uses `"{}"` (`openaiTypeConverters.ts:164`).

## Provider by case

Codes:

| Code      | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| **T**     | throws locally                                                                                |
| **400**   | the API rejects it, per the documented constraint (wording unverified)                        |
| **INV**   | sends a payload outside the documented schema; the outcome depends on the server (unverified) |
| **OK**    | repaired, dropped, or accepted by the API                                                     |
| **lossy** | accepted, but data is silently changed                                                        |

"After compile" means after the `" "` padding described above.

The case columns, in order:

1. empty assistant
2. empty user
3. assistant with only thinking
4. tool call with no id or name
5. unpaired tool calls and results:
   - 5a. tool result with no matching call
   - 5b. tool call with no result
6. two turns of the same role in a row
7. history starts with assistant
8. user message with only an image
9. truncated or empty tool arguments

### Native core converters

| Case | Anthropic (`core/llm/llms/Anthropic.ts`)                                                                                                                                                                                                                                                                  | Ollama (`Ollama.ts:324`)                      | WatsonX (`WatsonX.ts:96`)                                            | Cohere (`Cohere.ts:20`)                                                              | SageMaker (`:236`), Cloudflare (`:33`) |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| 1    | `""` and `[]` give no blocks and the turn is skipped (`:142`, `:274`), OK. **`" "` is truthy** and becomes a whitespace text block (`:142-147`). Every tool-call turn without text becomes `[text " ", tool_use]`. Non-final: unverified. Final (prefill): 400 on models without prefill, see constraints | `" "` OK                                      | `" "` OK. With `toolCalls: []`, content is **deleted** (`:105`), INV | text `" "`; `toolCalls: []` gives `tool_calls: []`, INV                              | raw `ChatMessage`, INV                 |
| 2    | skipped, OK. If every turn is dropped: `messages: []`, 400                                                                                                                                                                                                                                                | OK                                            | OK                                                                   | skipped (`:23`)                                                                      | raw                                    |
| 3    | Unsigned thinking gives `[]` (`:219`): turn skipped, users merge, OK. Signed thinking with no text after it leaves a turn of only `thinking` blocks (unverified)                                                                                                                                          | **`role: "thinking"` sent raw** (`:326`), INV | **`role: "thinking"` sent raw**, INV                                 | merged into the next assistant (`:59`); an orphan becomes thinking-only (unverified) | raw role, INV                          |
| 4    | Call **dropped** (`:183-190`), but its `tool_result` is still sent: **400**                                                                                                                                                                                                                               | no name: filtered (`:340`); ids unused, OK    | `...t` spread, id may be missing, 400                                | undefined fields, 400                                                                | raw                                    |
| 5a   | 400, no repair                                                                                                                                                                                                                                                                                            | sent; Ollama does not validate, OK            | 400                                                                  | 400                                                                                  | depends on the endpoint                |
| 5b   | 400 ("tool_use ids were found without tool_result blocks immediately after")                                                                                                                                                                                                                              | OK                                            | 400                                                                  | 400                                                                                  | depends on the endpoint                |
| 6    | merged by `flush` (`:278-286`), OK                                                                                                                                                                                                                                                                        | passed through                                | passed through                                                       | passed through                                                                       | passed through                         |
| 7    | passed through (unverified)                                                                                                                                                                                                                                                                               | passed through                                | passed through                                                       | passed through                                                                       | passed through                         |
| 8    | OK; an invalid data URL is skipped (`:170`) and can empty the turn (case 2)                                                                                                                                                                                                                               | `images[]`, OK                                | OK                                                                   | OK                                                                                   | raw                                    |
| 9    | `{}` via `safeParseToolCallArgs`, lossy                                                                                                                                                                                                                                                                   | `{}` with a warning (`:344`), lossy           | raw string                                                           | raw string                                                                           | raw                                    |

Also: `WatsonX._convertMessage` **mutates its input** (`:97-106`, using `delete`). `retryStreamOnDroppedConnection` (`core/llm/index.ts:1540`) calls `_streamChat` again with the same objects, so on a retry tool messages are sent with `tool_call_id: undefined`. A fallback route given the same precompiled array also sees the mutated objects.

### The `toChatBody` bridge (Azure-class providers, and the input to every adapter)

| Case  | `core/llm/openaiTypeConverters.ts`                                                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | string `""` becomes `" "` (`:151`), OK. Array content keeps only text parts (`:152-154`), so an assistant with only non-text parts gives `content: []`, INV. `toolCalls: []` gives `tool_calls: []` (`:158` tests truthiness), INV |
| 2     | prevented upstream. `?? " "` at `:182` does not catch `""` (latent bug)                                                                                                                                                            |
| 3     | `thinking` becomes `null` (`:133`). Reasoning goes onto the next assistant only (`:66`), so orphan reasoning is dropped, OK                                                                                                        |
| 4     | `id: toolCall.id!`, `name: …!` (`:160-162`): undefined fields drop out of the JSON, 400                                                                                                                                            |
| 5a/5b | no repair, 400 (OpenAI: a tool message "responds to" a `tool_call_id`)                                                                                                                                                             |
| 6, 7  | passed through. OpenAI accepts this; strict Jinja chat templates (vLLM, llama.cpp) may raise "roles must alternate" (unverified)                                                                                                   |
| 8     | `image_url` array, OK                                                                                                                                                                                                              |
| 9     | `""` becomes `"{}"` (`:164`); invalid JSON is sent verbatim (unverified for local servers)                                                                                                                                         |

### Adapters (`packages/openai-adapters/src/apis`)

| Case | Anthropic adapter (also Vertex Claude)                                                                                                  | Gemini (also Vertex Gemini)                                                                              | `openaiResponses.ts`                                                                              | OpenAI pass-through*                                | AiSdk                                                                  | Cohere adapter                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| 1    | `""`/null/`[]` dropped (`Anthropic.ts:268`, `:406-409`, `:435`), OK. **`" "` becomes a whitespace text block** (`:268`), same as native | `""`/null dropped (`Gemini.ts:271`). `[]` gives `parts: []`, 400 unless merged                           | trimmed and dropped (`:166`, `:342`), OK                                                          | `""` passes; null with no `tool_calls` (unverified) | `""` kept (`openaiToVercelMessages.ts:109`)                            | `message: null`, INV (`Cohere.ts:38-41`) |
| 2    | dropped; all dropped gives `messages: []`, 400                                                                                          | same as 1                                                                                                | `input_text ""` (`:113`), unverified                                                              | passes                                              | passes                                                                 | INV                                      |
| 3    | reasoning fields ignored, so this becomes case 1                                                                                        | ignored, so case 1                                                                                       | ignored, so case 1                                                                                | forwarded raw, per provider flags                   | ignored                                                                | ignored                                  |
| 4    | call dropped (`:244`), result still sent, 400                                                                                           | `name: undefined`, 400 (`Gemini.ts:226`)                                                                 | id becomes `tool_call_${index}` (`:358`), which repeats across turns, 400; name becomes `""`, 400 | raw, 400                                            | `toolCallId: undefined` (`:88`); AI SDK validation likely T            | tool_calls dropped                       |
| 5a   | 400 (`:386-397`)                                                                                                                        | functionResponse `name: "unknown"` (`Gemini.ts:262`), unverified                                         | no `call_id`: skipped (`:297`); unknown id, 400                                                   | 400                                                 | `toolName: "unknown_tool"` (`:116`)                                    | sent as user text                        |
| 5b   | 400                                                                                                                                     | unverified (the call and response counts differ)                                                         | 400                                                                                               | 400                                                 | unverified                                                             | n/a                                      |
| 6    | merged (`:443-452`), OK                                                                                                                 | merged (`util/gemini-types.ts:432-453`), OK                                                              | items, OK                                                                                         | passes                                              | passes                                                                 | passes                                   |
| 7    | passes (unverified)                                                                                                                     | passes (unverified)                                                                                      | OK                                                                                                | OK                                                  | unverified                                                             | OK                                       |
| 8    | data URL OK; non-data URL skipped (`:296-300`), can empty the turn                                                                      | **http URL gives `inlineData.data: undefined`**, mime hard-coded `image/jpeg` (`Gemini.ts:107-116`), INV | OK (`:94`)                                                                                        | OK                                                  | `image_url` passed raw (`:59`), likely T                               | INV                                      |
| 9    | `{}` (`:250`), lossy                                                                                                                    | `{}` (`Gemini.ts:227`), lossy                                                                            | verbatim; `""` stays `""` (`:363`)                                                                | verbatim                                            | **raw string as `input`** (`:77-81`); `""` always takes this path, INV | n/a                                      |

\*The pass-through group is OpenAI, DeepSeek, Moonshot, MiniMax, LlamaStack, Inception, CometAPI, ClawRouter, BedrockMantle, OpenRouter and WatsonX: all forward `messages` untouched (`OpenAI.ts:78-126`, `WatsonX.ts:152`). Some make small changes:

- Azure removes blank text parts unless that would empty the content (`Azure.ts:87-110`).
- OpenRouter turns string content, including `" "`, into a cache-marked text block (`OpenRouterCaching.ts:44-62`).
- Vertex Mistral sends the body raw (`VertexAI.ts:257-260`) without the nine-character tool-id rule that Bedrock applies (`bedrockHelpers.ts:362-415`).

**Cohere adapter defects** (CLI use only; core Cohere is native):

- `oaiBody.messages.pop()` mutates the caller's body (`Cohere.ts:46`), so a retry loses the last message.
- The stream path never checks the HTTP status (`:104-116`).

**Asksage** flattens every turn to text and drops empty assistants (`Asksage.ts:180`), so it tolerates every case.

**Text tool path.** `convertToolCallStatesToSystemCallsAndOutput` (`core/tools/systemMessageTools/convertSystemTools.ts:31`) always emits a user turn, with "Error: no tool output" as a placeholder (`:67`), so it is safe. `toolDialect` recovery only flips a body switch (`core/llm/index.ts:1182`) and does not touch the outgoing messages.

## Documented constraints (first party)

- **Anthropic Messages** (<https://platform.claude.com/docs/en/api/messages>):
  - "Consecutive `user` or `assistant` turns in your request will be combined into a single turn."
  - On a final assistant turn: "On models that don't support prefill, creating a message that ends with a partial `assistant` response returns a 400 error."
  - `TextBlockParam.text` is `minLength: 1`. The page does not say whether whitespace-only text is accepted.
- **Anthropic tool results** (<https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>):
  - "Tool result blocks must immediately follow their corresponding tool use blocks in the message history."
  - "the `tool_result` blocks must come FIRST in the content array."
  - The error it names is "tool_use ids were found without tool_result blocks immediately after".
  - Consequence: after a merge, user text placed before a `tool_result` is a 400. A steering message delivered between a call and its result produces exactly that shape.
- **OpenAI Chat Completions** (<https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>):
  - Assistant `content`: "Required unless `tool_calls` or `function_call` is specified."
  - Tool message `tool_call_id`: "Tool call that this message is responding to."
- **Gemini `Content`** (<https://ai.google.dev/api/caching#Content>):
  - `role` "Must be either 'user' or 'model'."
  - `FunctionResponse.id` is "Populated by the client to match the corresponding function call `id`."
  - The reference states no alternation rule. Non-empty `parts` is enforced by the API, not documented on that page (unverified).
- **Bedrock Converse**: out of scope here. Our own guard (`Bedrock.ts:1461`) exists because Converse rejects an empty content list.

## Severity

| #   | Issue                                                                                                                                   | Providers                                                                                                   | Reachable from                                                | Severity                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Orphan `thinking` after Stop or error is kept by `clearDanglingMessages` and becomes a reasoning-only or empty assistant turn           | GUI, all providers; throws on Bedrock Nova; raw `role:"thinking"` on Ollama, WatsonX, SageMaker, Cloudflare | Stop during reasoning (common)                                | **High**                                                                                                                                                                             |
| 2   | No tool-call/result pairing repair in the IDE path; Anthropic native and the Anthropic adapter drop an id-less call but keep its result | Anthropic (both), OpenAI-format, Gemini, Responses, WatsonX, Cohere                                         | a call with no `toolCallState`, a missing id, a pruned middle | **High** (400 on every later request; the session is stuck)                                                                                                                          |
| 3   | The `" "` placeholder becomes a whitespace text block                                                                                   | Anthropic native, Anthropic adapter (Vertex Claude), OpenRouter Claude                                      | every text-less tool-call turn                                | **Medium**, pending one probe. If the API rejected it, every native Anthropic tool loop would already fail, so it is probably accepted when not final. As the final turn it is a 400 |
| 4   | WatsonX mutates its input, so a retry or fallback route sends `tool_call_id: undefined`                                                 | WatsonX                                                                                                     | dropped connection, fallback route                            | **Medium**                                                                                                                                                                           |
| 5   | CLI: thinking is sent as assistant text, giving two assistant turns in a row and leaking reasoning; `arguments: ""`                     | CLI, all adapters; strict servers may 400                                                                   | any reasoning model in the CLI                                | **Medium**                                                                                                                                                                           |
| 6   | Gemini: `parts: []`, `inlineData.data` undefined for http images, `name: undefined`                                                     | Gemini, Vertex Gemini                                                                                       | `[]` content, a pasted URL image                              | **Medium**                                                                                                                                                                           |
| 7   | AiSdk: raw-string `input`, array content wrapped as text, raw `image_url`                                                               | AiSdk providers                                                                                             | truncated tool arguments                                      | **Medium**                                                                                                                                                                           |
| 8   | `toolCalls: []` survives compile and becomes `tool_calls: []` (and WatsonX deletes content)                                             | toChatBody, Cohere, WatsonX                                                                                 | no producer found today                                       | Low (latent)                                                                                                                                                                         |
| 9   | Truncated arguments silently become `{}`                                                                                                | Anthropic, Gemini, Ollama                                                                                   | Stop mid-call (the result is already "cancelled")             | Low                                                                                                                                                                                  |
| 10  | Cohere adapter: `pop()` mutation, unchecked stream status, raw content                                                                  | Cohere through the CLI                                                                                      | any retry                                                     | Low (rarely used)                                                                                                                                                                    |

## Recommended shared normalisation

### What it is

`normalizeTurns(messages: ChatMessage[]): { messages: ChatMessage[]; repairs: string[] }` goes in a new `core/llm/normalizeTurns.ts`. It is a pure function. **It returns the input array itself (same reference) when it finds nothing to repair.** That identity is the guarantee that valid histories are sent byte for byte as today, so prompt caches keep hitting. Each repair is named in `repairs` for the interaction log.

Rules, applied in order. Each one fires only on input that is invalid for every provider:

1. **Normalise tool-call shape.**
   - `toolCalls: []` becomes absent.
   - A call with no `function.name` is removed.
   - A call with no `id` gets a deterministic id derived from its position, `call_<assistantIndex>_<k>`. A deterministic id keeps a repaired history stable between requests and so does not break caching.
2. **Drop empty assistant turns.** These are assistants with no non-whitespace text, no images and no calls.
   - Thinking with no assistant content or call after it, before the next user or tool turn, is dropped with that turn.
   - Signed thinking that **is** followed by content or a call is never touched, because Anthropic requires it to stay attached to its `tool_use`.
3. **Drop empty user turns.**
   - Keep at least one user turn.
   - If the history would start with an assistant after this rule or after pruning, do nothing in this pass. Providers accept it as far as is known (unverified). Rule 7 below is the switch for providers that do not.
4. **Repair pairing**, scanning each assistant turn that has calls:
   - **Missing result.** Every call id with no `tool` message before the next assistant or user turn gets a synthetic result, `CANCELLED_TOOL_CALL_MESSAGE` (`core/tools/constants.ts:2`). This is the same text the GUI uses, and the same algorithm as `fillMissingToolResults` (`packages/openai-adapters/src/apis/bedrockHelpers.ts:421-459`), which can be moved here.
   - **Orphan result.** A `tool` message whose id matches no earlier unanswered call becomes user text: `Tool output (call <id>):\n<content>`. This follows the precedent at `Bedrock.ts:1519`, and it keeps the information rather than dropping it.
   - **Text placed before a result.** A user message sitting between a call and its results moves to after them (the Anthropic ordering rule).
5. **Same-role turns.** Do **not** merge them in the shared pass. Anthropic, Gemini and Bedrock already merge in their converters, and OpenAI accepts consecutive turns, so a shared merge would change bytes for valid histories that are already accepted. Merge only the two user turns that rule 2 itself just made adjacent, and only for a provider that sets the flag in rule 7.
6. **Move the `" "` padding out of compile.**
   - Remove `addSpaceToAnyEmptyMessages` from `compileChatMessages` (`countTokens.ts:470`).
   - Keep the `|| " "` in `toChatBody` (`openaiTypeConverters.ts:151`), which is where LM Studio needs it. The bytes on the adapter path stay the same.
   - Native converters then see `""` and emit no text block. **Cost:** the bytes change for native Anthropic tool-call turns that carry `" "` today. That is one cache miss per conversation on upgrade, and should be noted in the release notes.
7. **Per-provider strictness flag** (`requiresAlternation`). Set it for Cohere, WatsonX and strict local templates. It adds two repairs: merge same-role turns, and prepend a minimal user turn before a leading assistant. It stays off by default, which preserves the identity guarantee.

### Where to call it

- **`compileChatMessages`**, right after the system message is set aside (`countTokens.ts:463`), replacing the `chatMessageIsEmpty` filter and the padding.
  - This covers GUI precompile, native core providers, and the `toChatBody` path into the adapters.
  - Rule 4 runs before `extractToolSequence`, so that function's throw becomes unreachable for orphan trailing results. Keep the throw as an assertion.
  - Run it again after pruning, because `removeAt` (`countTokens.ts:575`) can strand a call whose results were pruned.
- **CLI**: in `extensions/cli/src/stream/requestBody.ts`, on the `ChatMessage[]` taken from the history items before `convertFromUnifiedHistory`. Then delete the CLI-only `"Tool cancelled"` fill (`messageConversion.ts:342-349`), because rule 4 replaces it.
- **Not in the adapters.** Keep each adapter's local guards (the trim in `openaiResponses.ts`, the merge in Gemini) as defence in depth, but do not add a second normaliser there.

### Provider fixes the pass does not cover

- Anthropic native `:142`/`:151` and the Anthropic adapter `:268`/`:309` should test `content.trim()`. Content stays byte-identical for non-blank text.
- WatsonX `_convertMessage` should copy instead of `delete` on its input.
- Ollama, WatsonX, SageMaker and Cloudflare should map or omit `role: "thinking"`.
- Gemini `[]`/http image/`name` guards.
- AiSdk: send `{}` (or the repaired input) instead of a raw string.
- The Cohere adapter should not `pop()`.
- CLI `messageConversion.ts:123-129`: drop `thinking`, or attach it as reasoning, instead of emitting assistant text.
- **GUI** `clearDanglingMessages` (`sessionSlice.ts:400`): do not count a `thinking` item as a valid end of turn. Fixing this fixes the source, but the pass still has to repair saved sessions that already contain the shape.

## Tests needed

1. **`core/llm/normalizeTurns.vitest.ts`.** Table-driven, one fixture per case 1–9 plus the GUI shapes above:
   - `[user, assistant "", thinking, user]`
   - a redacted-thinking tail
   - a call with no state
   - a pruned middle
   - steering text between a call and its result

   Assert the repaired output and the `repairs` names.

2. **Identity tests.** A corpus of valid histories: plain chat, tool loop, parallel calls, signed thinking with a call, images, and a resumed session. Assert `normalizeTurns(h).messages === h` and that the JSON is unchanged.
3. **Cache-prefix test.** For a tool loop of N turns, assert that the serialised request for turn N is a byte prefix of the one for turn N+1 after normalisation. Run it for:
   - native Anthropic `convertMessages`
   - `toChatBody`
   - the Gemini adapter
   - the Anthropic adapter
4. **Converter invariant tests.** Feed the case corpus through normalise and then each converter: Anthropic native and adapter, `toChatBody`, Gemini, Responses, Ollama, WatsonX. Assert, without any network call:
   - no empty turn
   - no whitespace-only text block
   - every `tool_use` answered in the next turn
   - every result answers a call
   - no `role: "thinking"` on the wire
   - no undefined id or name
5. **GUI.** A `clearDanglingMessages` test for Stop during reasoning, and a `constructMessages` test for a call with no `toolCallState`.
6. **CLI.** A `requestBody` test after an abort (user, user), and a test that a thinking item is not emitted as assistant text.
7. **WatsonX.** Converting twice gives the same output (no mutation).
8. **Live probes** (manual, one request each, recorded under `bench/evidence/`) before rule 6 and the Anthropic trim ship:
   - Anthropic with a non-final `" "` text block next to `tool_use`
   - Gemini with `parts: []`
   - a strict vLLM template with two assistant turns in a row
