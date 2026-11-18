import { describe, expect, it } from "vitest";

import {
  StdioOutputBuffer,
  STDIO_OUTPUT_HEAD_MAX,
  STDIO_OUTPUT_TAIL_MAX,
} from "./stdioOutput";

// Assembled at run time so this file holds no literal that looks like a key.
const AWS_KEY = ["AKIA", "QXZN2M4K", "KPQR5TWV"].join("");
const GITHUB_TOKEN = `ghp_${"x9Kq2LmZ4vB7nRt1WcYd8HsE3JfA6gUo5PiX"}`;
const ENV_SECRET = "hunter2-but-longer-9Zq";

describe("StdioOutputBuffer", () => {
  it("is empty until something is appended", () => {
    const b = new StdioOutputBuffer();
    expect(b.isEmpty).toBe(true);
    b.append("x");
    expect(b.isEmpty).toBe(false);
  });

  it("returns short output unchanged", () => {
    const b = new StdioOutputBuffer();
    b.append("starting\n");
    b.append("boom\n");
    expect(b.render()).toBe("starting\nboom\n");
  });

  it("keeps the head and the tail and bounds what it holds", () => {
    const b = new StdioOutputBuffer();
    b.append("FIRST LINE\n");
    for (let i = 0; i < 20_000; i++) b.append(`noise line ${i}\n`);
    b.append("LAST LINE\n");
    const out = b.render();
    expect(out.startsWith("FIRST LINE\n")).toBe(true);
    expect(out.endsWith("LAST LINE\n")).toBe(true);
    expect(out).toContain("characters omitted");
    expect(out.length).toBeLessThan(
      STDIO_OUTPUT_HEAD_MAX + STDIO_OUTPUT_TAIL_MAX + 100,
    );
  });

  it("masks provider keys", () => {
    const b = new StdioOutputBuffer();
    b.append(`auth failed for key ${AWS_KEY}\ntoken ${GITHUB_TOKEN}\n`);
    const out = b.render();
    expect(out).not.toContain(AWS_KEY);
    expect(out).not.toContain(GITHUB_TOKEN);
    expect(out).toContain("[REDACTED:");
  });

  it("masks a secret split across chunks", () => {
    const b = new StdioOutputBuffer();
    b.append(`key ${AWS_KEY.slice(0, 7)}`);
    b.append(`${AWS_KEY.slice(7)} rejected\n`);
    expect(b.render()).not.toContain(AWS_KEY);
  });

  it("masks the value of a secret environment variable even without a known shape", () => {
    const b = new StdioOutputBuffer();
    b.append(`connecting with ${ENV_SECRET}\n`);
    expect(b.render({ MY_SERVICE_API_KEY: ENV_SECRET })).not.toContain(
      ENV_SECRET,
    );
  });

  it("masks secrets in the head and in the tail of truncated output", () => {
    const b = new StdioOutputBuffer();
    b.append(`head ${AWS_KEY} head\n`);
    b.append("x\n".repeat(20_000));
    b.append(`tail ${GITHUB_TOKEN} tail\n`);
    const out = b.render();
    expect(out).toContain("characters omitted");
    expect(out).not.toContain(AWS_KEY);
    expect(out).not.toContain(GITHUB_TOKEN);
  });

  it("leaves no fragment of a secret that the cap cut in half", () => {
    const b = new StdioOutputBuffer();
    // Put the secret across the head limit.
    const pad = "p".repeat(STDIO_OUTPUT_HEAD_MAX - 10 - 1);
    b.append(`${pad} ${GITHUB_TOKEN}\n`);
    b.append("x\n".repeat(20_000));
    const out = b.render();
    expect(out).not.toContain(GITHUB_TOKEN.slice(0, 10));
  });
});
