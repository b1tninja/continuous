import { describe, expect, it, vi } from "vitest";
import { classifyDrop, DropItem, FileLike } from "./classifyDrop";
import { explorerDrag, fakeFile, osFileDrag, WS } from "./dropFixtures";
import {
  checkImages,
  describeDropOutcome,
  DropHost,
  isCredentialPath,
  MAX_IMAGE_BYTES,
  outcomeNeedsNote,
  resolveResources,
} from "./resolveDrop";
import { sanitizeDroppedText } from "./sanitizeDroppedText";

/** A workspace with src/ (a.ts, b.ts), docs/ and the files listed. */
function fakeHost(): DropHost & {
  calls: string[];
} {
  const tree: Record<string, [string, number][]> = {
    [WS]: [
      ["src", 2],
      ["docs", 2],
      ["README.md", 1],
      [".env", 1],
      ["link.ts", 1 | 64],
    ],
    [`${WS}/src`]: [
      ["a.ts", 1],
      ["b.ts", 1],
    ],
  };
  const calls: string[] = [];
  return {
    calls,
    getWorkspaceDirs: vi.fn(async () => {
      calls.push("getWorkspaceDirs");
      return [WS];
    }),
    listDir: vi.fn(async (dir: string) => {
      calls.push(`listDir ${dir}`);
      return tree[dir] ?? [];
    }),
  };
}

const both = { file: true, folder: true };

describe("resolveResources", () => {
  it("turns workspace files and folders into mentions", async () => {
    const host = fakeHost();
    const items = classifyDrop(
      explorerDrag([`${WS}/src/a.ts`, `${WS}/README.md`], [`${WS}/docs`]),
    );
    const result = await resolveResources(items, host, both);
    expect(result.refusals).toEqual([]);
    expect(result.mentions).toEqual([
      {
        kind: "folder",
        uri: `${WS}/docs`,
        name: "docs",
        relativePath: "docs",
      },
      {
        kind: "file",
        uri: `${WS}/src/a.ts`,
        name: "a.ts",
        relativePath: "src/a.ts",
      },
      {
        kind: "file",
        uri: `${WS}/README.md`,
        name: "README.md",
        relativePath: "README.md",
      },
    ]);
  });

  it("uses the host's answer for file or folder, not the drag's guess", async () => {
    const host = fakeHost();
    const items: DropItem[] = [
      {
        kind: "folder",
        source: "explorer",
        name: "a.ts",
        uri: `${WS}/src/a.ts`,
      },
      { kind: "file", source: "explorer", name: "src", uri: `${WS}/src` },
    ];
    const result = await resolveResources(items, host, both);
    expect(result.mentions.map((m) => m.kind)).toEqual(["file", "folder"]);
  });

  it("refuses a credential file without asking the host anything about it", async () => {
    const host = fakeHost();
    const items = classifyDrop(explorerDrag([`${WS}/.env`]));
    const result = await resolveResources(items, host, both);
    expect(result.mentions).toEqual([]);
    expect(result.refusals).toEqual([{ name: ".env", reason: "secret" }]);
    expect(host.calls).toEqual(["getWorkspaceDirs"]);
  });

  it.each([
    `${WS}/deploy/server.pem`,
    `${WS}/tls.key`,
    `${WS}/.ssh/id_rsa`,
    `${WS}/.env.local`,
    `${WS}/.aws/credentials`,
    "file:///Users/user/.ssh/id_ed25519",
  ])("refuses %s as a secret", async (uri) => {
    const host = fakeHost();
    const result = await resolveResources(
      [{ kind: "file", source: "explorer", name: uri.split("/").pop()!, uri }],
      host,
      both,
    );
    expect(result.refusals[0]?.reason).toBe("secret");
    expect(host.calls.filter((c) => c.startsWith("listDir"))).toEqual([]);
  });

  it("refuses a credential folder", async () => {
    const result = await resolveResources(
      [{ kind: "folder", source: "explorer", name: ".ssh", uri: `${WS}/.ssh` }],
      fakeHost(),
      both,
    );
    expect(result.refusals).toEqual([{ name: ".ssh", reason: "secret" }]);
  });

  it("refuses files outside the workspace, and dot-dot tricks", async () => {
    const host = fakeHost();
    const result = await resolveResources(
      [
        {
          kind: "file",
          source: "explorer",
          name: "x.ts",
          uri: "file:///tmp/x.ts",
        },
        {
          kind: "file",
          source: "explorer",
          name: "y.ts",
          uri: `${WS}/../other/y.ts`,
        },
      ],
      host,
      both,
    );
    expect(result.refusals).toEqual([
      { name: "x.ts", reason: "outside-workspace" },
      { name: "y.ts", reason: "outside-workspace" },
    ]);
    expect(host.calls).toEqual(["getWorkspaceDirs"]);
  });

  it("refuses a file the host does not list", async () => {
    const result = await resolveResources(
      [
        {
          kind: "file",
          source: "explorer",
          name: "gone.ts",
          uri: `${WS}/src/gone.ts`,
        },
      ],
      fakeHost(),
      both,
    );
    expect(result.refusals).toEqual([{ name: "gone.ts", reason: "not-found" }]);
  });

  it("follows symlink flags to the underlying type", async () => {
    const result = await resolveResources(
      [
        {
          kind: "file",
          source: "explorer",
          name: "link.ts",
          uri: `${WS}/link.ts`,
        },
      ],
      fakeHost(),
      both,
    );
    expect(result.mentions[0]?.kind).toBe("file");
  });

  it("refuses folders when the folder provider is not configured", async () => {
    const result = await resolveResources(
      [{ kind: "folder", source: "explorer", name: "docs", uri: `${WS}/docs` }],
      fakeHost(),
      { file: true, folder: false },
    );
    expect(result.refusals).toEqual([
      { name: "docs", reason: "no-folder-provider" },
    ]);
  });

  it("lists each parent directory once", async () => {
    const host = fakeHost();
    await resolveResources(
      classifyDrop(explorerDrag([`${WS}/src/a.ts`, `${WS}/src/b.ts`])),
      host,
      both,
    );
    expect(host.calls).toEqual(["getWorkspaceDirs", `listDir ${WS}/src`]);
  });

  it("does nothing without resources", async () => {
    const host = fakeHost();
    const result = await resolveResources([], host, both);
    expect(result).toEqual({ mentions: [], refusals: [] });
    expect(host.calls).toEqual([]);
  });
});

