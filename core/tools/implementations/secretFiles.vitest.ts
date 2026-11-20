import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IDE, ToolExtras } from "../..";
import { createNewFileImpl } from "./createNewFile";
import { readFileImpl } from "./readFile";

/**
 * The tools refuse a file that looks like a secret (a .env file, a key). That
 * refusal is the protect-secrets check: it lifts when the check is off, which
 * the host says with `allowSecretFiles`.
 */
let root: string;
let work: string;
let ide: IDE;

beforeAll(() => {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "secret-files-")),
  );
  work = path.join(root, "workspace");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, ".env"), "TOKEN=abc\n");
  fs.writeFileSync(path.join(work, "notes.txt"), "plain\n");
  const local = (u: string) =>
    path.normalize(
      decodeURIComponent(new URL(u).pathname).replace(/^\/([a-zA-Z]:)/, "$1"),
    );
  ide = {
    getWorkspaceDirs: async () => [pathToFileURL(work).href],
    fileExists: async (u: string) => fs.existsSync(local(u)),
    readFile: async (u: string) => fs.readFileSync(local(u), "utf8"),
    writeFile: async (u: string, c: string) => {
      fs.mkdirSync(path.dirname(local(u)), { recursive: true });
      fs.writeFileSync(local(u), c);
    },
    openFile: async () => {},
    saveFile: async () => {},
    getCurrentFile: async () => undefined,
    waitForProblems: async () => [],
  } as unknown as IDE;
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const extras = (over: Partial<ToolExtras> = {}) =>
  ({
    ide,
    workspaceDirs: [pathToFileURL(work).href],
    config: { selectedModelByRole: { chat: undefined } },
    ...over,
  }) as unknown as ToolExtras;

describe("reading a secret-looking file", () => {
  it("is refused while protect-secrets is on", async () => {
    await expect(readFileImpl({ filepath: ".env" }, extras())).rejects.toThrow(
      /security concern/,
    );
  });

  it("is allowed once the check is off", async () => {
    const out = await readFileImpl(
      { filepath: ".env" },
      extras({ allowSecretFiles: true }),
    );
    expect(out[0].content).toContain("TOKEN=abc");
  });

  it("an ordinary file reads either way", async () => {
    for (const allow of [false, true]) {
      const out = await readFileImpl(
        { filepath: "notes.txt" },
        extras({ allowSecretFiles: allow }),
      );
      expect(out[0].content).toBe("plain\n");
    }
  });
});

describe("writing a secret-looking file", () => {
  it("is refused while protect-secrets is on, new file or existing", async () => {
    await expect(
      createNewFileImpl({ filepath: "keys/id_rsa", contents: "x" }, extras()),
    ).rejects.toThrow(/security concern/);
    await expect(
      createNewFileImpl(
        { filepath: ".env", contents: "OTHER=1", append: true },
        extras(),
      ),
    ).rejects.toThrow(/security concern/);
  });

  it("a new secret-looking file is allowed once the check is off", async () => {
    await createNewFileImpl(
      { filepath: "keys/id_rsa", contents: "x" },
      extras({ allowSecretFiles: true }),
    );
    expect(fs.existsSync(path.join(work, "keys", "id_rsa"))).toBe(true);
  });

  it("appending to it is allowed once the check is off", async () => {
    await createNewFileImpl(
      { filepath: ".env", contents: "OTHER=1\n", append: true },
      extras({ allowSecretFiles: true }),
    );
    expect(fs.readFileSync(path.join(work, ".env"), "utf8")).toContain(
      "OTHER=1",
    );
  });
});
