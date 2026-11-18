import { renderEnvironment } from "core/util/environmentPrompt.js";
import { describe, expect, it, vi } from "vitest";

import { scenarioSnapshot } from "../stream/segmentScenarios.js";

import { doctorCommand } from "./doctor.js";
import { doctorEnvCommand } from "./doctorEnv.js";

const SNAPSHOT = scenarioSnapshot("2026-11-12");

async function run(options: Parameters<typeof doctorEnvCommand>[0]) {
  const lines: string[] = [];
  const code = await doctorEnvCommand({
    snapshot: SNAPSHOT,
    ...options,
    write: (l) => lines.push(l),
  });
  return { code, text: lines.join("\n") };
}

describe("continuous doctor env (ENV28)", () => {
  it("prints the three texts the request carries and the field table", async () => {
    const { code, text } = await run({ detail: "standard" });
    expect(code).toBe(0);
    const d = renderEnvironment(SNAPSHOT, {
      surface: "cli",
      detail: "standard",
    });
    for (const piece of [d.systemLine, d.toolSentence, d.firstMessageBlock]) {
      for (const line of piece.split("\n")) expect(text).toContain(line);
    }
    expect(text).toContain("Field");
    expect(text).toMatch(/user name\s+-\s+never/i);
    expect(text).toContain(
      "Nothing was sent to a model or the network to produce this.",
    );
    expect(text).not.toContain("/home/dev");
  });

  it("--json gives the renderer's object", async () => {
    const { code, text } = await run({ json: true, detail: "full" });
    expect(code).toBe(0);
    const out = JSON.parse(text);
    const d = renderEnvironment(SNAPSHOT, { surface: "cli", detail: "full" });
    expect(out).toMatchObject({
      surface: "cli",
      detail: "full",
      systemLine: d.systemLine,
      toolSentence: d.toolSentence,
      firstMessageBlock: d.firstMessageBlock,
      hash: d.hash,
      sessionHash: d.sessionHash,
    });
    expect(out.fields).toEqual(d.fieldReport);
  });

  it("previews another surface and refuses unknown values", async () => {
    const ide = await run({ json: true, surface: "ide-agent" });
    expect(JSON.parse(ide.text).systemLine).toContain("workspace folder");
    expect((await run({ surface: "phone" })).code).toBe(1);
    expect((await run({ detail: "everything" })).code).toBe(1);
  });

  it("gathers this folder without the network, and is reached as doctor env", async () => {
    const fetchSpy = vi.mocked(global.fetch);
    fetchSpy.mockClear();
    const lines: string[] = [];
    const code = await doctorCommand("env", [], {
      write: (l) => lines.push(l),
      env: { json: true },
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n")).firstMessageBlock).toContain(
      "Working folder:",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
