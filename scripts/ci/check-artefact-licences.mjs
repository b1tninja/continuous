#!/usr/bin/env node
// Fail when a built artefact lacks the legal files the licences require.
//   node scripts/ci/check-artefact-licences.mjs --vsix <file.vsix>
//   node scripts/ci/check-artefact-licences.mjs --tgz <file.tgz>
// Reads only the archive's file list (no network, nothing extracted). A VSIX is a zip with
// everything under `extension/`; the CLI tarball has everything under `package/`.
// Required in both: LICENSE (LICENSE.txt in the VSIX), NOTICE, and the generated
// THIRD_PARTY_NOTICES.txt (scripts/licenses/third-party-notices.mjs).
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const REQUIRED = {
  vsix: [
    ["extension/LICENSE.txt", "extension/LICENSE"],
    ["extension/NOTICE"],
    ["extension/THIRD_PARTY_NOTICES.txt"],
  ],
  tgz: [
    ["package/LICENSE"],
    ["package/NOTICE"],
    ["package/THIRD_PARTY_NOTICES.txt"],
  ],
};

/** Each entry is a list of acceptable names; returns the entries with none present. */
export function missing(files, required) {
  const set = new Set(files.map((f) => f.replaceAll("\\", "/")));
  return required.filter((alts) => !alts.some((a) => set.has(a)));
}

/** File names from a zip's central directory. */
export function zipNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const PAX_PATH = /(?:^|\n)\d+ path=([^\n]*)\n/;

/** File names from a gzipped tar (read in-process: GNU tar mistakes "D:" for a host). */
export function tarNames(buf) {
  const data = gunzipSync(buf);
  const names = [];
  let paxPath = null;
  for (let p = 0; p + 512 <= data.length;) {
    if (data[p] === 0) break;
    const field = (from, len) => {
      const raw = data.subarray(p + from, p + from + len);
      const end = raw.indexOf(0);
      return raw.toString("utf8", 0, end < 0 ? raw.length : end);
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (type === "x") {
      const body = data.toString("utf8", p + 512, p + 512 + size);
      paxPath = PAX_PATH.exec(body)?.[1] ?? null;
    } else if (type !== "g") {
      const prefix = field(345, 155);
      const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
      names.push(paxPath ?? name);
      paxPath = null;
    }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

if (process.argv[1]?.endsWith("check-artefact-licences.mjs")) {
  const [kind, file] = process.argv.slice(2);
  if (!["--vsix", "--tgz"].includes(kind) || !file) {
    console.error(
      "usage: check-artefact-licences.mjs --vsix <file> | --tgz <file>",
    );
    process.exit(2);
  }
  const type = kind.slice(2);
  const buf = readFileSync(file);
  const files = type === "vsix" ? zipNames(buf) : tarNames(buf);
  const absent = missing(files, REQUIRED[type]);
  if (absent.length) {
    console.error(
      `${file} lacks: ${absent.map((a) => a.join(" or ")).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`${file}: LICENSE, NOTICE and THIRD_PARTY_NOTICES present`);
}
