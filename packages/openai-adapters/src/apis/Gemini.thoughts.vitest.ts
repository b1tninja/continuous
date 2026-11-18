import { describe, expect, it, vi } from "vitest";

import { GeminiApi, returnsThoughts } from "./Gemini.js";

const api = () =>
  new GeminiApi({ provider: "gemini", apiKey: "k" } as any) as any;

async function* stream(chunks: any[]) {
  for (const c of chunks) yield c;
}

const chunk = (parts: any[], finishReason?: string) => ({
  candidates: [{ content: { parts }, ...(finishReason && { finishReason }) }],
});

describe("Gemini thought summaries", () => {
  it("asks thinking models to return their thoughts, and no other model", () => {
    for (const model of [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3-pro-preview",
      "gemini-flash-latest",
    ]) {
      expect(returnsThoughts(model)).toBe(true);
    }
    for (const model of [
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-preview-tts",
      "gemini-embedding-001",
    ]) {
      expect(returnsThoughts(model)).toBe(false);
    }
  });

  it("sends includeThoughts in the request config of a thinking model", async () => {
    const generateContentStream = vi.fn().mockResolvedValue(stream([]));
    const genAI = { models: { generateContentStream } } as any;
    const body = {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    for await (const _ of api().streamWithGenAI(genAI, body)) {
    }
    expect(
      generateContentStream.mock.calls[0][0].config.thinkingConfig,
    ).toEqual({ includeThoughts: true });

    generateContentStream.mockClear();
    generateContentStream.mockResolvedValue(stream([]));
    for await (const _ of api().streamWithGenAI(genAI, {
      ...body,
      model: "gemini-2.0-flash",
    })) {
    }
    expect(
      generateContentStream.mock.calls[0][0].config.thinkingConfig,
    ).toBeUndefined();
  });

  it("streams thought parts as reasoning_content, never as the answer", async () => {
    const out: any[] = [];
    for await (const c of api().processStreamResponse(
      stream([
        chunk([{ text: "Reading the file first.", thought: true }]),
        chunk([{ text: "The answer." }], "STOP"),
      ]),
      "gemini-2.5-pro",
    )) {
      out.push(c.choices?.[0]?.delta);
    }
    const deltas = out.filter(Boolean);
    expect(deltas.map((d) => d.reasoning_content).filter(Boolean)).toEqual([
      "Reading the file first.",
    ]);
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("The answer.");
  });

  it("keeps thoughts out of a non-streamed completion", async () => {
    const gemini = api();
    gemini.generateStream = vi
      .fn()
      .mockResolvedValue(
        stream([
          chunk([{ text: "Thinking it over.", thought: true }]),
          chunk([{ text: "Answer." }], "STOP"),
        ]),
      );
    const result = await gemini.chatCompletionNonStream(
      { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );
    expect(result.choices[0].message.content).toBe("Answer.");
  });
});
