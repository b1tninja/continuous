import { describe, expect, it } from "vitest";
import {
  type DialectTool,
  QwenXmlRecovery,
  qwenXmlRecoveryEnabled,
  recoverQwenXmlCalls,
  recoverQwenXmlFromText,
  renderQwenXmlCall,
} from "./qwenXml.js";

const tools: DialectTool[] = [
  {
    name: "Write",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" }, content: { type: "string" } },
      required: ["filepath", "content"],
    },
  },
  {
    name: "Read",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"],
    },
  },
  {
    name: "Bash",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
        background: { type: "boolean" },
      },
      required: ["command"],
    },
  },
  {
    name: "PresentPlan",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        decisions: { type: "array" },
      },
      required: ["title"],
    },
  },
  { name: "ListTasks", parameters: { type: "object", properties: {} } },
];

// The golden cases are written from the Qwen3-Coder chat template and from the
// one-line form the bench logged (plans/tool-call-styles.md, H13). They are
// not captured model output: nothing was captured to disk. Replace or extend
// them with captured replies as the bench produces them.
interface Golden {
  name: string;
  text: string;
  text_after: string; // what is left for the user to see
  calls: { name: string; arguments: Record<string, unknown> }[];
}

const golden: Golden[] = [
  {
    name: "a value that contains the closing parameter tag",
    text: "<function=Write>\n<parameter=filepath>\na\n</parameter>\n<parameter=content>\nthe tag </parameter> ends a value\n</parameter>\n</function>",
    text_after: "",
    calls: [
      {
        name: "Write",
        arguments: {
          filepath: "a",
          content: "the tag </parameter> ends a value",
        },
      },
    ],
  },
  {
    name: "a value that contains the closing function tag, then a second call",
    text: "<function=Write>\n<parameter=filepath>\na\n</parameter>\n<parameter=content>\nx </function> y\n</parameter>\n</function>\n<function=Read>\n<parameter=filepath>\nb\n</parameter>\n</function>",
    text_after: "",
    calls: [
      {
        name: "Write",
        arguments: { filepath: "a", content: "x </function> y" },
      },
      { name: "Read", arguments: { filepath: "b" } },
    ],
  },
  {
    name: "the template's full form",
    text: "<tool_call>\n<function=Write>\n<parameter=filepath>\nsrc/a.ts\n</parameter>\n<parameter=content>\nexport const a = 1;\n</parameter>\n</function>\n</tool_call>",
    text_after: "",
    calls: [
      {
        name: "Write",
        arguments: { filepath: "src/a.ts", content: "export const a = 1;" },
      },
    ],
  },
  {
    name: "without the outer wrapper (the leak the bench logged)",
    text: "<function=Read>\n<parameter=filepath>\nREADME.md\n</parameter>\n</function>",
    text_after: "",
    calls: [{ name: "Read", arguments: { filepath: "README.md" } }],
  },
  {
    name: "on one line, with an array argument",
    text: '<function=PresentPlan><parameter=title>x</parameter><parameter=decisions>[{"q":"a","options":["b"]}]</parameter></function>',
    text_after: "",
    calls: [
      {
        name: "PresentPlan",
        arguments: { title: "x", decisions: [{ q: "a", options: ["b"] }] },
      },
    ],
  },
  {
    name: "prose before the call (declined: the whole reply must be calls)",
    text: "I'll write the file now.\n\n<tool_call>\n<function=Read>\n<parameter=filepath>\na.txt\n</parameter>\n</function>\n</tool_call>\n",
    text_after:
      "I'll write the file now.\n\n<tool_call>\n<function=Read>\n<parameter=filepath>\na.txt\n</parameter>\n</function>\n</tool_call>\n",
    calls: [],
  },
  {
    name: "two calls in one reply",
    text: "<tool_call>\n<function=Read>\n<parameter=filepath>\na\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=Read>\n<parameter=filepath>\nb\n</parameter>\n</function>\n</tool_call>",
    text_after: "",
    calls: [
      { name: "Read", arguments: { filepath: "a" } },
      { name: "Read", arguments: { filepath: "b" } },
    ],
  },
  {
    name: "integer and boolean arguments typed from the schema",
    text: "<function=Bash>\n<parameter=command>\nnpm test\n</parameter>\n<parameter=timeout>\n30\n</parameter>\n<parameter=background>\nfalse\n</parameter>\n</function>",
    text_after: "",
    calls: [
      {
        name: "Bash",
        arguments: { command: "npm test", timeout: 30, background: false },
      },
    ],
  },
  {
    name: "a value holding tags, quotes and equals signs",
    text: '<function=Write>\n<parameter=filepath>\nx.html\n</parameter>\n<parameter=content>\n<div class="a" data-x=1>if (a < b && c > d) {}</div>\n</parameter>\n</function>',
    text_after: "",
    calls: [
      {
        name: "Write",
        arguments: {
          filepath: "x.html",
          content: '<div class="a" data-x=1>if (a < b && c > d) {}</div>',
        },
      },
    ],
  },
  {
    name: "a tool with no parameters",
    text: "<tool_call>\n<function=ListTasks>\n</function>\n</tool_call>",
    text_after: "",
    calls: [{ name: "ListTasks", arguments: {} }],
  },
];

