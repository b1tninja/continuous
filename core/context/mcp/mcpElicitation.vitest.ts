import { describe, expect, it } from "vitest";

import {
  answerElicitationWithoutAsking,
  elicitationHandler,
} from "./mcpElicitation";

const form = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  mode: "form",
  message: "Which one?",
  requestedSchema: { type: "object", properties, required },
});

describe("answering an MCP elicitation without asking", () => {
  it("accepts with the server's own defaults when every field has one", () => {
    const out = answerElicitationWithoutAsking(
      form({
        region: { type: "string", default: "eu" },
        retries: { type: "number", default: 3 },
        dryRun: { type: "boolean", default: true },
      }),
    );
    expect(out.response).toEqual({
      action: "accept",
      content: { region: "eu", retries: 3, dryRun: true },
    });
    expect(out.note).toContain("server's own defaults");
  });

  it("skips an optional field with no default", () => {
    const out = answerElicitationWithoutAsking(
      form({ a: { type: "string", default: "x" }, b: { type: "string" } }),
    );
    expect(out.response).toEqual({ action: "accept", content: { a: "x" } });
  });

  it("declines a required field with no default, naming it", () => {
    const out = answerElicitationWithoutAsking(
      form({ team: { type: "string" } }, ["team"]),
    );
    expect(out.response).toEqual({ action: "decline" });
    expect(out.note).toContain('"team"');
  });

  it("declines a form that asks for a secret, even with a default", () => {
    for (const field of [
      { password: { type: "string", default: "hunter2" } },
      { api_key: { type: "string", default: "k" } },
      { x: { type: "string", format: "password", default: "k" } },
      { x: { type: "string", title: "Access token", default: "k" } },
    ]) {
      const out = answerElicitationWithoutAsking(form(field));
      expect(out.response, JSON.stringify(field)).toEqual({
        action: "decline",
      });
      expect(out.note).toContain("secret");
    }
  });

  it("declines a form with no fields and a url-mode request", () => {
    expect(answerElicitationWithoutAsking(form({})).response.action).toBe(
      "decline",
    );
    const url = answerElicitationWithoutAsking({
      mode: "url",
      url: "https://example.com/auth",
      message: "Sign in",
    });
    expect(url.response.action).toBe("decline");
    expect(url.note).toContain("page");
  });
});

describe("the handler a modern MCP client uses", () => {
  const request = {
    method: "elicitation/create",
    params: form({ region: { type: "string", default: "eu" } }),
  };

  it("at IDGAF answers with the defaults and records it", async () => {
    const notes: string[] = [];
    const handler = elicitationHandler(
      () => "idgaf",
      (n) => notes.push(n),
    );
    expect(await handler("k", request)).toEqual({
      action: "accept",
      content: { region: "eu" },
    });
    expect(notes[0]).toContain("Accepted");
  });

  it.each([
    "manual",
    "cautious",
    "automatic",
    "permissive",
    undefined,
  ] as const)(
    "at %s the request is declined: no form is ever put to the person",
    async (level) => {
      const handler = elicitationHandler(
        () => level,
        () => {
          throw new Error("must not record");
        },
      );
      expect(await handler("k", request)).toEqual({ action: "decline" });
    },
  );

  it("any other server request is an error", async () => {
    const handler = elicitationHandler(() => "idgaf");
    await expect(handler("k", { method: "sampling/create" })).rejects.toThrow(
      /Unsupported/,
    );
  });
});
