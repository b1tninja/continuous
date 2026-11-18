import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { reviewEvalCommand, type ReviewEvalDeps } from "./reviewEval.js";

const DATASET = join(
  __dirname,
  "../../../../core/tools/permissions/auto/evaluation/datasets/reviewer-starter.json",
);
const text = readFileSync(DATASET, "utf8");
const dataset = JSON.parse(text);

function setup(chat?: ReviewEvalDeps["createClient"]) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  const createClient = vi.fn(
    chat ??
      (async () => ({
        model: "fake-model",
        client: {
          chat: async (messages: any[]) => {
            const body = String(messages[1].content);
            const hit = dataset.cases.find(
              (c: any) =>
                body.includes(`arguments: ${JSON.stringify(c.args)}`) &&
                body.includes(`1. ${c.history.userMessages[0]}`),
            );
            return {
              role: "assistant",
              content: JSON.stringify(
                hit?.expected === "allow"
                  ? { decision: "allow", reason: "ok" }
                  : {
                      decision: hit?.expected ?? "ask",
                      category: hit?.category ?? "uncertain",
                      reason: "labelled",
                    },
              ),
            };
          },
        } as any,
      })),
  );
  const deps: ReviewEvalDeps = {
    readFile: (p) => {
      if (p === "ds.json") return text;
      if (p === "g.md") return "- Ask before touching infra/\n";
      throw new Error(`ENOENT ${p}`);
    },
    createClient,
    describeModel: vi.fn(async () => null),
    writeFile: (path, t) => {
      files[path] = t;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, createClient, files };
}

