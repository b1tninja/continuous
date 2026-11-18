import fs from "fs";
import os from "os";
import path from "path";

import type { ChatHistoryItem, Session } from "core/index.js";

import {
  defaultTranscriptName,
  formatForPath,
  renderHtml,
  renderMarkdown,
  writeTranscript,
} from "./transcript.js";

/** Planted credentials: none may reach an export. */
const CANARIES = [
  "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789",
  "AKIAIOSFODNN7CANARY1",
  "ghp_CANARYCANARYCANARYCANARYCANARY0123",
];

const item = (
  role: "user" | "assistant" | "system" | "thinking" | "tool",
  content: string,
  extra: Partial<ChatHistoryItem> = {},
): ChatHistoryItem =>
  ({ message: { role, content }, contextItems: [], ...extra }) as never;

function session(): Session {
  return {
    sessionId: "1234-secret-session-id",
    title: "Fix the deploy script",
    workspaceDirectory: "/home/someone/private/repo",
    chatModelTitle: "secret-model-name",
    history: [
      item("system", "SYSTEM PROMPT TEXT"),
      item(
        "user",
        `deploy with AWS_ACCESS_KEY_ID=${CANARIES[1]} and token ${CANARIES[2]}`,
        {
          contextItems: [
            {
              name: "file.ts",
              description: "/home/someone/private/repo/file.ts",
              content: "ATTACHED FILE BODY",
              id: { providerTitle: "file", itemId: "1" },
            },
          ],
        },
      ),
      item("thinking", "PRIVATE REASONING"),
      item(
        "assistant",
        `<think>INLINE THOUGHT</think>I will run it.\n\n\`\`\`sh\necho ${CANARIES[0]}\n\`\`\``,
        {
          reasoning: { active: false, text: "MORE REASONING", startAt: 0 },
          toolCallStates: [
            {
              toolCallId: "c1",
              toolCall: {
                id: "c1",
                type: "function",
                function: { name: "Bash", arguments: "{}" },
              },
              status: "done",
              parsedArgs: {
                command: `curl -H "Authorization: Bearer ${CANARIES[0]}" https://x`,
              },
              output: [
                {
                  name: "r",
                  description: "r",
                  content: `ok ${CANARIES[0]}\n` + "line\n".repeat(2000),
                },
              ],
            },
          ],
        },
      ),
      item("tool", `RAW TOOL MESSAGE ${CANARIES[0]}`),
    ],
  } as Session;
}

describe("sanitised transcript", () => {
  it.each([
    ["md", renderMarkdown],
    ["html", renderHtml],
  ])("%s: no canary, no session JSON, no system prompt", (_f, render) => {
    const text = render(session(), { date: new Date("2026-11-12T00:00:00Z") });
    for (const c of CANARIES) expect(text).not.toContain(c);
    expect(text).toContain("«masked:");
    for (const hidden of [
      "SYSTEM PROMPT TEXT",
      "ATTACHED FILE BODY",
      "/home/someone",
      "1234-secret-session-id",
      "secret-model-name",
      "RAW TOOL MESSAGE",
      '"sessionId"',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("leaves reasoning out by default and puts it in when asked", () => {
    const plain = renderMarkdown(session());
    for (const r of ["PRIVATE REASONING", "INLINE THOUGHT", "MORE REASONING"]) {
      expect(plain).not.toContain(r);
    }
    const withReasoning = renderMarkdown(session(), { includeReasoning: true });
    expect(withReasoning).toContain("PRIVATE REASONING");
    expect(withReasoning).toContain("MORE REASONING");
    for (const c of CANARIES) expect(withReasoning).not.toContain(c);
  });

  it("has a header of the title and a date only", () => {
    const lines = renderMarkdown(session(), {
      date: new Date("2026-11-12T08:00:00Z"),
    }).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "# Fix the deploy script",
      "",
      "2026-11-12",
      "",
    ]);
  });

  it("cuts long tool output and says so", () => {
    const text = renderMarkdown(session(), { toolOutputChars: 100 });
    expect(text).toMatch(/_Output cut: 100 of \d+ characters shown\._/);
    expect(text.split("line\n").length).toBeLessThan(40);
  });

  it("fences tool output with more backticks than it contains", () => {
    const s = session();
    const state = s.history[3].toolCallStates![0];
    state.output = [{ name: "r", description: "r", content: "a\n```\nb" }];
    const text = renderMarkdown(s);
    expect(text).toContain("**Tool call: Bash** (done)");
    expect(text).toContain("````\na\n```\nb\n````");
  });

  it("HTML is escaped text with no script and a strict CSP", () => {
    const s = session();
    s.history.push(item("assistant", "<script>alert(1)</script><img src=x>"));
    const html = renderHtml(s);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
  });

  it("picks the format from the file name and names files after the title", () => {
    expect(formatForPath("a.HTML")).toBe("html");
    expect(formatForPath("a.md")).toBe("md");
    expect(defaultTranscriptName(session(), "md")).toMatch(
      /^fix-the-deploy-script-\d{4}-\d{2}-\d{2}\.md$/,
    );
  });
});

describe("writeTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-export-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses to replace a file without force", () => {
    const file = path.join(dir, "t.md");
    fs.writeFileSync(file, "mine");
    const refused = writeTranscript(file, "new");
    expect(refused.ok).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("mine");
    expect(writeTranscript(file, "new", true).ok).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("new");
  });
});