// Things that must stay text: no call may be made from any of them.
const negatives: { name: string; text: string }[] = [
  {
    name: "prose that explains the markup",
    text: "Qwen3-Coder writes calls as <tool_call> then <function=NAME> and one <parameter=KEY> per argument.",
  },
  {
    name: "a marker in inline code",
    text: "Use `<function=Read>` to read a file, with `<parameter=filepath>` inside.",
  },
  {
    name: "a complete call inside a code fence (an example)",
    text: "For example:\n\n```xml\n<tool_call>\n<function=Read>\n<parameter=filepath>\na\n</parameter>\n</function>\n</tool_call>\n```\n\nThat reads a.",
  },
  {
    name: "a call followed by prose (it may be an example)",
    text: "<function=Read>\n<parameter=filepath>\na\n</parameter>\n</function>\nThat is how a read looks.",
  },
  {
    name: "a tool that does not exist",
    text: "<function=DeleteEverything>\n<parameter=path>\n/\n</parameter>\n</function>",
  },
  {
    name: "an argument the schema does not declare",
    text: "<function=Read>\n<parameter=filepath>\na\n</parameter>\n<parameter=mode>\nrw\n</parameter>\n</function>",
  },
  {
    name: "a missing required argument",
    text: "<function=Write>\n<parameter=filepath>\na\n</parameter>\n</function>",
  },
  {
    name: "an argument of the wrong type",
    text: "<function=Bash>\n<parameter=command>\nls\n</parameter>\n<parameter=timeout>\nsoon\n</parameter>\n</function>",
  },
  {
    name: "a repeated argument",
    text: "<function=Read>\n<parameter=filepath>\na\n</parameter>\n<parameter=filepath>\nb\n</parameter>\n</function>",
  },
  {
    name: "a call cut off by max_tokens",
    text: "<function=Write>\n<parameter=filepath>\na\n</parameter>\n<parameter=content>\nhalf a fi",
  },
  {
    name: "a bad value is not made valid by folding the next parameter into it",
    text: "<function=Bash>\n<parameter=command>\nls\n</parameter>\n<parameter=timeout>\nsoon\n</parameter>\n<parameter=background>\ntrue\n</parameter>\n</function>",
  },
  {
    name: "a call in Python syntax (Nova's form, not Qwen's)",
    text: 'present_plan(title="x", decisions=[{"q": "a"}])',
  },
  {
    name: "JSON naming a tool (Hermes form, not Qwen's)",
    text: '{"name": "Read", "arguments": {"filepath": "a"}}',
  },
];

