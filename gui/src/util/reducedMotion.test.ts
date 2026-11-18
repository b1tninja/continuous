import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  highContrastActive,
  prefersReducedMotion,
  usingScreenReader,
} from "./reducedMotion";

const win = (matches: Record<string, boolean>) =>
  ({
    matchMedia: (q: string) => ({ matches: !!matches[q] }),
  }) as unknown as Pick<Window, "matchMedia">;

const doc = (...classes: string[]) => {
  const body = document.createElement("body");
  body.classList.add(...classes);
  return { body } as Pick<Document, "body">;
};

describe("reduced motion", () => {
  afterEach(() => document.body.removeAttribute("class"));

  it("is on for the VS Code class alone", () => {
    expect(prefersReducedMotion(doc("vscode-reduce-motion"), win({}))).toBe(
      true,
    );
  });

  it("is on for the system setting alone", () => {
    expect(
      prefersReducedMotion(
        doc(),
        win({ "(prefers-reduced-motion: reduce)": true }),
      ),
    ).toBe(true);
  });

  it("is off when neither says so", () => {
    expect(prefersReducedMotion(doc("vscode-dark"), win({}))).toBe(false);
  });

  it("follows the real body class", () => {
    expect(prefersReducedMotion()).toBe(false);
    document.body.classList.add("vscode-reduce-motion");
    expect(prefersReducedMotion()).toBe(true);
  });

  it("reads the screen reader class", () => {
    expect(usingScreenReader(doc("vscode-using-screen-reader"))).toBe(true);
    expect(usingScreenReader(doc("vscode-dark"))).toBe(false);
  });

  it("sees both high contrast themes and forced colours", () => {
    expect(highContrastActive(doc("vscode-high-contrast"), win({}))).toBe(true);
    expect(highContrastActive(doc("vscode-high-contrast-light"), win({}))).toBe(
      true,
    );
    expect(
      highContrastActive(doc(), win({ "(forced-colors: active)": true })),
    ).toBe(true);
    expect(highContrastActive(doc("vscode-light"), win({}))).toBe(false);
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

  it("stops animation under both signals", () => {
    expect(css).toMatch(
      /body\.vscode-reduce-motion \*[\s\S]*?animation: none !important/,
    );
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*/);
  });

  it("keeps chips and focus visible when colours are forced", () => {
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("body.vscode-high-contrast .gui-chip");
    expect(css).toContain("*:focus-visible");
  });
});