describe("isCredentialPath", () => {
  it("does not flag ordinary files", () => {
    expect(isCredentialPath(`${WS}/src/env.ts`, "src/env.ts")).toBe(false);
    expect(isCredentialPath(`${WS}/id_rsa.pub`, "id_rsa.pub")).toBe(false);
  });
  it("decodes percent-encoding before matching", () => {
    expect(isCredentialPath(`${WS}/%2Eenv`, null)).toBe(true);
  });
});

describe("checkImages", () => {
  const png = (name: string, size = 1000) => fakeFile(name, "image/png", size);
  const imageItems = (...files: FileLike[]) =>
    classifyDrop(osFileDrag(...files));

  it("refuses every image when the model has no vision", () => {
    const r = checkImages(imageItems(png("a.png")), {
      visionSupported: false,
      imagesAlreadyInMessage: 0,
    });
    expect(r.accepted).toEqual([]);
    expect(r.refusals).toEqual([{ name: "a.png", reason: "no-vision" }]);
  });

  it("applies the size cap and the per-message count", () => {
    const files = [
      png("big.png", MAX_IMAGE_BYTES + 1),
      png("1.png"),
      png("2.png"),
      png("3.png"),
    ];
    const r = checkImages(imageItems(...files), {
      visionSupported: true,
      imagesAlreadyInMessage: 8,
    });
    expect(r.accepted.map((f) => f.name)).toEqual(["1.png", "2.png"]);
    expect(r.refusals).toEqual([
      { name: "big.png", reason: "image-too-large" },
      { name: "3.png", reason: "too-many-images" },
    ]);
  });
});

describe("sanitizeDroppedText", () => {
  it("removes bidi, zero-width space and tag characters", () => {
    const r = sanitizeDroppedText("a‮b​c\u{E0041}d");
    expect(r).toEqual({ text: "abcd", removed: 3 });
  });
  it("keeps joiners in emoji and Persian text", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const persian = "می‌خواهم";
    expect(sanitizeDroppedText(family)).toEqual({ text: family, removed: 0 });
    expect(sanitizeDroppedText(persian)).toEqual({ text: persian, removed: 0 });
  });
  it("keeps tabs and newlines", () => {
    expect(sanitizeDroppedText("a\tb\r\nc").text).toBe("a\tb\r\nc");
  });
});

describe("describeDropOutcome", () => {
  const empty = {
    files: 0,
    folders: [],
    images: 0,
    text: false,
    links: 0,
    hiddenRemoved: 0,
    refusals: [],
  };
  it("names what was added and why something was not", () => {
    const outcome = {
      ...empty,
      files: 2,
      folders: ["src"],
      refusals: [
        { name: ".env", reason: "secret" as const },
        { name: "x.ts", reason: "outside-workspace" as const },
      ],
    };
    expect(describeDropOutcome(outcome)).toBe(
      "Added 2 files, folder src as a search scope. Not added: .env looks like it holds secrets or keys; x.ts is outside the workspace.",
    );
    expect(outcomeNeedsNote(outcome)).toBe(true);
  });
  it("is short for a plain success", () => {
    const outcome = { ...empty, files: 1 };
    expect(describeDropOutcome(outcome)).toBe("Added 1 file.");
    expect(outcomeNeedsNote(outcome)).toBe(false);
  });
  it("says when the model cannot read images", () => {
    expect(
      describeDropOutcome({
        ...empty,
        refusals: [{ name: "a.png", reason: "no-vision" }],
      }),
    ).toBe("Not added: a.png: the selected model does not read images.");
  });
});
