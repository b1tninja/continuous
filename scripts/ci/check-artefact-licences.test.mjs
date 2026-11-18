import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED, missing, zipNames } from "./check-artefact-licences.mjs";

test("a complete VSIX list passes, LICENSE.txt or LICENSE", () => {
  const base = ["extension/NOTICE", "extension/THIRD_PARTY_NOTICES.txt"];
  assert.deepEqual(
    missing([...base, "extension/LICENSE.txt"], REQUIRED.vsix),
    [],
  );
  assert.deepEqual(missing([...base, "extension/LICENSE"], REQUIRED.vsix), []);
});

test("a VSIX without NOTICE fails", () => {
  const r = missing(
    ["extension/LICENSE.txt", "extension/THIRD_PARTY_NOTICES.txt"],
    REQUIRED.vsix,
  );
  assert.deepEqual(r, [["extension/NOTICE"]]);
});

test("a CLI tarball with only LICENSE fails on both other files", () => {
  const r = missing(["package/LICENSE", "package/dist/index.js"], REQUIRED.tgz);
  assert.equal(r.length, 2);
});

test("zip central directory names are read", () => {
  const name = Buffer.from("extension/NOTICE");
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(name.length, 28);
  name.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(0, 16);
  assert.deepEqual(zipNames(Buffer.concat([cd, eocd])), ["extension/NOTICE"]);
});
