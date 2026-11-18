import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getCommandExecutor } from "./commandExecutor";
import {
  decodeCommandOutput,
  encodingForCodePage,
  parseOemCodePage,
  resetCommandOutputCache,
} from "./commandOutput";
import { COMMAND_STDIO } from "./commandSpawn";

afterEach(() => resetCommandOutputCache());

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ""), "hex");

describe("decodeCommandOutput", () => {
  it("decodes UTF-8 as UTF-8 everywhere", () => {
    const bytes = Buffer.from("café ✓ 中文\n", "utf8");
    expect(decodeCommandOutput(bytes, { platform: "win32" })).toBe(
      "café ✓ 中文\n",
    );
    expect(decodeCommandOutput(bytes, { platform: "linux" })).toBe(
      "café ✓ 中文\n",
    );
  });

  it("code page 437: what Windows PowerShell wrote for 'café ✓' on a US machine", () => {
    // Measured: 5.1 piping `Write-Output 'café ✓'` (✓ already became √)
    const bytes = hex("63 61 66 82 20 fb 0d 0a");
    expect(
      decodeCommandOutput(bytes, { platform: "win32", fallback: "cp437" }),
    ).toBe("café √\r\n");
  });

  it("code page 936 still decodes as GBK", () => {
    const bytes = hex("d6 d0 ce c4"); // 中文 in GBK
    expect(
      decodeCommandOutput(bytes, {
        platform: "win32",
        fallback: encodingForCodePage(936),
      }),
    ).toBe("中文");
  });

  it("falls back to GBK, as before, when the code page is not known", () => {
    expect(
      decodeCommandOutput(hex("d6 d0 ce c4"), {
        platform: "win32",
        fallback: null,
      }),
    ).toBe("中文");
  });

  it("names code pages and reads reg's answer", () => {
    expect(encodingForCodePage(437)).toBe("cp437");
    expect(encodingForCodePage(850)).toBe("cp850");
    expect(encodingForCodePage(65001)).toBe("utf8");
    expect(encodingForCodePage(932)).toBe("shift_jis");
    expect(encodingForCodePage(12345)).toBeUndefined();
    expect(
      parseOemCodePage(
        "\r\nHKEY_LOCAL_MACHINE\\...\\CodePage\r\n    OEMCP    REG_SZ    437\r\n",
      ),
    ).toBe(437);
    expect(parseOemCodePage("ERROR: not found")).toBeUndefined();
  });

  // A real Windows PowerShell and this machine's code page
  it.runIf(process.platform === "win32")(
    "decodes what Windows PowerShell prints for an accented letter",
    async () => {
      const executor = getCommandExecutor({ terminalShell: "default" });
      const { shell, args } = executor.invocation(
        'Write-Output "caf$([char]0xE9)"',
      );
      const bytes: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(shell, args, {
          stdio: COMMAND_STDIO,
          windowsHide: true,
        });
        child.stdout?.on("data", (d: Buffer) => bytes.push(d));
        child.on("error", reject);
        child.on("close", () => resolve());
      });
      // With a code page whose é is one byte (437, 850, 1252 and most others)
      expect(decodeCommandOutput(Buffer.concat(bytes)).trim()).toBe("café");
    },
    30_000,
  );
});
