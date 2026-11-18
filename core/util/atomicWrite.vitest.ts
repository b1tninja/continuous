import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomicSync } from "./atomicWrite";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

describe("writeFileAtomicSync", () => {
  it("creates a new file and leaves no temp file behind", () => {
    const file = path.join(dir, "new.txt");
    writeFileAtomicSync(file, "hello");
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(fs.readdirSync(dir)).toEqual(["new.txt"]);
  });

  it("replaces an existing file", () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "old");
    writeFileAtomicSync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["a.txt"]);
  });

  it("writes the bytes as given: CRLF line endings and a BOM survive", () => {
    const file = path.join(dir, "crlf.txt");
    const text = "﻿one\r\ntwo\r\n";
    writeFileAtomicSync(file, text);
    expect(fs.readFileSync(file).equals(Buffer.from(text, "utf8"))).toBe(true);
  });

  it("leaves the original intact when the write fails part way", () => {
    const file = path.join(dir, "keep.txt");
    fs.writeFileSync(file, "original");
    // The disk fills after the temp file was opened and before the rename.
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw errno("ENOSPC");
    });
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data) => {
      if (typeof target === "number") {
        realWrite(target, String(data).slice(0, 3));
        throw errno("ENOSPC");
      }
      realWrite(target, data as string);
    });

    expect(() => writeFileAtomicSync(file, "replacement text")).toThrow(
      "ENOSPC",
    );
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("leaves the original intact when the rename fails for another reason", () => {
    const file = path.join(dir, "keep.txt");
    fs.writeFileSync(file, "original");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("EXDEV");
    });
    expect(() => writeFileAtomicSync(file, "replacement")).toThrow("EXDEV");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("retries a rename that Windows refuses for a moment", () => {
    const file = path.join(dir, "busy.txt");
    fs.writeFileSync(file, "original");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      calls++;
      if (calls < 3) throw errno("EPERM");
      realRename(from, to);
    });
    writeFileAtomicSync(file, "replacement", { fallbackInPlace: false });
    expect(calls).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    expect(fs.readdirSync(dir)).toEqual(["busy.txt"]);
  });

  it("writes in place when the rename stays refused, unless told not to", () => {
    const file = path.join(dir, "locked.txt");
    fs.writeFileSync(file, "original");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw errno("EBUSY");
    });

    expect(() =>
      writeFileAtomicSync(file, "replacement", { fallbackInPlace: false }),
    ).toThrow("EBUSY");
    expect(fs.readFileSync(file, "utf8")).toBe("original");

    writeFileAtomicSync(file, "replacement");
    expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    expect(fs.readdirSync(dir)).toEqual(["locked.txt"]);
  });

  it("writes in place when the temp name would be too long", () => {
    const file = path.join(dir, "long-name.txt");
    fs.writeFileSync(file, "original");
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (String(target).endsWith(".tmp")) throw errno("ENAMETOOLONG");
      return realOpen(target, flags, mode);
    });
    writeFileAtomicSync(file, "replacement");
    expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    expect(fs.readdirSync(dir)).toEqual(["long-name.txt"]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the permission bits of the file it replaces",
    () => {
      const file = path.join(dir, "script.sh");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o750);
      writeFileAtomicSync(file, "#!/bin/sh\necho hi\n");
      expect(fs.statSync(file).mode & 0o777).toBe(0o750);
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses the mode it is given for a new file",
    () => {
      const file = path.join(dir, "private.json");
      writeFileAtomicSync(file, "{}", { mode: 0o600 });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses a read-only file as an in-place write would", () => {
    const file = path.join(dir, "readonly.txt");
    fs.writeFileSync(file, "original");
    fs.chmodSync(file, 0o444);
    try {
      // Root may write anything; the rule under test is for everyone else.
      const isRoot = process.getuid?.() === 0;
      if (!isRoot) {
        expect(() => writeFileAtomicSync(file, "replacement")).toThrow();
        expect(fs.readFileSync(file, "utf8")).toBe("original");
      }
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it("writes through a symbolic link and keeps the link", () => {
    const real = path.join(dir, "real.txt");
    const link = path.join(dir, "link.txt");
    fs.writeFileSync(real, "original");
    try {
      fs.symlinkSync(real, link);
    } catch {
      return; // Windows without the privilege to create links
    }
    writeFileAtomicSync(link, "replacement");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("replacement");
  });
});
