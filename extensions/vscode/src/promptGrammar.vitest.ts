import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const packageJSON = require("../package.json");
const grammars: { language?: string; scopeName: string; path: string }[] =
  packageJSON.contributes.grammars;

describe("the .prompt grammar", () => {
  const grammar = grammars.find((g) => g.language === "promptLanguage");

  // Continue.continue contributes source.prompt. With both installed VS Code
  // keeps one grammar file per scope name and logs that it overwrote the other.
  it("does not use the original extension's scope name", () => {
    expect(grammar).toBeDefined();
    for (const g of grammars) {
      expect(g.scopeName).not.toBe("source.prompt");
    }
  });

  it("has the scope name its grammar file declares", () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", grammar!.path), "utf8"),
    );
    expect(file.scopeName).toBe(grammar!.scopeName);
  });
});
