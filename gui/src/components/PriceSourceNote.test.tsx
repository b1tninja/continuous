import { render, screen } from "@testing-library/react";
import { setCommunityCatalog } from "core/llm/utils/communityPricing";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMLog } from "../hooks/useLLMLog";
import { renderWithProviders } from "../util/test/render";
import TotalUsage from "./console/TotalUsage";
import { PriceSourceNote } from "./PriceSourceNote";

const NOW = Date.parse("2026-11-13T12:00:00Z");

describe("PriceSourceNote", () => {
  it("one line per source kind", () => {
    render(
      <PriceSourceNote
        now={NOW}
        sources={[
          {
            kind: "curated",
            label: "Anthropic list prices",
            asOf: "2026-11-02",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("price-source-note").textContent).toBe(
      "Prices: Anthropic list prices, as of 2026-11-02",
    );
  });

  it("joins sources and adds the served-tier note", () => {
    render(
      <PriceSourceNote
        now={NOW}
        sources={[
          {
            kind: "provider",
            label: "AWS Price List",
            asOf: "2026-11-13T09:00:00Z",
          },
          { kind: "user", label: "Your price" },
          {
            kind: "community",
            label: "community catalogue (models.dev)",
            asOf: "2026-11-10T08:00:00Z",
          },
        ]}
        servedTiers={["priority"]}
      />,
    );
    const lines = Array.from(
      screen.getByTestId("price-source-note").children,
    ).map((c) => c.textContent);
    expect(lines).toEqual([
      "Prices: AWS Price List, fetched 3 h ago; your config; community catalogue (models.dev), 2026-11-10 — estimate",
      "Prices: standard tier; the provider served this request at the priority tier, which is billed at a premium, so the actual charge is higher",
    ]);
  });

  it("renders nothing without a source", () => {
    const { container } = render(<PriceSourceNote sources={[undefined]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("console Total Usage", () => {
  afterEach(() => setCommunityCatalog(undefined));

  const log = (provider: string, model: string): LLMLog => ({
    loading: false,
    order: ["a"],
    interactions: new Map([
      [
        "a",
        {
          start: {
            kind: "startChat",
            provider,
            options: { model },
          },
          end: {
            kind: "success",
            promptTokens: 1000,
            generatedTokens: 100,
            thinkingTokens: 0,
            usage: { promptTokens: 1000, completionTokens: 100 },
          },
          results: [],
        } as never,
      ],
    ]),
  });

  it("shows where the total's prices came from", async () => {
    await renderWithProviders(
      <TotalUsage llmLog={log("anthropic", "claude-sonnet-4-5")} />,
    );
    expect(screen.getByTestId("price-source-note").textContent).toMatch(
      /^Prices: Anthropic list prices, as of \d{4}-\d{2}-\d{2}$/,
    );
  });

  it("labels a community price as an estimate with its date", async () => {
    setCommunityCatalog({
      schemaVersion: 1,
      source: "https://models.dev/api.json",
      fetchedAt: "2026-11-10T08:00:00.000Z",
      prices: [
        {
          provider: "mistral",
          id: "mistral-large-latest",
          input: 0.7,
          output: 2.1,
        },
      ],
    });
    await renderWithProviders(
      <TotalUsage llmLog={log("mistral", "mistral-large-latest")} />,
    );
    expect(screen.getByTestId("price-source-note").textContent).toBe(
      "Prices: community catalogue (models.dev), 2026-11-10 — estimate",
    );
  });
});
