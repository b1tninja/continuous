import { describe, expect, it } from "vitest";
import {
  checkName,
  draftFromForm,
  emptyForm,
  formFromDraft,
  formProblems,
  looksLikeCredentialName,
  parseSeconds,
  willRun,
  willRunLine,
} from "./mcpDialogForm";

describe("looksLikeCredentialName", () => {
  it.each([
    "API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "github-token",
    "CLIENT_SECRET",
    "MY_SECRET_VALUE",
    "DB_PASSWORD",
    "Authorization",
    "X-API-Key",
    "GITHUB_PAT",
    "Cookie",
  ])("%s starts as a secret", (name) => {
    expect(looksLikeCredentialName(name)).toBe(true);
  });

  it.each([
    "LOG_LEVEL",
    "PORT",
    "KEYBOARD_LAYOUT",
    "TOKENIZER",
    "Content-Type",
    "DATABASE_URL",
    "",
  ])("%s does not", (name) => {
    expect(looksLikeCredentialName(name)).toBe(false);
  });
});

describe("the form and the draft", () => {
  it("leaves every unset setting out of the draft", () => {
    const form = {
      ...emptyForm(),
      name: " fs ",
      command: " npx ",
      args: [
        { id: 1, value: "-y" },
        { id: 2, value: "C:\\My Docs" },
        // A row added and not filled in is not an argument
        { id: 3, value: "" },
      ],
    };
    expect(draftFromForm(form)).toEqual({
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "C:\\My Docs"],
      env: [],
    });
    expect(willRun(form)).toEqual(["npx", "-y", "C:\\My Docs"]);
    expect(willRunLine(form)).toBe("npx -y 'C:\\My Docs'");
  });

  it("writes what the person set: seconds become milliseconds", () => {
    expect(
      draftFromForm({
        ...emptyForm(),
        name: "fs",
        command: "npx",
        cwd: " D:\\tools ",
        timeoutSeconds: "2.5",
      }),
    ).toMatchObject({ cwd: "D:\\tools", connectionTimeoutMs: 2500 });
    // The tool call limit is its own number, and absent when not set
    const draft = draftFromForm({
      ...emptyForm(),
      name: "fs",
      command: "npx",
      toolTimeoutSeconds: "180",
    });
    expect(draft.toolTimeoutMs).toBe(180_000);
    expect(draft).not.toHaveProperty("connectionTimeoutMs");
  });

  it("keeps a guessed transport as not set, and a stated one as set", () => {
    const guessed = formFromDraft(
      { name: "a", transport: "sse", url: "https://a.example/sse" },
      { transportGuessed: true },
    );
    expect(guessed.transport).toBe("");
    expect(draftFromForm(guessed)).toMatchObject({
      transport: "sse",
      autoTransport: true,
    });
    const stated = formFromDraft({
      name: "a",
      transport: "sse",
      url: "https://a.example/sse",
    });
    expect(stated.transport).toBe("sse");
    expect(draftFromForm(stated)).not.toHaveProperty("autoTransport");
  });

  it("hides a held value in the preview", () => {
    const form = formFromDraft({
      name: "a",
      transport: "stdio",
      command: "server",
      args: ["--token", "${{ held.123e4567-e89b-42d3-a456-426614174000 }}"],
    });
    expect(willRun(form)).toEqual(["server", "--token", "(hidden value)"]);
    expect(form.args[1].stored).toBe("held");
  });

  it("names what stops Test and Save", () => {
    expect(formProblems(emptyForm())).toEqual({
      name: "Give the server a name.",
      command: "Enter the command to run.",
      scope: "Choose where to save it.",
    });
    expect(
      formProblems({
        ...emptyForm(),
        name: "a",
        kind: "url",
        url: "example.com/mcp",
        scope: "user",
        timeoutSeconds: "soon",
        headers: [
          { id: 1, name: "A", value: "1", secret: false },
          { id: 2, name: "a", value: "2", secret: false },
        ],
      }),
    ).toEqual({
      url: "Enter an address that starts with https:// or http://.",
      headers: "a is listed twice.",
      timeout: "Enter a number of seconds, such as 30.",
    });
  });

  it.each([
    ["30", 30],
    ["0.5", 0.5],
    ["0", undefined],
    ["-1", undefined],
    ["1e3", undefined],
    ["", undefined],
  ])("parseSeconds(%j)", (text, n) => {
    expect(parseSeconds(text)).toBe(n);
  });
});

describe("checkName", () => {
  const saved = [
    {
      name: "github",
      scope: "user" as const,
      file: "/h/config.yaml",
      transport: "stdio" as const,
      target: "",
      secrets: [],
      envNames: [],
      headerNames: [],
    },
    {
      name: "db",
      scope: "project" as const,
      folder: "/p",
      file: "/p/.continuous/mcpServers/db.yaml",
      transport: "stdio" as const,
      target: "",
      secrets: [],
      envNames: [],
      headerNames: [],
    },
  ];

  it("is silent until there is a name and a place", () => {
    expect(checkName({ name: "github" }, saved)).toEqual({});
    expect(checkName({ name: "", scope: "user" }, saved)).toEqual({});
    expect(checkName({ name: "new", scope: "user" }, saved)).toEqual({});
  });

  it("refuses the same name in the same place, whatever its case", () => {
    expect(checkName({ name: " GitHub ", scope: "user" }, saved).error).toBe(
      "A server called github is already saved for all your projects, in /h/config.yaml.",
    );
    expect(
      checkName({ name: "db", scope: "project", folder: "/p" }, saved).error,
    ).toBe(
      "A server called db is already saved for this workspace, in /p/.continuous/mcpServers/db.yaml.",
    );
  });

  it("refuses a workspace server named like one of yours: yours wins", () => {
    expect(
      checkName({ name: "github", scope: "project", folder: "/p" }, saved)
        .error,
    ).toMatch(/yours would be used instead/);
  });

  it("allows your own server over a workspace one, and says what follows", () => {
    const r = checkName({ name: "db", scope: "user" }, saved);
    expect(r.error).toBeUndefined();
    expect(r.note).toMatch(
      /Yours will be used and the workspace one will not start/,
    );
  });

  it("does not collide with the server being edited", () => {
    expect(
      checkName({ name: "github", scope: "user" }, saved, {
        name: "github",
        scope: "user",
      }),
    ).toEqual({});
  });
});