describe("continuous reviewer eval", () => {
  it("is a dry run by default: prints a cost plan and builds no client", async () => {
    const { deps, out, createClient } = setup();
    const code = await reviewEvalCommand({ dataset: "ds.json" }, deps);
    expect(code).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    const all = out.join("\n");
    expect(all).toContain("Dry run: no model was called");
    expect(all).toContain("--run");
    expect(all).toMatch(/Calls: 80 /);
  });

  it("dry run with --json is machine-readable and still calls nothing", async () => {
    const { deps, out, createClient } = setup();
    await reviewEvalCommand(
      { dataset: "ds.json", compare: "default", json: true },
      deps,
    );
    expect(createClient).not.toHaveBeenCalled();
    const j = JSON.parse(out.join("\n"));
    expect(j.dryRun).toBe(true);
    expect(j.plan.configs).toBe(2);
    expect(j.plan.calls).toBe(160);
  });

  it("--run scores, prints the cost plan first and exits 0 on a clean run", async () => {
    const { deps, out, createClient } = setup();
    const code = await reviewEvalCommand(
      { dataset: "ds.json", reviewer: "fake", run: true },
      deps,
    );
    expect(code).toBe(0);
    expect(createClient).toHaveBeenCalledWith("fake", undefined);
    const all = out.join("\n");
    expect(all.indexOf("Estimated input")).toBeLessThan(
      all.indexOf("Agreement, lenient"),
    );
    expect(all).toContain("False-allow on floor cases");
    expect(all).toContain("Format-failure rate");
    expect(all).toContain("By policy area");
    expect(all).toContain("insufficient data"); // no baseline given
  });

  it("A/B with --compare reports paired counts and a safe verdict", async () => {
    const { deps, out } = setup();
    const code = await reviewEvalCommand(
      {
        dataset: "ds.json",
        guidance: "g.md",
        compare: "default",
        run: true,
        json: true,
      },
      deps,
    );
    expect(code).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.gate.verdict).toBe("safe to adopt");
    expect(j.paired.falseAllow.n).toBeGreaterThan(0);
    expect(j.metrics.floorFalseAllow.k).toBe(0);
  });

  it("exits 1 when the candidate allows a floor case", async () => {
    const { deps, out } = setup(async () => ({
      model: "bad",
      client: {
        chat: async () => ({
          role: "assistant",
          content: '{"decision":"allow","reason":"fine"}',
        }),
      } as any,
    }));
    const code = await reviewEvalCommand(
      { dataset: "ds.json", run: true, compare: "default" },
      deps,
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("not safe to adopt");
  });

  it("reports a missing dataset, a bad file and a missing reviewer", async () => {
    const a = setup();
    expect(await reviewEvalCommand({}, a.deps)).toBe(1);
    expect(a.err.join("\n")).toContain("--dataset");

    const b = setup();
    expect(await reviewEvalCommand({ dataset: "nope.json" }, b.deps)).toBe(1);
    expect(b.err.join("\n")).toContain("ENOENT");

    const c = setup(async () => null);
    expect(
      await reviewEvalCommand({ dataset: "ds.json", run: true }, c.deps),
    ).toBe(1);
    expect(c.err.join("\n")).toContain("No reviewer model");
  });

  it("--config reaches the client builder", async () => {
    const { deps, createClient } = setup();
    await reviewEvalCommand(
      { dataset: "ds.json", run: true, config: "rev.yaml" },
      deps,
    );
    expect(createClient).toHaveBeenCalledWith(undefined, "rev.yaml");
  });

  it("--outcomes writes one JSONL line per case and run, with no case text", async () => {
    const { deps, files } = setup();
    await reviewEvalCommand(
      { dataset: "ds.json", run: true, repeat: 2, outcomes: "o.jsonl" },
      deps,
    );
    const lines = files["o.jsonl"]
      .trim()
      .split(String.fromCharCode(10))
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(160);
    expect(lines[0]).toHaveProperty("rawReply");
    expect(lines[0]).toHaveProperty("verdict");
    expect(files["o.jsonl"]).not.toContain("Why does the login page");
  });

  it("--repeat reports stability and the plan counts the repeats", async () => {
    const { deps, out } = setup();
    await reviewEvalCommand(
      { dataset: "ds.json", run: true, repeat: 3, json: true },
      deps,
    );
    const j = JSON.parse(out.join("\n"));
    expect(j.metrics.stability.runs).toBe(3);
    expect(j.plan.calls).toBe(240);
  });

  it("a floor case allowed in only one repeat fails the gate", async () => {
    let n = 0;
    const { deps } = setup(async () => ({
      model: "flaky",
      client: {
        chat: async () => {
          n++;
          // allow everything during the third pass only
          const allow = n > 160 && n <= 240;
          return {
            role: "assistant",
            content: allow
              ? '{"decision":"allow","reason":"x"}'
              : '{"decision":"ask","category":"uncertain","reason":"x"}',
          };
        },
      } as any,
    }));
    const code = await reviewEvalCommand(
      { dataset: "ds.json", run: true, repeat: 3, concurrency: 1 },
      deps,
    );
    expect(code).toBe(1);
  });

  it("dry run prints an estimated cost line and a reasoning warning", async () => {
    const { deps, out } = setup();
    deps.describeModel = async () => ({
      provider: "bedrock",
      model: "us.amazon.nova-2-lite-v1:0",
    });
    await reviewEvalCommand({ dataset: "ds.json", maxTokens: 300 }, deps);
    const all = out.join("\n");
    expect(all).toContain("Estimated cost:");
    expect(all).toContain("WARNING");
  });
  it("--prompt v3 sends the tightened prompt for the candidate only", async () => {
    const seen: string[] = [];
    const { deps, out } = setup(async () => ({
      model: "m",
      client: {
        chat: async (messages: any[]) => {
          seen.push(String(messages[0].content));
          return {
            role: "assistant",
            content: '{"decision":"ask","category":"uncertain","reason":"r"}',
          };
        },
      } as any,
    }));
    const code = await reviewEvalCommand(
      {
        dataset: "ds.json",
        prompt: "v3",
        compare: "default",
        run: true,
        json: true,
        concurrency: 1,
      },
      deps,
    );
    expect(code).toBeGreaterThanOrEqual(0);
    expect(seen.some((p) => p.includes("Check the categories first"))).toBe(
      true,
    );
    expect(seen.some((p) => p.includes("Two scores, then the outcome"))).toBe(
      true,
    );
    expect(JSON.parse(out.join("\n")).candidate.label).toBe(
      "built-in prompt v3",
    );
  });

  it("--prompt takes default or v3", async () => {
    const { deps, err } = setup();
    expect(
      await reviewEvalCommand({ dataset: "ds.json", prompt: "v4" }, deps),
    ).toBe(1);
    expect(err.join("\n")).toContain("--prompt takes default or v3");
  });
});
