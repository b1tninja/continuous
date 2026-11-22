// node --test: the parts of the render check that need no browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DOCS,
  docMarkdown,
  isRenderError,
  MARKER,
  pageCheck,
  verdict,
} from "../src/render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("render documents", () => {
  it("every document has a check in pageCheck, and every check a document", () => {
    const src = pageCheck.toString();
    const checks = [...src.matchAll(/^ {4}(\w+)\(\) \{$/gm)].map((m) => m[1]);
    assert.deepEqual(checks.sort(), Object.keys(DOCS).sort());
  });

  it("starts each document with the marker line pageCheck looks for", () => {
    const md = docMarkdown("tables");
    assert.equal(md.split("\n")[0], `${MARKER} tables`);
    assert.equal(md.split("\n")[1], "");
    assert.ok(pageCheck.toString().includes("`render-check ${name}`"));
  });

  it("keeps the backslashes of the math document", () => {
    const md = docMarkdown("math");
    assert.ok(md.includes("\\frac{1}{3}"));
    assert.ok(md.includes("\\(c^2\\)"));
    assert.ok(md.includes("$$\n\\int_0^1"));
  });

  it("uses the fixture that harness/fixtures.ts defines", () => {
    const fixtures = fs.readFileSync(
      path.join(here, "..", "harness", "fixtures.ts"),
      "utf8",
    );
    assert.ok(fixtures.includes('"render-markdown":'));
    assert.ok(fixtures.includes("__renderMarkdown"));
  });
});

describe("isRenderError", () => {
  it("takes React's production error and an error a boundary logged", () => {
    assert.ok(
      isRenderError(
        "Error: Minified React error #62; visit https://react.dev/errors/62",
      ),
    );
    assert.ok(isRenderError("TypeError: Cannot read properties of undefined"));
    assert.ok(isRenderError("Uncaught RangeError: Maximum call stack"));
  });

  it("leaves the mock IDE's unanswered message names alone", () => {
    for (const m of [
      "history/load",
      "policy/sessionIdgaf",
      "openaiCompat/probeStatus",
      "Failed to load resource: net::ERR_FAILED",
    ]) {
      assert.equal(isRenderError(m), false, m);
    }
  });
});

describe("verdict", () => {
  const clean = {
    pageErrors: [],
    consoleErrors: [],
    requests: [],
    problems: [],
  };

  it("passes a page with only the mock's console errors", () => {
    assert.deepEqual(
      verdict({ ...clean, consoleErrors: ["history/load"] }),
      [],
    );
  });

  it("fails on each kind of finding and names it", () => {
    assert.deepEqual(
      verdict({
        pageErrors: ["boom"],
        consoleErrors: ["history/load", "Error: Minified React error #62;"],
        requests: ["https://images.example.com/a.png"],
        problems: ["2 tables expected, 0 found"],
      }),
      [
        "pageerror: boom",
        "console: Error: Minified React error #62;",
        "request to another host: https://images.example.com/a.png",
        "2 tables expected, 0 found",
      ],
    );
  });
});
