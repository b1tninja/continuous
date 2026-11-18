// Deterministic checkers for the env-shell-tasks suite. Pure functions over
// strings and buffers; the file reads live in tasks.mjs. Every checker
// returns { pass, reasons[], encoding } so a failed file says whether the
// text was wrong or the bytes were (BOM, UTF-16, CRLF).
import os from "node:os";
import path from "node:path";
import { encodingProblem } from "./classify.mjs";

/**
 * Exact text, tolerant of CRLF unless `allowCrlf: false` (a
 * shell's own echo adds one). `allowCrlf` is for tasks that do not care.
 */
export function checkText(buf, expected, { allowCrlf = true } = {}) {
  const reasons = [];
  if (buf == null)
    return { pass: false, reasons: ["file missing"], encoding: null };
  const encoding = encodingProblem(buf);
  if (encoding === "utf16")
    reasons.push("file is UTF-16 (a > redirect in Windows PowerShell 5.1)");
  else if (encoding === "bom")
    reasons.push("file starts with a UTF-8 byte order mark");
  else if (encoding === "crlf" && !allowCrlf)
    reasons.push("file has CRLF line endings");
  if (encoding === "utf16") return { pass: false, reasons, encoding };
  let text = Buffer.from(buf).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (text !== expected)
    reasons.push(
      `content ${JSON.stringify(text.slice(0, 80))} is not ${JSON.stringify(expected.slice(0, 80))}`,
    );
  return { pass: reasons.length === 0, reasons, encoding };
}

/** A JSON file: parse (no BOM tolerated, as most parsers refuse one) and deep-compare. */
export function checkJson(buf, expected) {
  if (buf == null)
    return { pass: false, reasons: ["file missing"], encoding: null };
  const encoding = encodingProblem(buf);
  const reasons = [];
  if (encoding === "utf16")
    return { pass: false, reasons: ["file is UTF-16"], encoding };
  if (encoding === "bom")
    reasons.push(
      "file starts with a UTF-8 byte order mark (JSON.parse refuses it)",
    );
  let value;
  try {
    value = JSON.parse(
      Buffer.from(buf)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    );
  } catch (e) {
    reasons.push(`not valid JSON: ${String(e.message).slice(0, 80)}`);
    return { pass: false, reasons, encoding };
  }
  if (!deepEqual(value, expected))
    reasons.push(`JSON differs: ${JSON.stringify(value).slice(0, 120)}`);
  return { pass: reasons.length === 0, reasons, encoding };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== "object"
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** Lines of a text file, line endings and a BOM stripped, blanks dropped. */
export function lines(buf) {
  if (buf == null) return null;
  return Buffer.from(buf)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A relative path as forward slashes, no leading ./ */
export function normRel(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The host-native path for a path a model wrote down, whichever form it used:
 * `C:\x`, `C:/x`, Git Bash `/c/x`, WSL `/mnt/c/x`. Other paths come back as
 * they are. Used to check "write the absolute path" tasks on any host.
 */
export function toNativePath(
  p,
  platform = process.platform,
  tmp = os.tmpdir(),
) {
  const s = p.trim().replace(/^["']|["']$/g, "");
  // Git Bash maps /tmp to the Windows temp folder
  if (platform === "win32" && /^\/tmp(\/|$)/.test(s))
    return path.join(tmp, s.slice(5));
  if (platform !== "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : s;
  }
  let m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(s) ?? /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/[\\/]+/g, "\\")}`;
  return s;
}

/** Same path on a case-insensitive Windows file system, ignoring separators. */
export function samePath(a, b, platform = process.platform) {
  const n = (x) => {
    const t = x.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return platform === "win32" ? t.toLowerCase() : t;
  };
  return n(a) === n(b);
}