function runSplit(text: string, cuts: number[]) {
  const parser = new QwenXmlRecovery(tools);
  const events = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    events.push(...parser.push(text.slice(from, cut)));
    from = cut;
  }
  events.push(...parser.end());
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) =>
      e.type === "call"
        ? [{ name: e.call.name, arguments: e.call.arguments }]
        : [],
    ),
  };
}

// A small seeded generator so a failure reproduces.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("qwen-xml recovery: golden cases", () => {
  for (const g of golden) {
    it(g.name, () => {
      const out = recoverQwenXmlFromText(g.text, tools);
      expect(
        out.calls.map((c) => ({ ...c, raw: undefined, repairs: undefined })),
      ).toEqual(
        g.calls.map((c) => ({ ...c, raw: undefined, repairs: undefined })),
      );
      expect(out.text).toBe(g.text_after);
    });
  }
});

describe("qwen-xml recovery: text that must stay text", () => {
  for (const n of negatives) {
    it(n.name, () => {
      const out = recoverQwenXmlFromText(n.text, tools);
      expect(out.calls).toEqual([]);
      // Nothing is lost or invented: the reply comes back as it went in.
      expect(out.text).toBe(n.text);
    });
  }

  it("recoverQwenXmlCalls refuses a span that is not only calls", () => {
    expect(recoverQwenXmlCalls("hello", tools)).toBeUndefined();
    expect(recoverQwenXmlCalls("", tools)).toBeUndefined();
  });
});

describe("qwen-xml recovery: round trip", () => {
  const values: Record<string, unknown[]> = {
    string: [
      "a",
      "two words",
      "line one\nline two",
      "tail newline\n",
      "  padded  ",
      "<b>&amp;</b> a=b",
      '{"looks": "like json"}',
      "```fence```",
      "ünïcödé — ✓",
    ],
    integer: [0, 7, -3, 1200],
    boolean: [true, false],
    array: [[], [1, 2], [{ a: "x" }]],
  };
  const cases: { name: string; arguments: Record<string, unknown> }[] = [];
  for (const s of values.string) {
    cases.push({ name: "Write", arguments: { filepath: "f.txt", content: s } });
  }
  for (const i of values.integer) {
    for (const b of values.boolean) {
      cases.push({
        name: "Bash",
        arguments: { command: "echo hi", timeout: i, background: b },
      });
    }
  }
  for (const a of values.array) {
    cases.push({
      name: "PresentPlan",
      arguments: { title: "t", decisions: a },
    });
  }

  it.each(cases.map((c, i) => [i, c] as const))(
    "case %i parses back to what was rendered",
    (_i, c) => {
      const rendered = renderQwenXmlCall(c);
      const out = recoverQwenXmlFromText(rendered, tools);
      expect(out.text).toBe("");
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0].name).toBe(c.name);
      expect(out.calls[0].arguments).toEqual(c.arguments);
    },
  );
});

describe("qwen-xml recovery: chunk boundaries do not change the result", () => {
  const all = [
    ...golden.map((g) => ({ name: g.name, text: g.text })),
    ...negatives,
  ];

  for (const c of all) {
    it(`${c.name}: every single cut, one character at a time, and 60 random splits`, () => {
      const whole = runSplit(c.text, []);
      for (let cut = 1; cut < c.text.length; cut++) {
        expect(runSplit(c.text, [cut])).toEqual(whole);
      }
      const chars = Array.from({ length: c.text.length - 1 }, (_, i) => i + 1);
      expect(runSplit(c.text, chars)).toEqual(whole);
      const next = rng(c.text.length * 7919 + 13);
      for (let k = 0; k < 60; k++) {
        const cuts = chars.filter(() => next() < 0.15);
        expect(runSplit(c.text, cuts)).toEqual(whole);
      }
    });
  }

  it("never shows a half marker and loses no text", () => {
    const text = "before <tool_call> middle <func";
    const parser = new QwenXmlRecovery(tools);
    const shown: string[] = [];
    for (const ch of text) {
      for (const e of parser.push(ch)) {
        if (e.type === "text") shown.push(e.text);
      }
    }
    // While the stream is open nothing from the first marker on is shown.
    expect(shown.join("")).toBe("before ");
    for (const e of parser.end()) if (e.type === "text") shown.push(e.text);
    expect(shown.join("")).toBe(text);
  });
});

