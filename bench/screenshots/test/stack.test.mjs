import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkStack, MIN_TRANSCRIPT } from "../src/stack.mjs";
import { planJobs, VIEWS } from "../src/views.mjs";

const part = (height, shown = height) => ({ height, shown });
const button = (name, height = 22, shown = height) => ({
  name,
  height,
  shown,
});

/** A short panel where everything that must show does. */
const facts = (over = {}) => ({
  viewport: 400,
  transcript: part(96),
  prompt: part(40),
  buttons: [
    button("reject-tool-call-button-call-1"),
    button("accept-tool-call-button-call-1"),
  ],
  ...over,
});

describe("checkStack", () => {
  it("passes when the chat, the prompt and the buttons show", () => {
    assert.deepEqual(checkStack(facts()), []);
    assert.deepEqual(checkStack(facts({ buttons: [] })), []);
  });

  it("reports a chat under the minimum, also one with no height", () => {
    assert.equal(MIN_TRANSCRIPT, 96);
    assert.deepEqual(checkStack(facts({ transcript: part(300, 95) })), [
      "the chat shows 95 px, under 96",
    ]);
    assert.deepEqual(checkStack(facts({ transcript: part(0) })), [
      "the chat shows 0 px, under 96",
    ]);
    assert.deepEqual(
      checkStack(facts({ transcript: part(60) }), { minTranscript: 48 }),
      [],
    );
  });

  it("reports a prompt that is cut or missing, and allows a pixel", () => {
    assert.deepEqual(checkStack(facts({ prompt: part(40, 12) })), [
      "the prompt shows 12 of 40 px",
    ]);
    assert.deepEqual(checkStack(facts({ prompt: part(40, 39) })), []);
    assert.deepEqual(checkStack(facts({ prompt: null })), [
      "no prompt on the page",
    ]);
  });

  it("reports a cut button of the first approval only", () => {
    assert.deepEqual(
      checkStack(
        facts({
          buttons: [
            button("reject-tool-call-button-call-1"),
            button("accept-tool-call-button-call-1", 22, 0),
            // further down a list that scrolls
            button("accept-tool-call-button-call-2", 22, 0),
          ],
        }),
      ),
      ["accept-tool-call-button-call-1 shows 0 of 22 px"],
    );
  });

  it("reports a first approval with no whole line of what it asks for in sight", () => {
    assert.deepEqual(
      checkStack(facts({ what: { lines: 3, fromStart: true } })),
      [],
    );
    assert.deepEqual(
      checkStack(facts({ what: { lines: 1, fromStart: false } })),
      [],
    );
    assert.deepEqual(
      checkStack(facts({ what: { lines: 0, fromStart: true } })),
      [
        "no whole line of what the first approval asks for shows above its buttons",
      ],
    );
    // no approval on the page
    assert.deepEqual(checkStack(facts({ what: null })), []);
  });

  it("reports a question's answer controls that are cut, and allows a pixel", () => {
    assert.deepEqual(checkStack(facts({ answers: part(52) })), []);
    assert.deepEqual(checkStack(facts({ answers: part(52, 51) })), []);
    assert.deepEqual(checkStack(facts({ answers: part(52, 30) })), [
      "the question's answer controls show 30 of 52 px",
    ]);
    // no question on the page, or a measurement taken before they were measured
    assert.deepEqual(checkStack(facts({ answers: null })), []);
  });
});

describe("views that are measured", () => {
  it("a view marked stack carries it into its jobs, others do not", () => {
    const marked = Object.keys(VIEWS).filter((v) => VIEWS[v].stack);
    assert.deepEqual(marked, [
      "approval",
      "crowded-stack",
      "tall-question",
      "loop-tall-question",
    ]);
    const jobs = planJobs({
      views: ["crowded-stack", "chat"],
      widths: [300],
      themes: ["dark"],
      height: 400,
    });
    assert.equal(jobs[0].stack, true);
    assert.equal("stack" in jobs[1], false);
  });
});
