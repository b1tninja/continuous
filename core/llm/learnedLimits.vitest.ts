import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstAttempt,
  learnedFactsFor,
  learnedKey,
  onLearned,
  rememberLearned,
  resetLearned,
  usableLearnedFacts,
} from "./learnedLimits";

beforeEach(resetLearned);

describe("learnedKey", () => {
  it("ignores a trailing slash and tells endpoints and models apart", () => {
    expect(learnedKey("openai", "http://h/v1/", "m")).toBe(
      learnedKey("openai", "http://h/v1", "m"),
    );
    expect(learnedKey("openai", "http://a/v1", "m")).not.toBe(
      learnedKey("openai", "http://b/v1", "m"),
    );
    expect(learnedKey("openai", "http://a/v1", "m1")).not.toBe(
      learnedKey("openai", "http://a/v1", "m2"),
    );
  });
  it("accepts a missing address and provider", () => {
    expect(learnedKey(undefined, undefined, "m")).toBe("\n\nm");
  });
});

describe("usableLearnedFacts", () => {
  it("uses a running or maximum window", () => {
    expect(usableLearnedFacts({ contextLength: 8192, kind: "loaded" })).toEqual(
      { contextLength: 8192 },
    );
    expect(usableLearnedFacts({ contextLength: 1000, kind: "max" })).toEqual({
      contextLength: 1000,
    });
  });
  it("does not let the trained window set one", () => {
    expect(
      usableLearnedFacts({ contextLength: 262144, kind: "trained" }),
    ).toBeUndefined();
  });
  it("keeps an output cap even when the window is only trained", () => {
    expect(
      usableLearnedFacts({
        contextLength: 262144,
        kind: "trained",
        maxOutputTokens: 4096,
      }),
    ).toEqual({ maxOutputTokens: 4096 });
  });
  it("is undefined for nothing", () => {
    expect(usableLearnedFacts(undefined)).toBeUndefined();
    expect(usableLearnedFacts({})).toBeUndefined();
  });
});

describe("remembering", () => {
  it("returns what was remembered for a key, and nothing for another", () => {
    const k = learnedKey("p", "http://h", "m");
    expect(learnedFactsFor(k)).toBeUndefined();
    rememberLearned(k, { contextLength: 5 });
    expect(learnedFactsFor(k)).toEqual({ contextLength: 5 });
    expect(learnedFactsFor(learnedKey("p", "http://h", "x"))).toBeUndefined();
  });
  it("lets a server be asked once", () => {
    expect(firstAttempt("a")).toBe(true);
    expect(firstAttempt("a")).toBe(false);
    expect(firstAttempt("b")).toBe(true);
  });
});

describe("onLearned", () => {
  it("hears a new window and a changed one, not the same one again", () => {
    const heard = vi.fn();
    const stop = onLearned(heard);
    rememberLearned("k", { contextLength: 4096 });
    rememberLearned("k", { contextLength: 4096 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith("k", { contextLength: 4096 });

    rememberLearned("k", { contextLength: 8192 });
    rememberLearned("other", { contextLength: 4096 });
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops hearing once unsubscribed, and a listener that throws stops nothing", () => {
    const heard = vi.fn();
    const stopBad = onLearned(() => {
      throw new Error("listener failed");
    });
    const stop = onLearned(heard);
    rememberLearned("k", { contextLength: 4096 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(learnedFactsFor("k")).toEqual({ contextLength: 4096 });
    stop();
    stopBad();
    rememberLearned("k", { contextLength: 8192 });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
