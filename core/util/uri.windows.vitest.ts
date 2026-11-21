import { describe, expect, it } from "vitest";
import { findUriInDirs, normalizedUriPathParts } from "./uri";

const WS = "file:///c%3A/work/My-Project";

describe("normalizedUriPathParts: Windows drive letters", () => {
  it("gives one spelling for c: and C:, encoded colon or not", () => {
    const a = normalizedUriPathParts("file:///c%3A/work/x");
    const b = normalizedUriPathParts("file:///C:/work/x");
    expect(a).toEqual(b);
    expect(a[0]).toBe("c:");
  });
  it("leaves a POSIX path alone", () => {
    expect(normalizedUriPathParts("file:///home/Me/x")).toEqual([
      "home",
      "Me",
      "x",
    ]);
  });
});

describe("findUriInDirs: case", () => {
  const inside = "file:///C:/work/my-project/infra/main.tf";

  it("finds a path whose folder names differ in case when told to ignore case", () => {
    const r = findUriInDirs(inside, [WS], { caseInsensitive: true });
    expect(r.foundInDir).toBe(WS);
    expect(r.relativePathOrBasename).toBe("infra/main.tf");
  });

  it("does not, on a case-sensitive filesystem", () => {
    expect(
      findUriInDirs(inside, [WS], { caseInsensitive: false }).foundInDir,
    ).toBeNull();
  });

  it("still finds the exact spelling either way", () => {
    const exact = "file:///c%3A/work/My-Project/infra/main.tf";
    expect(
      findUriInDirs(exact, [WS], { caseInsensitive: false }).foundInDir,
    ).toBe(WS);
    expect(
      findUriInDirs(exact, [WS], { caseInsensitive: true }).foundInDir,
    ).toBe(WS);
  });

  it("does not treat a sibling folder as inside, with or without case folding", () => {
    const sibling = "file:///c%3A/work/My-Project-Other/x.tf";
    for (const caseInsensitive of [true, false]) {
      expect(
        findUriInDirs(sibling, [WS], { caseInsensitive }).foundInDir,
      ).toBeNull();
    }
  });

  it("does not let .. climb out, with case folding on", () => {
    const climb = "file:///c%3A/work/MY-PROJECT/../Other/x.tf";
    expect(
      findUriInDirs(climb, [WS], { caseInsensitive: true }).foundInDir,
    ).toBeNull();
  });
});
