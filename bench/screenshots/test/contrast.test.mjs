// WCAG contrast of the policy chips and the secondary text, computed from the
// harness themes (harness/themes.ts) through the gui's token table
// (gui/src/styles/theme.ts): the first `--vscode-*` variable a theme defines
// wins, else the token's default. Asserts at least 4.5:1 in both themes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, "..", "..", "..", ...p), "utf8");

function themeVars(name) {
  const src = read("bench/screenshots/harness/themes.ts");
  const block = (n) => {
    const start = src.indexOf("const " + n);
    const open = src.indexOf("{", src.indexOf("=", start));
    return src.slice(open, src.indexOf("};", open));
  };
  const parse = (b) => Object.fromEntries([...b.matchAll(/"?([\w-]+)"?:\s*"(#[0-9a-fA-F]{6,8})"/g)].map((m) => [m[1], m[2]]));
  const dark = parse(block("dark"));
  return name === "dark" ? dark : { ...dark, ...parse(block("light")) };
}

function tokenTable() {
  const src = read("gui/src/styles/theme.ts");
  const table = {};
  for (const m of src.matchAll(/"?([\w-]+)"?: \{\s*vars: \[([^\]]*)\],\s*default: "(#[0-9a-fA-F]{6,8})"/g)) {
    table[m[1]] = { vars: [...m[2].matchAll(/--vscode-([\w-]+)/g)].map((v) => v[1]), def: m[3] };
  }
  return table;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

export function colours(theme) {
  const vars = themeVars(theme);
  const table = tokenTable();
  const token = (name) => {
    const t = table[name];
    const v = t.vars.find((x) => vars[x]);
    return rgb(v ? vars[v] : t.def);
  };
  return { token, lightgray: rgb("#999998") };
}

// [label, text token, background builder]
const CASES = (c) => {
  const panel = c.token("input-background");
  const page = c.token("editor-background");
  const tint = (tok) => over(c.token(tok), 0.2, panel);
  return [
    ["chip Manual/Careful text on success tint", "foreground", tint("success")],
    ["chip Automatic text on link tint", "foreground", tint("link")],
    ["chip Permissive text on warning tint", "foreground", tint("warning")],
    ["chip IDGAF text on error tint", "foreground", tint("error")],
    ["Mode and preset chip text on gray tint", "foreground", over(c.lightgray, 0.2, panel)],
    ["loop panel secondary text (pending, budget:, Loops)", "description", panel],
    ["tool-call hints", "description", panel],
    ["Last Session", "description", page],
  ];
};

describe("contrast of chips and secondary text", () => {
  for (const theme of ["dark", "light"]) {
    const c = colours(theme);
    for (const [label, tok, bg] of CASES(c)) {
      it(`${theme}: ${label} >= 4.5:1`, () => {
        const r = ratio(c.token(tok), bg);
        assert.ok(r >= 4.5, `${theme} ${label}: ${r.toFixed(2)}:1`);
      });
    }
  }
  it("the old colours were below 4.5:1 on light (the finding)", () => {
    const c = colours("light");
    const panel = c.token("input-background");
    assert.ok(ratio(c.token("success"), over(c.token("success"), 0.2, panel)) < 3);
    assert.ok(ratio(c.token("description-muted"), panel) < 4.5);
  });
});
