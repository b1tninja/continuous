import { spawnSync } from "node:child_process";
import iconv from "iconv-lite";

/**
 * Turning what a command printed into text.
 *
 * Windows PowerShell writes piped output in the console's code page, which is
 * the system's OEM code page unless something changed it: 437 on a US machine
 * (`Write-Output 'café'` arrives as `63 61 66 82`), 850 in much of Europe, 936
 * in China. The editor's decoder used to try UTF-8 and, on any invalid byte,
 * GBK, so everyone outside code page 936 got CJK mojibake for an accented
 * letter. Now the fallback is the machine's own OEM code page, read once from
 * the registry, and GBK only when that cannot be read (the old behaviour).
 * Output that is valid UTF-8 (most native programs, and every other platform)
 * is decoded as UTF-8 exactly as before.
 */

/** The iconv-lite name for a Windows code page, or undefined for one it lacks. */
export function encodingForCodePage(codePage: number): string | undefined {
  switch (codePage) {
    case 65001:
      return "utf8";
    case 936:
      return "gbk";
    case 932:
      return "shift_jis";
    case 950:
      return "big5";
    default: {
      const name = `cp${codePage}`;
      return iconv.encodingExists(name) ? name : undefined;
    }
  }
}

/** `OEMCP    REG_SZ    437` from `reg query`, as a number. */
export function parseOemCodePage(regOutput: string): number | undefined {
  const m = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(regOutput);
  return m ? Number(m[1]) : undefined;
}

let cachedOemEncoding: string | null | undefined;

/**
 * The encoding of the OEM code page on this Windows machine, read once (a
 * `reg query` that takes a few tens of milliseconds, and only when some output
 * was not valid UTF-8). Null when it cannot be read.
 */
function oemEncoding(): string | null {
  if (cachedOemEncoding !== undefined) return cachedOemEncoding;
  cachedOemEncoding = null;
  try {
    const result = spawnSync(
      "reg",
      [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
        "/v",
        "OEMCP",
      ],
      {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const codePage = parseOemCodePage(result.stdout ?? "");
    cachedOemEncoding =
      (codePage && encodingForCodePage(codePage)) || cachedOemEncoding;
  } catch {
    // The old fallback below
  }
  return cachedOemEncoding;
}

/**
 * One chunk of a command's output as text. `fallback` is the encoding for
 * output that is not valid UTF-8 (for tests; null for "not known"); by default
 * the OEM code page on Windows, else GBK as before. Elsewhere the bytes are
 * UTF-8.
 */
export function decodeCommandOutput(
  data: Buffer,
  opts: { platform?: NodeJS.Platform; fallback?: string | null } = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return data.toString();
  const utf8 = iconv.decode(data, "utf-8");
  // U+FFFD, the replacement character: a byte that is not UTF-8
  if (!utf8.includes(String.fromCharCode(0xfffd))) return utf8;
  // null: the code page is not known
  const fallback = "fallback" in opts ? opts.fallback : oemEncoding();
  try {
    return iconv.decode(data, fallback ?? "gbk");
  } catch {
    return iconv.decode(data, "gbk");
  }
}

/** For tests: forget the OEM code page read earlier. */
export function resetCommandOutputCache(): void {
  cachedOemEncoding = undefined;
}
