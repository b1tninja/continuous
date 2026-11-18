import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  holdUserNotices,
  resetUserNotices,
  setUserNoticeSink,
  userNotice,
} from "./userNotice.js";

describe("userNotice", () => {
  let err: ReturnType<typeof vi.spyOn>;
  let out: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetUserNotices();
    err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    err.mockRestore();
    out.mockRestore();
    resetUserNotices();
  });

  it("writes one line to stderr and nothing to stdout", () => {
    userNotice("Something the person must see.");
    expect(err).toHaveBeenCalledWith("Something the person must see.\n");
    expect(out).not.toHaveBeenCalled();
  });

  it("shows a key once, however often it is raised", () => {
    userNotice("Not saved: disk full", "save:abc");
    userNotice("Not saved: disk full (again)", "save:abc");
    userNotice("Not saved: disk full", "save:other");
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("goes to the UI's sink when one is set", () => {
    const seen: string[] = [];
    setUserNoticeSink((text) => seen.push(text));
    userNotice("In the chat");
    expect(seen).toEqual(["In the chat"]);
    expect(err).not.toHaveBeenCalled();
  });

  it("holds notices raised while the UI starts, then hands them to the sink", () => {
    holdUserNotices();
    userNotice("Raised during start-up");
    expect(err).not.toHaveBeenCalled();
    const seen: string[] = [];
    setUserNoticeSink((text) => seen.push(text));
    expect(seen).toEqual(["Raised during start-up"]);
  });

  it("sends held notices to stderr when the UI goes away without taking them", () => {
    holdUserNotices();
    userNotice("Never shown in a chat");
    setUserNoticeSink(undefined);
    expect(err).toHaveBeenCalledWith("Never shown in a chat\n");
    userNotice("After the UI");
    expect(err).toHaveBeenCalledWith("After the UI\n");
  });
});
