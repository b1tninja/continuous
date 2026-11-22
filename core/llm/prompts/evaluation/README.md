# Turn evaluation (`npm run eval:turns`)

Fixed conversations sent to a model, with the next reply scored. Nothing the model calls is run. Two suites share the
wrapper (`core/scripts/turns-eval.mjs`), its model flags and its provider adapters (`adapters.ts`):

- the turn prompts (`scenarios.ts`, `runner.ts`, `qualityBar.ts`): the default, described by `npm run eval:turns -- --help`;
- the guidance replay (`guidanceCases.ts`, `guidanceReplay.ts`): `--replay`, described here.

## Guidance replay

When a tool call fails or is refused, the model gets a text result. The replay measures whether the wording of that
text changes the model's next call.

A case (`GuidanceCase`) is a conversation that stops at a call, the files that call was made against, and the call's
result in several wordings, called arms. Each trial sends the conversation with one arm's text as the result and
scores the first call of the reply:

- **changed**: it is not the failed call again (same tool, same arguments);
- **valid**: it names an offered tool, and its arguments fit that tool's schema (required parameters, types, enums);
- **succeeded**: it is valid and does what the case needs against the case's files.

A reply with no call counts against all three and is shown in its own column. The report is one table, a row per
class and arm, each rate as count/N with its 95% Wilson interval (`wilson.ts`).

| Class            | The failed call                                                                 | Succeeded means                                                                |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `edit-not-found` | An exact-text edit of a file the person changed after the model read it         | It read the file again, or sent an edit that core's search and replace applies |
| `question-cap`   | A fifth command needing approval in one Loop item, after four held as questions | It did not send another command, or a question that the same cap turns away    |
| `unknown-tool`   | `Read` with `file_path`, a name the IDE does not offer                          | It called `read_file` on the file                                              |

Arms: `old` is the wording before 2026-11-22, written out in `guidanceCases.ts` because it is history. `new` is built
by calling the code that words the result today (`editFailureResult`, `unknownToolResult`, `holdQuestion`), so it
follows the code. The cap's wording was not part of that rewrite, so its `old` and `new` are the same text until
`loopMode.ts` changes; it has a third arm, `proposed`, from section 5 of
`plans/research/agent-guidance-review-2026-11-21.md`.

### Running it

```bash
cd core
# A stand-in instead of a model: no network. This is what CI runs.
npm run eval:turns -- --replay --stub oracle
# A local model, 10 trials per case and arm (70 requests with the three cases here)
npm run eval:turns -- --replay --ollama --model <a tool-calling model you have pulled> --runs 10
```

The report is printed and written to a file under the temp directory (the path is printed), or to `--out <file>`.
`--dump <file>` writes every reply as JSON. `--temperature` defaults to 0.7; `--profile` picks the act turn text sent
as the system message (default `full`). There is no bar: the exit code says only whether the run completed.

### What it does not measure

- **Stub mode says nothing about wording.** The stand-ins (`oracle`, `repeat`, `text-only`) do not read the result,
  so every arm scores the same. Stub mode checks the replay and its scoring, and nothing else.
- One case per class. A rate is about that case, not about the class.
- One next call. Whether the task was finished later is not followed.
- The trials of one case differ only by sampling. At `--temperature 0` they are repeats of one reply, and the
  interval then claims more than was measured.
- Under 10 trials per arm is too few to compare arms; 10 is screening, where only a large difference shows; a wording
  should become the default on about 33 per arm for a 0.3 difference (ROADMAP RQ10). The report says which applies.
- The system message is the act turn text, also for the Loop case, whose user message is the real item prompt.
- Nothing is run for real: a command, a search or a new file is scored by the case's `succeeded` alone.

### Adding a class

1. In `guidanceCases.ts`, write a function that returns a `GuidanceCase`: a first user message no other case has
   (the oracle stand-in finds the case by it), the history ending in the assistant's failed call, the tools offered,
   and `project` as the files are when the result arrives.
2. Give it a new `failureClass` and its `arms`. Write `old` out; build `new` by calling the function that words the
   result in the product, and produce the failure the same way where you can (the edit case runs the real search).
   Throw if the scripted call would no longer fail.
3. Write `succeeded` for the class, and an `oracle` call that passes it.
4. Add the case to `GUIDANCE_CASES`, the class to the list in `guidanceReplay.vitest.ts`, and tests of `succeeded`
   for a call that passes and one that does not.

A second case for an existing class needs only steps 1 to 4 with the same `failureClass` and arm names; its trials
are added to that class's rows.