describe("qwen-xml recovery setting", () => {
  it("is off by default and for every model", () => {
    expect(
      qwenXmlRecoveryEnabled("qwen.qwen3-coder-30b-a3b-v1:0", {}, {}),
    ).toBe(false);
  });
  it("turns on from the environment or the request, for Qwen models only", () => {
    const model = "qwen.qwen3-coder-30b-a3b-v1:0";
    expect(
      qwenXmlRecoveryEnabled(
        model,
        {},
        { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "qwen-xml" },
      ),
    ).toBe(true);
    expect(
      qwenXmlRecoveryEnabled(
        model,
        { x_continue_recover_text_tool_calls: "qwen-xml" },
        {},
      ),
    ).toBe(true);
    expect(
      qwenXmlRecoveryEnabled(
        "us.amazon.nova-2-lite-v1:0",
        {},
        { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "qwen-xml" },
      ),
    ).toBe(false);
    expect(
      qwenXmlRecoveryEnabled(
        model,
        {},
        { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "1" },
      ),
    ).toBe(false);
  });
});

describe("qwen-xml recovery: Python booleans from the Qwen3.5 template", () => {
  const call = (value: string) =>
    `<tool_call>\n<function=Bash>\n<parameter=command>\nls\n</parameter>\n<parameter=background>\n${value}\n</parameter>\n</function>\n</tool_call>`;

  it("accepts True and False for a boolean-typed parameter", () => {
    expect(
      recoverQwenXmlFromText(call("True"), tools).calls[0]?.arguments,
    ).toEqual({ command: "ls", background: true });
    expect(
      recoverQwenXmlFromText(call("False"), tools).calls[0]?.arguments,
    ).toEqual({ command: "ls", background: false });
  });

  it("still accepts JSON true and false", () => {
    expect(
      recoverQwenXmlFromText(call("true"), tools).calls[0]?.arguments,
    ).toEqual({ command: "ls", background: true });
  });

  it("refuses other spellings and None", () => {
    for (const v of ["TRUE", "None", "yes", "1"]) {
      const out = recoverQwenXmlFromText(call(v), tools);
      expect(out.calls).toEqual([]);
      expect(out.text).toBe(call(v));
    }
  });

  it("never coerces a string-typed or untyped parameter", () => {
    const text = `<tool_call>\n<function=Write>\n<parameter=filepath>\na.txt\n</parameter>\n<parameter=content>\nTrue\n</parameter>\n</function>\n</tool_call>`;
    expect(recoverQwenXmlFromText(text, tools).calls[0]?.arguments).toEqual({
      filepath: "a.txt",
      content: "True",
    });
    const untyped: DialectTool[] = [
      {
        name: "Flag",
        parameters: { type: "object", properties: { on: {} } },
      },
    ];
    const t2 = `<tool_call>\n<function=Flag>\n<parameter=on>\nFalse\n</parameter>\n</function>\n</tool_call>`;
    expect(recoverQwenXmlFromText(t2, untyped).calls[0]?.arguments).toEqual({
      on: "False",
    });
  });

  it("refuses True for an integer-typed parameter", () => {
    const t = `<tool_call>\n<function=Bash>\n<parameter=command>\nls\n</parameter>\n<parameter=timeout>\nTrue\n</parameter>\n</function>\n</tool_call>`;
    expect(recoverQwenXmlFromText(t, tools).calls).toEqual([]);
  });
});
