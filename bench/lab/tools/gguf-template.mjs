#!/usr/bin/env node
// RQ28: read `tokenizer.chat_template` from a GGUF header, and hash it.
// Dev only. Reads the metadata section only (never a tensor) and writes
// nothing. A GGUF is: magic "GGUF", version u32, tensor count u64, metadata
// count u64, then the key/value pairs; the tensor infos and data follow.
//
//   node bench/lab/tools/gguf-template.mjs <model.gguf> [--out template.jinja]
//   node bench/lab/tools/gguf-template.mjs --file <template.jinja>   (hash only)
//
// Prints JSON: version, metadata key count, template length, sha256 of the
// raw text and of the normalised text (CRLF to LF, trailing whitespace of the
// whole text trimmed), and the first 100 characters.
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const normalise = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");

class Reader {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
    this.buf = Buffer.alloc(0);
    this.base = 0;
  }
  take(n) {
    if (this.pos + n > this.base + this.buf.length || this.pos < this.base) {
      const size = Math.max(n, 1 << 20);
      this.buf = Buffer.alloc(size);
      const got = readSync(this.fd, this.buf, 0, size, this.pos);
      this.buf = this.buf.subarray(0, got);
      this.base = this.pos;
      if (got < n) throw new Error("unexpected end of file in the header");
    }
    const o = this.pos - this.base;
    this.pos += n;
    return this.buf.subarray(o, o + n);
  }
  u32() {
    return this.take(4).readUInt32LE(0);
  }
  u64() {
    return Number(this.take(8).readBigUInt64LE(0));
  }
  str() {
    return this.take(this.u64()).toString("utf8");
  }
}

const SCALAR = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};
function value(r, type, wantString) {
  if (type === 8) return r.str();
  if (type === 9) {
    const et = r.u32();
    const n = r.u64();
    for (let i = 0; i < n; i++) value(r, et, false);
    return undefined;
  }
  if (!(type in SCALAR)) throw new Error(`unknown GGUF value type ${type}`);
  r.take(SCALAR[type]);
  return undefined;
}

export function readTemplate(path) {
  const fd = openSync(path, "r");
  try {
    const r = new Reader(fd);
    if (r.take(4).toString("latin1") !== "GGUF")
      throw new Error("not a GGUF file");
    const version = r.u32();
    r.u64(); // tensor count
    const kvs = r.u64();
    let template;
    const keys = [];
    for (let i = 0; i < kvs; i++) {
      const key = r.str();
      const type = r.u32();
      const v = value(r, type, key === "tokenizer.chat_template");
      keys.push(key);
      if (key === "tokenizer.chat_template" && typeof v === "string")
        template = v;
    }
    return { version, kvs, template, keys };
  } finally {
    closeSync(fd);
  }
}

if (
  import.meta.url ===
  new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href
) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  let text,
    meta = {};
  if (args[0] === "--file") text = readFileSync(args[1], "utf8");
  else {
    const t = readTemplate(args[0]);
    meta = {
      ggufVersion: t.version,
      metadataKeys: t.kvs,
      architecture: undefined,
    };
    text = t.template;
  }
  if (text === undefined) {
    console.log(JSON.stringify({ ...meta, template: null }));
  } else {
    if (out) writeFileSync(out, text);
    console.log(
      JSON.stringify({
        ...meta,
        length: text.length,
        sha256Raw: sha(text),
        sha256Normalised: sha(normalise(text)),
        head: text.slice(0, 100),
      }),
    );
  }
}
