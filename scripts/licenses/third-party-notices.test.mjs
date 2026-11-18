import assert from "node:assert/strict";
import test from "node:test";
import {
  analyse,
  isAllowed,
  licenseOf,
  render,
} from "./third-party-notices.mjs";

test("permissive licences pass, copyleft and unknown fail", () => {
  for (const ok of ["MIT", "(MIT OR GPL-3.0)", "Apache-2.0 AND MIT", "ISC"])
    assert.equal(isAllowed(ok), true, ok);
  for (const bad of [
    "GPL-3.0-only",
    "AGPL-3.0",
    "LGPL-3.0-or-later",
    "SSPL-1.0",
    "BUSL-1.1",
    "CC-BY-NC-4.0",
    "(MIT AND GPL-2.0)",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE",
    "",
    null,
  ])
    assert.equal(isAllowed(bad), false, String(bad));
});

test("old-style licence fields are read", () => {
  assert.equal(licenseOf({ license: { type: "MIT" } }), "MIT");
  assert.equal(
    licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "MIT OR Apache-2.0",
  );
  assert.equal(licenseOf({}), null);
});

test("exceptions need a reason and are matched by name, id or scope", () => {
  const pkgs = [
    { name: "@img/x", version: "1.0.0", license: "LGPL-3.0", text: "t" },
    { name: "a", version: "1.0.0", license: "GPL-3.0", text: "t" },
    { name: "b", version: "2.0.0", license: "MIT", text: "m" },
  ];
  const r = analyse(pkgs, { "@img/*": "dynamic native module" });
  assert.deepEqual(
    r.violations.map((p) => p.id),
    ["a@1.0.0"],
  );
  assert.equal(r.accepted.length, 2);
  assert.match(render(r.accepted), /dynamic native module/);
});

test("identical licence texts are written once", () => {
  const mk = (n) => ({
    name: n,
    version: "1.0.0",
    license: "MIT",
    text: "same text",
  });
  const out = render(analyse([mk("a"), mk("b"), mk("c")], {}).accepted);
  assert.equal(out.split("same text").length - 1, 1);
});
