import * as nodePosix from "node:path/posix";
import { describe, expect, it } from "vitest";
import { posixDirname, posixJoin, posixNormalize } from "./posixPath";

/** A small, repeatable generator (mulberry32), so a failure can be reproduced. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = [
  ".",
  "..",
  "",
  "a",
  "b",
  "dir",
  ".ssh",
  "x y",
  "C:",
  "~",
  "...",
  "a.b",
];

function randomPath(next: () => number): string {
  const n = Math.floor(next() * 7);
  const lead = ["", "/", "//", "///"][Math.floor(next() * 4)];
  const parts: string[] = [];
  for (let i = 0; i < n; i++)
    parts.push(SEGMENTS[Math.floor(next() * SEGMENTS.length)]);
  const trail = next() < 0.3 ? "/" : "";
  return lead + parts.join("/") + trail;
}

describe("posixNormalize agrees with node:path/posix", () => {
  it("on named cases", () => {
    const cases = [
      "",
      ".",
      "..",
      "/",
      "//",
      "a/b/../c",
      "a/./b",
      "/a/../..",
      "../../a",
      "a//b///c",
      "a/b/",
      "/a/b/..",
      "a/..",
      "a/../..",
      "./",
      "../",
      "/..",
      "/../a",
      "~/a/../b",
      "C:/a/../b",
    ];
    for (const c of cases) {
      expect(posixNormalize(c), JSON.stringify(c)).toBe(nodePosix.normalize(c));
    }
  });

  it("on 20,000 generated paths", () => {
    const next = rng(1);
    for (let i = 0; i < 20_000; i++) {
      const p = randomPath(next);
      expect(posixNormalize(p), JSON.stringify(p)).toBe(nodePosix.normalize(p));
    }
  });
});

describe("posixJoin agrees with node:path/posix", () => {
  it("on named cases", () => {
    const cases: string[][] = [
      [],
      [""],
      ["", ""],
      ["a"],
      ["a", "b"],
      ["/a", "b"],
      ["a", "../b"],
      ["a", "../../b"],
      ["/", "a"],
      ["a/", "/b"],
      ["", "a"],
      ["a", ""],
      [".", "."],
      ["/a/b", "..", ".."],
      ["C:/Users/u", ".ssh"],
    ];
    for (const c of cases) {
      expect(posixJoin(...c), JSON.stringify(c)).toBe(nodePosix.join(...c));
    }
  });

  it("on 20,000 generated pairs and triples", () => {
    const next = rng(2);
    for (let i = 0; i < 20_000; i++) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
        randomPath(next),
      );
      expect(posixJoin(...parts), JSON.stringify(parts)).toBe(
        nodePosix.join(...parts),
      );
    }
  });
});

describe("posixDirname agrees with node:path/posix", () => {
  it("on named cases", () => {
    const cases = [
      "",
      "/",
      "//",
      "a",
      "/a",
      "a/b",
      "/a/b",
      "/a/b/",
      "a/b/",
      "a//b",
      "//a",
      "///a/b",
      "/home/u",
      "C:/Users/u",
      "C:/",
      "./a",
      "../a",
      "a/",
      "a//",
    ];
    for (const c of cases) {
      expect(posixDirname(c), JSON.stringify(c)).toBe(nodePosix.dirname(c));
    }
  });

  it("on 20,000 generated paths", () => {
    const next = rng(3);
    for (let i = 0; i < 20_000; i++) {
      const p = randomPath(next);
      expect(posixDirname(p), JSON.stringify(p)).toBe(nodePosix.dirname(p));
    }
  });
});
